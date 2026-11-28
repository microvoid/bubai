import { normalizeProgressSnapshot } from '@buzz-botmux/botmux-client';
import { randomUUID } from 'node:crypto';
import type { TurnContext } from './bridge-provider';
import { readArtifact } from './bridge-attachments';
import type { AgentTurnHost } from '@bubx/agent';
export function askRegistry() {
  const pending = new Map<string, { bot: string; finish: (answer: string[][]) => void }>();
  return {
    answered(event: { askId: string; larkAppId: string; selections: string[][] }) {
      const entry = pending.get(event.askId);
      if (entry?.bot === event.larkAppId) entry.finish(event.selections);
    },
    async ask(ctx: TurnContext, question: string, options: string[], signal: AbortSignal) {
      const id = randomUUID();
      const bot = ctx.initial.agentId;
      const answer = Promise.withResolvers<string[][]>();
      const abort = () => answer.reject(signal.reason);
      signal.throwIfAborted();
      signal.addEventListener('abort', abort, { once: true });
      pending.set(id, { bot, finish: answer.resolve });
      try {
        const send = ctx.sdk!.createBotAsk(
          {
            askId: id,
            expiresAt: ctx.initial.deadline,
            agentId: bot,
            title: question,
            sessionId: ctx.initial.messageId,
            questions: [
              {
                question,
                options: options.map((label) => ({ key: label, label })),
              },
            ],
          },
          signal,
        );
        return await Promise.race([answer.promise, send.then(() => answer.promise)]);
      } finally {
        pending.delete(id);
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

export function turnHost(ctx: TurnContext, asks: ReturnType<typeof askRegistry>): AgentTurnHost {
  return {
    async onProgress(snapshot) {
      const normalized = normalizeProgressSnapshot(snapshot);
      if (normalized) await ctx.progress(normalized);
    },
    askUser: ({ question, options }, signal) => asks.ask(ctx, question, options, signal),
    async sendNotice(text, signal) {
      const event = ctx.event!;
      await ctx.sdk!.sendBotMessage(
        {
          botId: ctx.initial.agentId,
          channelId: event.channel.id,
          threadId: event.replyTarget.threadId ?? event.threadId,
          standalone: true,
          content: text,
        },
        signal,
      );
    },
    async emitArtifact(artifact) {
      const files = ctx.files!;
      if (files.artifacts.length >= 16) throw new Error('Too many artifacts');
      await readArtifact(files, artifact);
      files.artifacts.push(artifact);
    },
  };
}
