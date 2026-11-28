import { stopProcessGroup } from './local-process.js';
import { isMediaQuery } from './media-queries.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { PiToolAgentProfile } from './profiles.js';
import type { AgentFiles, AgentTurnHost } from './types.js';
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
  for (const key of [
    'HOME',
    'PATH',
    'LANG',
    'TMPDIR',
    'SystemRoot',
    'USERPROFILE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
  ])
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
  let stopping: Promise<void> | undefined;
  const terminate = () => {
    if (child.pid) stopping ??= stopProcessGroup(child.pid);
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
    await stopping;
  }
}

export function piTools(
  profile: PiToolAgentProfile,
  files: AgentFiles,
  cwd: string,
  signal: AbortSignal,
  host: AgentTurnHost,
): AgentTool<any>[] {
  const result = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    details: {},
  });
  const tool = <S extends ReturnType<typeof Type.Object>>(definition: AgentTool<S>) => definition;
  return [
    tool({
      name: 'cli_exec',
      label: 'Run CLI',
      description: 'Run the configured executable. Write output files in BUBAI_OUTPUT_DIR.',
      parameters: Type.Object({
        bin: Type.String(),
        args: Type.Array(Type.String()),
      }),
      async execute(_, { bin, args }) {
        const executable = profile.allowedBins.find((p) => p === bin || path.basename(p) === bin);
        if (!executable) throw new Error('Executable is not allowed by this profile');
        if (['dreamina', 'libtv'].includes(profile.id) && !isMediaQuery(profile.id, args)) {
          if (!host.askUser) throw new Error('This media operation requires user approval');
          const answer = await host.askUser(
            {
              question: '允许执行 ' + bin + ' ' + JSON.stringify(args) + '？此操作可能消耗积分。',
              options: ['允许', '取消'],
            },
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
        const artifact = {
          path: String(params.path),
          name: params.name,
          mimeType: params.mimeType,
        };
        if (!host.emitArtifact) throw new Error('Artifact delivery is unavailable');
        await host.emitArtifact(artifact, signal);
        return result('Registered');
      },
    }),
    tool({
      name: 'send_notice',
      label: 'Send update',
      description: 'Send an update to the current conversation.',
      parameters: Type.Object({ text: Type.String() }),
      async execute(_, { text }) {
        if (!host.sendNotice) throw new Error('Notices are unavailable');
        await host.sendNotice(text, signal);
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
        if (!host.askUser) throw new Error('User interaction is unavailable');
        return result(JSON.stringify(await host.askUser({ question, options }, signal)));
      },
    }),
  ];
}
