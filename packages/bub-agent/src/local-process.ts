import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function findExecutable(bin: string): string | undefined {
  const names = process.platform === 'win32' && !path.extname(bin) ? [bin + '.exe', bin] : [bin];
  const dirs = path.isAbsolute(bin)
    ? ['']
    : path.basename(bin) === bin
      ? (process.env.PATH || '').split(path.delimiter).filter(Boolean)
      : [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.resolve(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch {
        /* Continue through PATH. */
      }
    }
  }
}

const stopping = new Set<Promise<void>>();

export function waitForProcessGroups() {
  return Promise.allSettled([...stopping]);
}

export function stopProcessGroup(pid: number) {
  const pending = terminate(pid);
  stopping.add(pending);
  pending.then(
    () => stopping.delete(pending),
    () => stopping.delete(pending),
  );
  return pending;
}

async function terminate(pid: number) {
  const windows = process.platform === 'win32';
  const target = windows ? pid : -pid;
  const send = (force: boolean) => {
    if (windows) {
      spawnSync('taskkill', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], { stdio: 'ignore' });
    } else {
      process.kill(target, force ? 'SIGKILL' : 'SIGTERM');
    }
  };
  try {
    send(false);
    const deadline = performance.now() + 500;
    while (performance.now() < deadline) {
      process.kill(target, 0);
      await delay(20);
    }
    send(true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export { TurnLimiter } from './turn-limiter.js';
