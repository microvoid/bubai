import { waitForProcessGroups } from '@bubx/agent/process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfigPath } from './config';
import { startRuntime } from './runtime';
import type { RuntimeMode } from './direct-config';
import { type BotmuxBridgeOptions } from './bridge-botmux';

type Status = { mode: RuntimeMode; piAgents?: string[]; directAgents: string[]; state: 'connecting' | 'online'; pid: number; online: number };

function socketPath() {
  const scope = createHash('sha256').update(path.resolve(getConfigPath())).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return '\\\\.\\pipe\\bub-' + scope;
  // Unix socket paths have a small platform limit, even for deeply nested configs.
  const dir = path.join('/tmp', `bub-${os.userInfo().uid}-${scope}`);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== os.userInfo().uid || (st.mode & 0o077)) {
    throw new Error(`Unsafe bridge runtime directory: ${dir}`);
  }
  return path.join(dir, 'bridge.sock');
}

export function daemonRequest(stop = false): Promise<Status | null> {
  return new Promise((resolve, reject) => {
    const req = net.createConnection(socketPath(), () => req.write(stop ? 'stop\n' : 'status\n'));
    let body = '';
    req.setEncoding('utf8').on('data', part => { body += part; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') resolve(null);
      else reject(err);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Local bridge did not respond')));
  });
}

export async function runDaemon(options: BotmuxBridgeOptions, mode: RuntimeMode, concurrency?: number, selectedAgents?: string[]) {
  const online = new Set<string>();
  let bridge: Awaited<ReturnType<typeof startRuntime>> | undefined;
  const server = net.createServer(client => {
    client.on('error', () => client.destroy());
    client.setTimeout(3000, () => client.destroy());
    let command = '';
    client.setEncoding('utf8').on('data', chunk => {
      command += chunk;
      if (!command.includes('\n')) return;
      const status: Status = {
        state: bridge && bridge.agentIds.every(id => online.has(id)) ? 'online' : 'connecting',
        piAgents: bridge?.piIds.filter(id => online.has(id)) ?? [],
        pid: process.pid, online: online.size, mode, directAgents: bridge?.directIds.filter(id => online.has(id)) ?? [],
      };
      client.end(JSON.stringify(status));
      if (command.trim() === 'stop') shutdown();
    });
  });
  function shutdown() {
    bridge?.stop();
    server.close(() => { void waitForProcessGroups().then(() => process.exit(0)); });
  }
  const socket = socketPath();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    bridge = await startRuntime({
      ...options,
      onReady: info => info.agentIds.forEach(id => online.add(id)),
      onDisconnect: ids => ids.forEach(id => online.delete(id)),
    }, mode, concurrency, selectedAgents);
  } catch (err) {
    server.close();
    throw err;
  }
}

export async function startDaemon(prepareArgs: () => Promise<string[]>) {
  let status = await daemonRequest();
  if (status) {
    const deadline = Date.now() + 60_000;
    while (status?.state === 'connecting' && Date.now() < deadline) {
      await delay(150);
      status = await daemonRequest();
    }
    if (status?.state !== 'online') throw new Error('The existing bridge did not reach the gateway. Check bridge.log in your CLI config directory.');
    console.log(`Bridge already running (${status.state}, PID ${status.pid}).`);
    return;
  }
  const args = await prepareArgs();
  const dir = path.dirname(getConfigPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socket = socketPath();
  // An unclean exit can leave a dead Unix socket behind.
  if (process.platform !== 'win32') {
    const stale = fs.lstatSync(socket, { throwIfNoEntry: false });
    if (stale?.isSocket() && !await daemonRequest()) {
      const current = fs.lstatSync(socket, { throwIfNoEntry: false });
      if (current?.ino === stale.ino) fs.rmSync(socket, { force: true });
    }
  }
  const log = path.join(dir, 'bridge.log');
  const fd = fs.openSync(log, 'a', 0o600);
  const child = (() => {
    try {
      return spawn(process.execPath, [process.argv[1]!, '_bridge-daemon', ...args], {
        detached: true, stdio: ['ignore', fd, fd, 'ipc'],
      });
    } finally { fs.closeSync(fd); }
  })();
  let failure: string | undefined;
  child.on('error', err => { failure = err.message; });
  child.on('message', msg => { if (typeof msg === 'string') failure = msg; });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      status = await daemonRequest();
      if (status?.state === 'online') {
        console.log(`Bridge online: ${status.online} bot(s), PID ${status.pid}.`);
        return;
      }
      if (!status && (failure || child.exitCode !== null || child.signalCode)) {
        throw new Error(failure || `Bridge exited. See ${log}`);
      }
      await delay(150);
    }
    child.kill();
    throw new Error(`Timed out waiting for gateway registration. See ${log}`);
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}
