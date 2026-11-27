import { setTimeout as delay } from 'node:timers/promises';
import {
  BubaiClient,
  type BotGatewayAgentDescriptor,
  type BotGatewayHandle,
  type BotTurnRequestedEvent,
} from '@buzz-botmux/chat-client';
import { progressSnapshotEquals, type AgentProgressSnapshot } from '@buzz-botmux/botmux-client';
import { openTurnJournal, type PendingTurn } from './bridge-turn-journal';
import type { GatewayOptions, LocalRuntimeProvider } from './bridge-provider';

function isBotCredential(token?: string): boolean {
  return Boolean(token && (token.startsWith('bot_') || token.startsWith('bot-server_')));
}

export function isRetryable(status?: number): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

export async function startRuntimeBridge(
  options: GatewayOptions,
  provider: LocalRuntimeProvider,
  journal: ReturnType<typeof openTurnJournal>,
) {
  const agents = await provider.discoverAgents();
  if (!agents.length) throw new Error('No local agents configured');
  const activeTurns = new Set<string>();
  const controller = new AbortController();
  const { signal } = controller;
  const wait = (ms: number) => delay(ms, undefined, { signal });
  const requestSignal = (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  const explicitBotToken = options.botToken || (isBotCredential(options.token) ? options.token : undefined);
  const humanToken = !isBotCredential(options.token) ? options.token : undefined;

  const provisionedEntries: Array<{
    descriptor: BotGatewayAgentDescriptor;
    gatewayToken?: string;
  }> = [];

  const provisionSdk = new BubaiClient({ baseUrl: options.serverUrl, token: humanToken });
  for (const agent of agents) {
    const descriptor = { ...agent, externalId: agent.id };
    if (explicitBotToken) {
      provisionedEntries.push({ descriptor, gatewayToken: explicitBotToken });
      continue;
    }
    const channel = options.channelRef;
    const isUuid = channel && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(channel);
    const provisioned = await provisionSdk.provisionAgent({
      agentId: agent.id,
      adapterType: 'gateway',
      externalId: agent.id,
      name: agent.name,
      cliId: agent.cliId,
      workingDir: agent.workingDir || undefined,
      capabilities: agent.capabilities,
      ...(isUuid ? { channelId: channel } : channel ? { channelName: channel } : {}),
      community: options.community,
      autoReply: options.autoReply,
      issueKey: Boolean(humanToken),
      keyScope: 'bot',
    });
    provisionedEntries.push({
      descriptor: { ...descriptor, id: provisioned.agent.id },
      gatewayToken: provisioned.apiKey || humanToken,
    });
  }

  const gateways: BotGatewayHandle[] = [];

  async function deliverTurn(turn: Extract<PendingTurn, { stage: 'deliver' }>, sdk: BubaiClient) {
    let retryMs = 250;
    for (;;) {
      signal.throwIfAborted();
      try {
        await sdk.completeBotTurn(turn.messageId, turn.completion, { signal: requestSignal(5_000) });
        break;
      } catch (error) {
        const status = (error as { status?: number }).status;
        // The server may already have removed the card or made it non-settleable.
        if (status === 404 || status === 409) break;
        if (!isRetryable(status)) throw error;
        await wait(retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      }
    }
    signal.throwIfAborted();
    journal.remove(turn.messageId);
  }

  function trackTurn(
    messageId: string,
    sdk: BubaiClient,
    load: () => { turn: PendingTurn; event?: BotTurnRequestedEvent } | undefined,
  ) {
    if (signal.aborted || activeTurns.has(messageId)) return;
    activeTurns.add(messageId);
    void (async () => {
      const loaded = load();
      if (!loaded) return;
      let { turn } = loaded;
      if (turn.stage !== 'deliver') {
        let lastProgress: AgentProgressSnapshot | undefined;
        const completion = await provider.executeTurn({
          initial: turn,
          event: loaded.event,
          async progress(snapshot) {
            if (signal.aborted || progressSnapshotEquals(lastProgress, snapshot)) return;
            try {
              await sdk.sendBotProgress(messageId, snapshot);
              lastProgress = snapshot;
            } catch {
              /* Retry on the next snapshot. */
            }
          },
        });
        signal.throwIfAborted();
        turn = { ...turn, stage: 'deliver', completion };
        journal.save(turn);
      }
      await deliverTurn(turn, sdk);
    })()
      .catch((error) => {
        if (!signal.aborted) console.error('Bridge could not settle message', messageId, error);
      })
      .finally(() => activeTurns.delete(messageId));
  }

  // Group entries by gatewayToken so a shared bot-server_ / static token uses 1 WS connection,
  // while individual per-bot `bot_` keys each get their own scoped WS connection.
  const groups = new Map<string, { token?: string; agents: BotGatewayAgentDescriptor[] }>();
  for (const entry of provisionedEntries) {
    const key = entry.gatewayToken || '__no_token__';
    const existing = groups.get(key);
    if (existing) {
      existing.agents.push(entry.descriptor);
    } else {
      groups.set(key, { token: entry.gatewayToken, agents: [entry.descriptor] });
    }
  }

  for (const group of groups.values()) {
    const groupSdk = new BubaiClient({ baseUrl: options.serverUrl, token: group.token });
    const gw = groupSdk.connectBotGateway({
      agents: group.agents,
      onStateChange: (state) => {
        if (state === 'closed' || state === 'reconnecting')
          options.onDisconnect?.(group.agents.map((agent) => agent.id));
      },
      onWelcome: (info) => {
        console.log(
          JSON.stringify({
            event: 'bridge.ready',
            connectionId: info.connectionId,
            agentIds: info.agentIds,
          }),
        );
        const welcomed = new Set(info.agentIds);
        for (const turn of journal.list().sort((a, b) => a.deadline - b.deadline)) {
          if (welcomed.has(turn.agentId)) trackTurn(turn.messageId, groupSdk, () => ({ turn }));
        }
        options.onReady?.(info);
      },
      onTurnRequested: (event) => {
        if (!group.agents.some((agent) => agent.id === event.botId)) return;
        trackTurn(event.replyTarget.messageId, groupSdk, () => {
          const saved = journal.get(event.replyTarget.messageId);
          if (saved) return saved.agentId === event.botId ? { turn: saved } : undefined;
          const turn = provider.prepareTurn(event);
          journal.save(turn);
          return { turn, event };
        });
      },
      onAskAnswered: provider.onAskAnswered,
    });
    gateways.push(gw);
  }

  return {
    agentIds: provisionedEntries.map((e) => e.descriptor.id),
    stop: () => {
      controller.abort();
      provider.stop();
      for (const gw of gateways) gw.close();
    },
  };
}
