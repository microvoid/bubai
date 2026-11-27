import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { normalizeProgressSnapshot, type AgentProgressStep } from '@buzz-botmux/botmux-client';
import type { DirectCliAgentConfig } from '../config';
import type { TurnContext } from '../bridge-provider';
import { claude } from './claude';
import { codex } from './codex';

export async function executeCli(
  agent: DirectCliAgentConfig,
  prompt: string,
  session: string | undefined,
  signal: AbortSignal,
  progress: TurnContext['progress'],
) {
  signal.throwIfAborted();
  const adapter = { claude, codex }[agent.cliId];
  const entry = fileURLToPath(
    import.meta.url.endsWith('.ts') ? new URL('../index.ts', import.meta.url) : import.meta.url,
  );
  const env = { ...process.env };
  for (const key of ['BUBAI_TOKEN', 'BUBAI_BOT_TOKEN', 'BUZZ_BOT_TOKEN', 'BOTMUX_TOKEN']) delete env[key];
  const child = spawn(
    process.execPath,
    [entry, '_direct-worker', agent.cliId, ...adapter.args(agent.permissionMode, session)],
    {
      cwd: agent.workingDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    // stdout is drained below. Node may omit 'close' after the parent disconnects IPC.
    child.once('exit', resolve);
  });
  void exit.catch(() => {});
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (data) => {
    stderr = (stderr + data).slice(-4000);
  });
  child.stdin!.on('error', () => {});
  child.stdin!.end(prompt);
  const abort = () => {
    if (child.connected) child.disconnect();
  };
  signal.addEventListener('abort', abort, { once: true });
  const steps = new Map<string, AgentProgressStep>();
  let sessionId = session;
  let result: string | undefined;
  let error: string | undefined;
  try {
    for await (const line of createInterface({ input: child.stdout!, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const event = adapter.parse(JSON.parse(line));
      if (event.session) sessionId = event.session;
      if (event.result !== undefined) result = event.result;
      if (event.error) error = event.error;
      for (const step of event.steps ?? []) {
        if (!step.id) continue;
        const previous = steps.get(step.id);
        if (!previous && !step.label) continue;
        steps.set(step.id, {
          kind: 'tool',
          label: 'Tool',
          status: 'running',
          ...previous,
          ...step,
          id: step.id,
        });
      }
      if (event.steps?.length) {
        const snapshot = normalizeProgressSnapshot({ steps: [...steps.values()], toolCount: steps.size });
        if (snapshot) await progress(snapshot);
      }
    }
    const code = await exit;
    signal.throwIfAborted();
    if (code !== 0 || error)
      throw new Error(error || stderr.trim() || `${agent.cliId} exited with code ${code}`);
    if (!result?.trim()) throw new Error(`${agent.cliId} returned no final reply`);
    return { content: result, sessionId };
  } finally {
    abort();
    signal.removeEventListener('abort', abort);
    await exit.catch(() => {});
  }
}
