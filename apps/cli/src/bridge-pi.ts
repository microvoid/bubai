import { createBubAgentRunner, resolveProfile } from '@bubx/agent';
import { TurnLimiter } from '@bubx/agent/process';
import { askRegistry, turnHost } from './pi-host';
import { normalizeServerUrl } from '@buzz-botmux/chat-client';
import { randomUUID } from 'node:crypto';
import { startRuntimeBridge } from './bridge-core';
import type { GatewayOptions, LocalRuntimeProvider } from './bridge-provider';
import { openTurnJournal } from './bridge-turn-journal';
import {
  loadCliConfig,
  resolvePiModel,
  saveCliConfig,
  type PiAgentConfig,
  type PiModelConfig,
} from './config';

export function piAgents() {
  const saved = loadCliConfig().piAgents;
  if (saved?.length) return saved;
  const agents = [
    {
      profile: 'default',
      name: 'BubAI 助手',
      externalId: 'pi-' + randomUUID(),
    },
  ];
  saveCliConfig({ piAgents: agents });
  return agents;
}

export function createPiProvider(
  scope: string,
  agents: PiAgentConfig[],
  config: PiModelConfig,
  timeoutMs?: number,
): LocalRuntimeProvider {
  const runner = createBubAgentRunner(config, { concurrency: 'host' });
  const profiles = new Map(agents.map((agent) => [agent.externalId, resolveProfile(agent)]));
  const asks = askRegistry();
  return {
    async discoverAgents() {
      return agents.map((a) => ({
        id: a.externalId,
        name: a.name,
        cliId: 'pi',
        capabilities: profiles.get(a.externalId)?.allowedBins.length
          ? ['progress_steps', 'interactive_ask']
          : ['progress_steps'],
      }));
    },
    onAskAnswered: asks.answered,
    prepareTurn(event) {
      const profile = agents.find((a) => a.externalId === (event.externalId || event.botId));
      const duration = (profile && profiles.get(profile.externalId)?.defaultTimeoutMs) ?? timeoutMs;
      return {
        stage: 'pi',
        messageId: event.replyTarget.messageId,
        agentId: event.botId,
        bindingKey: JSON.stringify([scope, event.botId, event.channel.id, event.threadId || '']),
        deadline: duration === undefined ? undefined : Date.now() + duration,
      };
    },
    async executeTurn(ctx) {
      const { event, initial } = ctx;
      if (!event)
        return {
          status: 'failed',
          content: 'Pi turn interrupted by bridge restart',
        };
      const id = event.externalId || event.botId;
      const profile = profiles.get(id);
      if (!profile) return { status: 'failed', content: 'Unknown Pi agent' };
      return runner.run(
        {
          bindingKey: initial.bindingKey,
          content: event.triggerMessage.content,
          history: event.history,
          systemPrompt: event.systemPrompt,
          signal: ctx.signal,
          files: ctx.files,
          profile,
          cwd: agents.find((a) => a.externalId === id)?.workingDir,
        },
        turnHost(ctx, asks),
      );
    },
    stop: runner.stop,
  };
}

export function startPiBridge(options: GatewayOptions, concurrency = 3, timeoutMs?: number) {
  const scope = normalizeServerUrl(options.serverUrl);
  const provider = createPiProvider(scope, piAgents(), resolvePiModel(), timeoutMs);
  return startRuntimeBridge(
    { ...options, limiter: options.limiter ?? new TurnLimiter(concurrency) },
    provider,
    openTurnJournal(scope, 'pi'),
  );
}
