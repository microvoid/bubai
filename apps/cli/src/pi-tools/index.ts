import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { TurnContext } from '../bridge-provider';
import { readArtifact } from '../bridge-attachments';
import type { PiToolAgentProfile } from '../pi-profiles';

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
            questions: [{ question, options: options.map((label) => ({ key: label, label })) }],
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

async function execute(
  bin: string,
  args: string[],
  cwd: string,
  output: string,
  inputs: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'LANG', 'TMPDIR', 'SystemRoot', 'USERPROFILE'])
    if (process.env[key]) env[key] = process.env[key];
  env.BUBAI_OUTPUT_DIR = output;
  env.BUBAI_INPUT_FILES = JSON.stringify(inputs);
  const child = spawn(bin, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  function drain(chunk: Buffer) {
    log = (log + chunk.toString()).slice(-32768);
  }
  child.stdout.on('data', drain);
  child.stderr.on('data', drain);
  const terminate = () => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* The process group already exited. */
    }
  };
  signal.addEventListener('abort', terminate, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    signal.throwIfAborted();
    if (code !== 0) throw new Error('CLI exited ' + code + ': ' + log);
    return log;
  } finally {
    signal.removeEventListener('abort', terminate);
  }
}

export function piTools(
  profile: PiToolAgentProfile,
  ctx: TurnContext,
  cwd: string,
  signal: AbortSignal,
  asks: ReturnType<typeof askRegistry>,
): AgentTool<any>[] {
  const files = ctx.files!;
  const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
  const tool = <S extends ReturnType<typeof Type.Object>>(definition: AgentTool<S>) => definition;
  return [
    tool({
      name: 'cli_exec',
      label: 'Run CLI',
      description: 'Run the configured executable. Write output files in BUBAI_OUTPUT_DIR.',
      parameters: Type.Object({ bin: Type.String(), args: Type.Array(Type.String()) }),
      async execute(_, { bin, args }) {
        const executable = profile.allowedBins.find((p) => p === bin || path.basename(p) === bin);
        if (!executable) throw new Error('Executable is not allowed by this profile');
        if (
          ['dreamina', 'libtv'].includes(profile.id) &&
          !(args.length === 1 && args.every((a: string) => ['help', '--help', '-h', '--version'].includes(a)))
        ) {
          const answer = await asks.ask(
            ctx,
            '允许执行 ' + bin + ' ' + JSON.stringify(args) + '？此操作可能消耗积分。',
            ['允许', '取消'],
            signal,
          );
          if (answer[0]?.[0] !== '允许') throw new Error('User declined this operation');
        }
        return result(await execute(executable, args, cwd, files.output, files.inputs, signal));
      },
    }),
    tool({
      name: 'artifact_emit',
      label: 'Attach file',
      description: 'Attach a file from this turn output directory.',
      parameters: Type.Object({
        path: Type.String(),
        name: Type.Optional(Type.String()),
        mimeType: Type.Optional(Type.String()),
      }),
      async execute(_, params) {
        const artifact = { path: String(params.path), name: params.name, mimeType: params.mimeType };
        if (files.artifacts.length >= 16) throw new Error('Too many artifacts');
        await readArtifact(files, artifact);
        files.artifacts.push(artifact);
        return result('Registered');
      },
    }),
    tool({
      name: 'send_notice',
      label: 'Send update',
      description: 'Send an update to the current conversation.',
      parameters: Type.Object({ text: Type.String() }),
      async execute(_, { text }) {
        await ctx.sdk!.sendBotMessage(
          {
            botId: ctx.initial.agentId,
            channelId: ctx.event!.channel.id,
            threadId: ctx.event!.replyTarget.threadId ?? ctx.event!.threadId,
            standalone: true,
            content: text,
          },
          signal,
        );
        return result('Sent');
      },
    }),
    tool({
      name: 'ask_user',
      label: 'Ask user',
      description: 'Ask a multiple choice question and await the answer.',
      parameters: Type.Object({
        question: Type.String(),
        options: Type.Array(Type.String(), { minItems: 2, maxItems: 8 }),
      }),
      async execute(_, { question, options }) {
        return result(JSON.stringify(await asks.ask(ctx, question, options, signal)));
      },
    }),
  ];
}
