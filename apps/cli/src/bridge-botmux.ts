import { isRetryable, startRuntimeBridge } from './bridge-core';
import type { GatewayOptions, TurnContext } from './bridge-provider';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BotmuxClient,
  isIdleLocalAntigravitySession,
  isLocalBotmuxEndpoint,
  readAntigravityTurnOutcome,
  readTurnProgress,
  type BotmuxBot,
  type BotmuxSession,
  type TriggerResponse,
} from '@buzz-botmux/botmux-client';
import {
  normalizeServerUrl,
  type BotTurnRequestedEvent,
} from '@buzz-botmux/chat-client';
import { openTurnJournal, type PendingTurn, type TurnCompletion } from './bridge-turn-journal';

export interface BotmuxBridgeOptions extends GatewayOptions {
  botmuxEndpoint: string;
  botmuxToken?: string;
  botIds?: string[];
  pollMs?: number;
  turnTimeoutMs?: number;

}

const TURN_TIMEOUT_MS = 30 * 60_000;
const RESULT_NOT_FOUND_GRACE_MS = 10_000;
const TRANSCRIPT_POLL_MS = 5_000;
const TIMED_OUT: TurnCompletion = { content: '等待 Botmux 回复超时', status: 'timeout' };

const BOTMUX_CAPABILITIES = [
  'progress_steps',
  'interactive_ask',
  'terminal_attach',
  'session_control',
];

function terminalResult(result: TriggerResponse): TurnCompletion | undefined {
  if (result.state === 'completed') {
    const content = typeof result.output?.content === 'string' ? result.output.content.trim() : '';
    return { content: content || '（任务已完成，无文本输出）', status: 'completed' };
  }
  if (result.state === 'failed' || result.state === 'interrupted') {
    return { content: result.error || `Botmux turn ${result.state}`, status: result.state };
  }
}

/**
 * Bridge local Botmux daemon into BubAI via the unified `BubaiClient` SDK:
 * - Supports strict auth (`BUBAI_AUTH_REQUIRED=true`):
 *   - If given a human session token, provisions each local Botmux bot via `/api/agents/provision`
 *     with `issueKey: true, keyScope: 'bot'`, and connects `/ws/bot` using each bot's issued `bot_` key.
 *   - If given an explicit `bot_` / `bot-server_` key (or legacy static token in dev mode), connects
 *     directly to `/ws/bot` with that credential.
 * - Resumes turn dispatch, polling, and delivery from the local journal after restart.
 */
export async function startBotmuxBridge(options: BotmuxBridgeOptions): Promise<{
  stop: () => void;
  agentIds: string[];
}> {
  const botmux = new BotmuxClient(options.botmuxEndpoint, options.botmuxToken);
  const pollMs = options.pollMs ?? 500;
  const turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const sessionBindings = new Map<string, string>();
  const controller = new AbortController();
  const { signal } = controller;

  const requestedIds = new Set(options.botIds);
  if (options.botIds && requestedIds.size === 0) {
    throw new Error('Specify at least one Botmux bot ID');
  }
  const discoveredBots: BotmuxBot[] = await botmux.getBots();
  const missingIds = [...requestedIds].filter((id) => !discoveredBots.some((bot) => bot.larkAppId === id));
  if (missingIds.length > 0) {
    throw new Error('Botmux bot IDs not found: ' + missingIds.join(', '));
  }
  const bots = requestedIds.size > 0
    ? discoveredBots.filter((bot) => requestedIds.has(bot.larkAppId))
    : discoveredBots;
  if (bots.length === 0) throw new Error('No Botmux bots found. Check that the Botmux dashboard is running.');
  const isLocalBotmux = isLocalBotmuxEndpoint(botmux.getEndpoint());
  const localAntigravityBots = new Set(isLocalBotmux
    ? bots.filter((bot) => bot.cliId === 'antigravity').map((bot) => bot.larkAppId)
    : []);
  const journal = openTurnJournal(normalizeServerUrl(options.serverUrl), botmux.getEndpoint());

  const prepareTurn = (event: BotTurnRequestedEvent): PendingTurn => {
    const externalBotId = event.externalId || event.botId;
    const bot = bots.find((entry) => entry.larkAppId === externalBotId);
    const bindingKey = `${event.channel.id}:${externalBotId}`;
    const messageId = event.replyTarget.messageId;
    const createdAt = Date.now();
    const attachmentNote = event.triggerMessage.attachments.length > 0
      ? `\n\n[附件]\n${event.triggerMessage.attachments.map((a) => `- ${a.name} (${a.mimeType}, ${a.url})`).join('\n')}`
      : '';

    return {
      stage: 'dispatch',
      messageId,
      agentId: event.botId,
      bindingKey,
      createdAt,
      deadline: createdAt + turnTimeoutMs,
      request: botmux.buildTurnTrigger({
        botId: externalBotId,
        cliId: bot?.cliId,
        sessionId: sessionBindings.get(bindingKey),
        idempotencyKey: `bubai:${messageId}`,
        prompt: `${event.triggerMessage.content}${attachmentNote}`,
        senderName: event.triggerMessage.senderName,
        systemPrompt: event.systemPrompt,
        context: {
          channel: event.channel,
          ...(event.threadId ? { threadId: event.threadId } : {}),
          outboundApi: {
            botId: event.botId,
            channelId: event.replyTarget.channelId,
            ...(event.replyTarget.threadId ? { threadId: event.replyTarget.threadId } : {}),
            placeholderMessageId: messageId,
          },
          messages: event.history,
        },
      }),
    };
  };

  const wait = (ms: number) => delay(ms, undefined, { signal });
  const requestSignal = (timeoutMs: number) => AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let canReplayDispatch = false;

  async function checkReplaySupport(botId?: string): Promise<boolean | undefined> {
    if (canReplayDispatch) return true;
    // Older Botmux versions can ignore unknown options. This dry run probes
    // both keys without dispatching a task even when they are ignored.
    const reply = await botmux.submitTrigger({
      source: { type: 'headless' },
      target: { kind: 'turn', botId },
      envelope: { format: 'text', sourceName: 'BubAI', trusted: false, rawText: 'Bridge capability check' },
      options: { asyncReturnSessionId: true, dryRun: true, idempotencyKey: 'probe', turnIdempotencyKey: 'probe' },
    }, requestSignal(10_000)).catch(() => undefined);
    signal.throwIfAborted();
    if (!reply || isRetryable(reply.httpStatus)) return;
    canReplayDispatch = reply.httpStatus === 400 && reply.result.errorCode === 'bad_request' &&
      reply.result.error === 'options.turnIdempotencyKey and options.idempotencyKey are mutually exclusive';
    return canReplayDispatch;
  }

  async function dispatchTurn(
    turn: Extract<PendingTurn, { stage: 'dispatch' }>,
    firstDispatch: boolean,
  ): Promise<Exclude<PendingTurn, { stage: 'dispatch' }>> {
    const { messageId, agentId, bindingKey, createdAt, deadline } = turn;
    const identity = { messageId, agentId, bindingKey, createdAt, deadline };
    let request = turn.request;
    let replaying = !firstDispatch;
    let retryMs = 250;

    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const replaySupported = !replaying || await checkReplaySupport(request.target.botId);
      if (replaySupported === false) {
        return {
          ...identity,
          stage: 'deliver',
          completion: { content: '无法确认 Botmux 是否已接单。当前 Botmux 版本不支持安全重试。', status: 'failed' },
        };
      }
      const reply = replaySupported && Date.now() < deadline
        ? await botmux.submitTrigger(request, requestSignal(10_000)).catch(() => undefined)
        : undefined;
      signal.throwIfAborted();
      replaying = true;
      if (reply && !isRetryable(reply.httpStatus)) {
        const { result } = reply;
        const previousSession = request.target.sessionId;
        // Only a definite rejection can switch idempotency scopes. A lost response
        // must be retried against the original session with the identical request.
        if (previousSession && !result.ok && !result.state && result.errorCode === 'session_not_found') {
          if (sessionBindings.get(bindingKey) === previousSession) sessionBindings.delete(bindingKey);
          const { sessionId: _, ...target } = request.target;
          const { turnIdempotencyKey, ...triggerOptions } = request.options ?? {};
          request = { ...request, target, options: { ...triggerOptions, idempotencyKey: turnIdempotencyKey } };
          journal.save({ ...identity, stage: 'dispatch', request });
          replaying = false;
          continue;
        }

        const completion = terminalResult(result);
        const sessionId = result.target?.sessionId || result.async?.sessionId || previousSession;
        const triggerId = result.triggerId;
        if (sessionId && triggerId && (result.ok || completion)) {
          return { ...identity, stage: 'poll', sessionId, triggerId, acceptedAt: Date.now() };
        }
        if (completion || !result.ok) {
          return {
            ...identity,
            stage: 'deliver',
            completion: completion ?? {
              content: result.error || `Botmux dispatch failed (HTTP ${reply.httpStatus})`,
              status: 'failed',
            },
          };
        }
      }

      await wait(Math.min(retryMs, Math.max(0, deadline - Date.now())));
      retryMs = Math.min(retryMs * 2, 5_000);
    }

    return { ...identity, stage: 'deliver', completion: TIMED_OUT };
  }

  let sessionsLookup: { checkedAt: number; sessions: Promise<BotmuxSession[]> } | undefined;

  async function recoverAntigravityTurn(
    turn: Extract<PendingTurn, { stage: 'poll' }>,
    channelId: string,
    runtimeBotId: string,
  ): Promise<TurnCompletion | undefined> {
    const now = Date.now();
    if (!sessionsLookup || now - sessionsLookup.checkedAt >= TRANSCRIPT_POLL_MS) {
      sessionsLookup = { checkedAt: now, sessions: botmux.getSessions() };
    }
    const session = (await sessionsLookup.sessions).find((item) => item.sessionId === turn.sessionId);
    if (!session || !isIdleLocalAntigravitySession(session, runtimeBotId)) return;
    signal.throwIfAborted();
    const outcome = await readAntigravityTurnOutcome({
      triggerId: turn.triggerId,
      channelId,
      botId: turn.agentId,
      placeholderMessageId: turn.messageId,
      createdAt: new Date(turn.createdAt ?? Math.min(turn.acceptedAt, turn.deadline - TURN_TIMEOUT_MS)),
    });
    if (outcome?.status === 'completed') return outcome;
    if (outcome?.status === 'no_reply' && !session.backgroundTaskCount && !session.busySinceAt) {
      return { content: '会话已返回空闲，本轮未生成回复', status: 'failed' };
    }
  }

  async function waitForResult(
    turn: Extract<PendingTurn, { stage: 'poll' }>,
    publish: TurnContext['progress'],
  ): Promise<TurnCompletion> {
    const { messageId, agentId, sessionId, triggerId, acceptedAt, deadline } = turn;
    const adapterMeta = { adapter: 'bubai-cli-botmux', sessionId, triggerId };
    const separator = turn.bindingKey.indexOf(':');
    const channelId = turn.bindingKey.slice(0, separator);
    const runtimeBotId = turn.bindingKey.slice(separator + 1);
    const bot = bots.find((entry) => entry.larkAppId === runtimeBotId);
    const createdAt = new Date(turn.createdAt ?? Math.min(acceptedAt, deadline - TURN_TIMEOUT_MS));
    const readsLocalTranscript = separator > 0 && localAntigravityBots.has(runtimeBotId);
    const readsLocalProgress = separator > 0 && isLocalBotmux;
    let nextTranscriptCheck = acceptedAt + RESULT_NOT_FOUND_GRACE_MS;
    const syncProgress = async () => {
      if (!readsLocalProgress) return;
      const progress = await readTurnProgress({
        cliId: bot?.cliId,
        triggerId,
        botId: agentId,
        channelId,
        sessionId,
        createdAt,
      }).catch(() => undefined);
      signal.throwIfAborted();
      if (progress) await publish(progress);
    };

    for (;;) {
      signal.throwIfAborted();
      const result = await botmux.pollTriggerResult(sessionId, triggerId, requestSignal(10_000)).catch(() => undefined);
      signal.throwIfAborted();
      const completion = result && terminalResult(result);
      if (completion) {
        await syncProgress();
        return { ...completion, adapterMeta };
      }

      if (result?.state === 'not_found' && Date.now() - acceptedAt >= RESULT_NOT_FOUND_GRACE_MS) {
        await syncProgress();
        return { content: 'Botmux 未找到本轮执行记录', status: 'failed', adapterMeta };
      }
      if (result?.state === 'running' && readsLocalTranscript && Date.now() >= nextTranscriptCheck) {
        nextTranscriptCheck = Date.now() + TRANSCRIPT_POLL_MS;
        const recovered = await recoverAntigravityTurn(turn, channelId, runtimeBotId).catch(() => undefined);
        signal.throwIfAborted();
        if (recovered) {
          await syncProgress();
          return { ...recovered, adapterMeta };
        }
      }
      await syncProgress();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...TIMED_OUT, adapterMeta };
      await wait(Math.min(pollMs, remaining));
    }
  }

  return startRuntimeBridge(options, {
    async discoverAgents() {
      return bots.map(bot => ({ id: bot.larkAppId, name: bot.botName, cliId: bot.cliId,
        workingDir: bot.workingDir, capabilities: BOTMUX_CAPABILITIES }));
    },
    prepareTurn,
    async executeTurn({ initial, event, progress }) {
      let turn = initial;
      if (turn.stage === 'dispatch') {
        turn = await dispatchTurn(turn, Boolean(event));
        signal.throwIfAborted();
        journal.save(turn);
      }
      if (turn.stage === 'poll') {
        sessionBindings.set(turn.bindingKey, turn.sessionId);
        return waitForResult(turn, progress);
      }
      if (turn.stage === 'deliver') return turn.completion;
      throw new Error('Unexpected Botmux turn stage');
    },
    onAskAnswered: answer => { void botmux.answerAsk(answer); },
    stop: () => controller.abort(),
  }, journal);
}
