import { turnAbortSignal } from './bridge-provider';
import { readdir } from 'node:fs/promises';
import { normalizeServerUrl } from '@buzz-botmux/chat-client';
import type { BotTurnRequestedEvent } from '@buzz-botmux/chat-client';
import { startRuntimeBridge } from './bridge-core';
import type { GatewayOptions } from './bridge-provider';
import { openTurnJournal } from './bridge-turn-journal';
import type { DirectCliAgentConfig } from './config';
import { openSessions } from './direct-sessions';
import { executeCli } from './direct-adapters';

function promptFor(event: BotTurnRequestedEvent, resume: boolean, inputs?: string[]) {
  const { content, attachments } = event.triggerMessage;
  const message = [
    content,
    ...(inputs ?? attachments.map((item) => `[附件] ${item.name} (${item.mimeType}) ${item.url}`)),
  ].join('\n');
  if (resume) return message;
  return [event.systemPrompt, 'Write files to return as attachments in $BUBAI_OUTPUT_DIR.', event.history.length ? JSON.stringify(event.history) : '', message]
    .filter(Boolean)
    .join('\n\n');
}

export async function startDirectBridge(
  options: GatewayOptions,
  agents: DirectCliAgentConfig[],
  concurrency = 3,
  timeoutMs?: number,
) {
  const scope = normalizeServerUrl(options.serverUrl);
  const journal = openTurnJournal(scope, 'direct');
  const sessions = openSessions();
  const controller = new AbortController();
  const tails = new Map<string, Promise<unknown>>();
  const waiters: Array<() => void> = [];
  let available = concurrency;

  return startRuntimeBridge(
    options,
    {
      async discoverAgents() {
        return agents.map((agent) => ({
          id: agent.externalId,
          name: agent.name,
          cliId: agent.cliId,
          workingDir: agent.workingDir,
          capabilities: ['progress_steps'],
        }));
      },
      prepareTurn(event) {
        return {
          stage: 'direct',
          messageId: event.replyTarget.messageId,
          agentId: event.botId,
          bindingKey: JSON.stringify([scope, event.botId, event.channel.id, event.threadId || '']),
          deadline: timeoutMs === undefined ? undefined : Date.now() + timeoutMs,
        };
      },
      async executeTurn({ initial, event, progress, files }) {
        if (!event) return { status: 'failed', content: '本地 CLI 进程因重启已中断' };
        const { bindingKey } = initial;
        const prior = tails.get(bindingKey) || Promise.resolve();
        const run = prior
          .catch(() => {})
          .then(async () => {
            if (available > 0) available--;
            else await new Promise<void>((resolve) => waiters.push(resolve));
            try {
              const agent = agents.find((item) => item.externalId === (event.externalId || event.botId));
              if (!agent) throw new Error('Unknown local agent');
              const signal = turnAbortSignal(controller.signal, initial.deadline);
              signal.throwIfAborted();
              const session = sessions.get(bindingKey);
              const invoke = (id?: string) =>
                executeCli(agent, promptFor(event, Boolean(id), files?.inputs), id, signal, progress, files);
              const reply = await invoke(session).catch((err) => {
                if (
                  !session ||
                  !/(no conversation found with session id|(?:session|thread|rollout)[^\n]{0,100}(?:not found|does not exist)|no rollout found for thread)/i.test(
                    err.message,
                  )
                )
                  throw err;
                sessions.set(bindingKey);
                return invoke();
              });
              if (reply.sessionId) sessions.set(bindingKey, reply.sessionId);
              if (files) {
                const outputs = await readdir(files.output, { withFileTypes: true });
                if (outputs.length > 16) throw new Error('Too many output artifacts');
                for (const item of outputs) {
                  if (item.isFile()) files.artifacts.push({path:item.name});
                }
              }
              return reply.content;
            } finally {
              const next = waiters.shift();
              if (next) next();
              else available++;
            }
          });
        tails.set(bindingKey, run);
        try {
          return { status: 'completed', content: await run };
        } catch (err) {
          return {
            status:
              (err as Error).name === 'TimeoutError' || (initial.deadline !== undefined && Date.now() >= initial.deadline) ? 'timeout' : 'failed',
            content: (err as Error).message,
          };
        } finally {
          if (tails.get(bindingKey) === run) tails.delete(bindingKey);
        }
      },
      stop: () => controller.abort(),
    },
    journal,
  );
}
