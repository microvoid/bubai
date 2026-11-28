import { Agent, type AgentOptions } from '@mariozechner/pi-agent-core';
import { getModels, getProviders, type Api, type Model } from '@mariozechner/pi-ai';
import type { PiModelConfig } from './config.js';
import { resolveProfile, type PiToolAgentProfile } from './profiles.js';
import { PiHistory } from './pi-history.js';
import { piTools } from './tools.js';
import type { AgentFiles, AgentTurnHost, ToolStep } from './types.js';
import { TurnLimiter } from './turn-limiter.js';

export interface AgentTurn {
  bindingKey: string;
  content: string;
  systemPrompt?: string;
  history?: readonly unknown[];
  profile?: PiToolAgentProfile;
  files?: AgentFiles;
  cwd?: string;
  signal?: AbortSignal;
}

export interface AgentResult {
  status: 'completed' | 'failed' | 'timeout';
  content: string;
}

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

export function createBubAgentRunner(
  config: PiModelConfig,
  options: {
    /** Use 'host' when the caller already queues turns by bindingKey and limits concurrency. */
    concurrency?: number | 'host';
    streamFn?: AgentOptions['streamFn'];
  } = {},
) {
  const model = modelFor(config);
  const sessions = new PiHistory();
  const limiter = options.concurrency === 'host' ? undefined : new TurnLimiter(options.concurrency ?? 3);
  const shutdown = new AbortController();
  const defaultProfile = resolveProfile({
    profile: 'default',
    name: 'BubAI 助手',
    externalId: 'default',
  });
  return {
    async run(turn: AgentTurn, host: AgentTurnHost = {}): Promise<AgentResult> {
      const signal = turn.signal ? AbortSignal.any([shutdown.signal, turn.signal]) : shutdown.signal;
      const key = turn.bindingKey;
      const run = async (): Promise<AgentResult> => {
        const history = sessions.get(key);
        const profile = turn.profile ?? defaultProfile;
        const tools =
          turn.files && profile.allowedBins.length
            ? piTools(profile, turn.files, turn.cwd ?? process.cwd(), signal, host)
            : [];
        const systemPrompt = [
          turn.systemPrompt || 'You are a helpful assistant.',
          profile.systemPrompt,
          tools.length &&
            'Allowed CLI: ' + profile.allowedBins.join(', ') + '. Register outputs using artifact_emit.',
        ]
          .filter(Boolean)
          .join('\n');
        const agent = new Agent({
          streamFn: options.streamFn,
          getApiKey: () => config.apiKey,
          initialState: { model, messages: history, tools, systemPrompt },
        });
        const steps = new Map<string, ToolStep>();
        agent.subscribe(async (e) => {
          if (e.type !== 'tool_execution_start' && e.type !== 'tool_execution_end') return;
          steps.set(e.toolCallId, {
            id: e.toolCallId,
            label: e.toolName,
            kind: 'tool',
            status: e.type === 'tool_execution_start' ? 'running' : e.isError ? 'failed' : 'done',
          });
          await host.onProgress?.({
            steps: [...steps.values()],
            toolCount: steps.size,
            updatedAt: Date.now(),
          });
        });
        const abort = () => agent.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          await agent.prompt(
            [
              !history && turn.history?.length ? JSON.stringify(turn.history) : '',
              turn.content,
              ...(turn.files?.inputs || []),
              tools.length ? 'Output directory: ' + turn.files!.output : '',
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
              (last?.role === 'assistant' && last.errorMessage ? ': ' + last.errorMessage : ''),
          );
        sessions.set(key, agent.state.messages);
        return {
          status: 'completed',
          content: last.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
        };
      };
      try {
        return await (limiter ? limiter.run(key, signal, run) : run());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'failed',
          content: config.apiKey ? message.replaceAll(config.apiKey, '[redacted]') : message,
        };
      }
    },
    stop: () => shutdown.abort(),
  };
}
