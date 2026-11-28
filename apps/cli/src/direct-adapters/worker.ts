import { stopProcessGroup } from '@bubx/agent/process';
import { spawn } from 'node:child_process';

// This process holds the daemon IPC pipe. Even SIGKILL of the daemon closes
// the pipe, giving the worker a chance to reap the CLI's process group.
export function superviseDirectCli([cli, ...args]: string[]) {
  if (!process.connected || (cli !== 'claude' && cli !== 'codex'))
    throw new Error('Invalid internal CLI worker');
  const child = spawn(cli, args, { detached: process.platform !== 'win32', stdio: 'inherit' });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!child.pid) process.exit(1);
    void stopProcessGroup(child.pid).finally(() => process.exit(1));
  };
  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  child.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
  child.on('exit', (code) => {
    if (!stopping) process.exit(code ?? 1);
  });
}
