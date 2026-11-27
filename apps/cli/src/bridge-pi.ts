import { turnAbortSignal } from './bridge-provider';
import { piTools, askRegistry } from './pi-tools';
import { resolveProfile } from './pi-profiles';
import { Agent, type AgentMessage, type AgentOptions } from '@mariozechner/pi-agent-core';
import { getModels, getProviders, type Api, type Model } from '@mariozechner/pi-ai';
import { normalizeProgressSnapshot, type AgentProgressStep } from '@buzz-botmux/botmux-client';
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

function modelFor(config: PiModelConfig): Model<Api> {
  const provider = getProviders().find((id) => id === config.provider);
  const known = provider && getModels(provider).find((model) => model.id === config.model);
  if (known && !config.baseUrl) return known;
  if (!config.baseUrl) throw new Error('Unknown Pi model: ' + config.provider + '/' + config.model);
  const template = known || getModels('openai').find((model) => model.id === 'gpt-4o-mini')!;
  return {
    ...template,
    provider: config.provider,
    id: config.model,
    baseUrl: config.baseUrl,
    api: config.provider === 'openai' || !known ? 'openai-completions' : template.api,
  };
}

export function piAgents() {
  const saved = loadCliConfig().piAgents;
  if (saved?.length) return saved;
  const agents = [{ profile: 'default', name: 'BubAI 助手', externalId: 'pi-' + randomUUID() }];
  saveCliConfig({ piAgents: agents });
  return agents;
}

export function createPiProvider(
  scope: string,
  agents: PiAgentConfig[],
  config: PiModelConfig,
  concurrency: number,
  timeoutMs?: number,
  extra: Pick<AgentOptions, 'streamFn'> = {},
): LocalRuntimeProvider {
  const model = modelFor(config);
  const profiles = new Map(agents.map((agent) => [agent.externalId, resolveProfile(agent)]));
  const asks = askRegistry();
  const sessions = new Map<string, AgentMessage[]>();
  const busy = new Set<string>();
  const changed = new EventTarget();
  const shutdown = new AbortController();
  async function waitSlot(key: string, signal: AbortSignal) {
    while (busy.has(key) || busy.size >= concurrency) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        function cleanup() {
          changed.removeEventListener('slot', ready);
          signal.removeEventListener('abort', abort);
        }
        function ready() {
          cleanup();
          resolve();
        }
        function abort() {
          cleanup();
          reject(signal.reason);
        }
        changed.addEventListener('slot', ready);
        signal.addEventListener('abort', abort);
      });
    }
    signal.throwIfAborted();
    busy.add(key);
  }
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
      if (!event) return { status: 'failed', content: 'Pi turn interrupted by bridge restart' };
      const key = initial.bindingKey;
      const signal = turnAbortSignal(shutdown.signal, initial.deadline);
      let acquired = false;
      try {
        await waitSlot(key, signal);
        acquired = true;
        const history = sessions.get(key);
        const configAgent = agents.find((a) => a.externalId === (event.externalId || event.botId));
        if (!configAgent) throw new Error('Unknown Pi agent');
        const profile = profiles.get(configAgent.externalId)!;
        const tools =
          ctx.files && profile.allowedBins.length
            ? piTools(profile, ctx, configAgent.workingDir || process.cwd(), signal, asks)
            : [];
        const systemPrompt = [
          event.systemPrompt || 'You are a helpful assistant.',
          profile.systemPrompt,
          tools.length &&
            'Allowed CLI: ' + profile.allowedBins.join(', ') + '. Register outputs using artifact_emit.',
        ]
          .filter(Boolean)
          .join('\n');
        const agent = new Agent({
          ...extra,
          getApiKey: () => config.apiKey,
          initialState: { model, messages: history, tools, systemPrompt },
        });
        const steps = new Map<string, AgentProgressStep>();
        agent.subscribe(async (e) => {
          if (e.type !== 'tool_execution_start' && e.type !== 'tool_execution_end') return;
          steps.set(e.toolCallId, {
            id: e.toolCallId,
            label: e.toolName,
            kind: 'tool',
            status: e.type === 'tool_execution_start' ? 'running' : e.isError ? 'failed' : 'done',
          });
          const snapshot = normalizeProgressSnapshot({ steps: [...steps.values()], toolCount: steps.size });
          if (snapshot) await ctx.progress(snapshot);
        });
        const abort = () => agent.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          await agent.prompt(
            [
              !history && event.history.length ? JSON.stringify(event.history) : '',
              event.triggerMessage.content,
              ...(ctx.files?.inputs || []),
              tools.length ? 'Output directory: ' + ctx.files!.output : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener('abort', abort);
        }
        const last = agent.state.messages.at(-1);
        if (last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted')
          throw new Error(
            'Pi model request failed' +
              (last?.role === 'assistant' && last.errorMessage
                ? ': ' + last.errorMessage.replaceAll(config.apiKey!, '[redacted]')
                : ''),
          );
        sessions.set(key, agent.state.messages);
        return {
          status: 'completed',
          content: last.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
        };
      } catch (err) {
        return {
          status: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'failed',
          content: (err as Error).message,
        };
      } finally {
        if (acquired) {
          busy.delete(key);
          changed.dispatchEvent(new Event('slot'));
        }
      }
    },
    stop: () => shutdown.abort(),
  };
}

export function startPiBridge(options: GatewayOptions, concurrency = 3, timeoutMs?: number) {
  const scope = normalizeServerUrl(options.serverUrl);
  const provider = createPiProvider(scope, piAgents(), resolvePiModel(), concurrency, timeoutMs);
  return startRuntimeBridge(options, provider, openTurnJournal(scope, 'pi'));
}
