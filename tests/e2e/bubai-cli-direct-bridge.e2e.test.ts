import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BubaiClient, type ChatMessage } from '../../packages/chat-client/src';

const root = path.resolve(import.meta.dir, '../..');
async function until<T>(fn: () => Promise<T | undefined | false>, label: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await Bun.sleep(40);
  }
  throw new Error('Timed out: ' + label);
}

// Both executable fixtures consume stdin and emit their native event format.
// A lock in the fixture detects overlapping calls to the same conversation.
const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const codex = process.argv[1].endsWith('codex');
const prompt = fs.readFileSync(0, 'utf8');
const message = prompt.trim().split('\\n').at(-1);
const resume = args.includes(codex ? 'resume' : '--resume');
if (resume && message.includes('expire') && !fs.existsSync('expired')) {
  fs.writeFileSync('expired', '1');
  console.error('session not found'); process.exit(1);
}
fs.writeFileSync('busy', message, { flag: 'wx' });
fs.appendFileSync('calls', JSON.stringify({args, prompt}) + '\\n');
const emit = value => console.log(JSON.stringify(value));
emit(codex ? {type:'thread.started',thread_id:'session-1'} : {type:'system',session_id:'session-1'});
emit(codex ? {type:'item.started',item:{id:'x',type:'command_execution',command:'fixture'}}
  : {type:'assistant',message:{content:[{type:'tool_use',id:'x',name:'Read'}]}});
if (message.includes('hang')) {
  const proc = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},500)'], {stdio:'ignore'});
  fs.writeFileSync('descendant', String(proc.pid));
  setInterval(()=>{}, 500);
} else {
  setTimeout(() => {
    fs.unlinkSync('busy');
    if (message.includes('fail-me')) { console.error('fixture failure'); process.exit(2); }
    emit(codex ? {type:'item.completed',item:{id:'x',type:'command_execution',command:'fixture',exit_code:0}}
      : {type:'user',message:{content:[{type:'tool_result',tool_use_id:'x'}]}});
    emit(codex ? {type:'item.completed',item:{id:'reply',type:'agent_message',text:'reply '+message}}
      : {type:'result',subtype:'success',result:'reply '+message,session_id:'session-1'});
  }, 350);
}
`;

for (const cli of ['codex', 'claude']) {
  test(`direct ${cli} daemon handles progress, resume, ordering, failure and restart`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bub-direct-'));
    const bundle = path.join(dir, 'bub.mjs');
    execFileSync(path.join(root, 'apps/cli/node_modules/.bin/esbuild'), [
      path.join(root, 'apps/cli/src/index.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      '--outfile=' + bundle,
    ]);
    const executable = path.join(dir, cli);
    fs.writeFileSync(executable, fixture, { mode: 0o700 });
    const port = 31000 + Math.floor(Math.random() * 10000);
    const serverUrl = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      BUBAI_URL: serverUrl,
      BUBAI_TOKEN: 'fixture-token',
      BUBAI_CONFIG_DIR: dir,
      BOTMUX_ENDPOINT: 'http://127.0.0.1:1',
    };
    const server = Bun.spawn(['bun', 'run', path.join(root, 'apps/server/src/main.ts')], {
      cwd: dir,
      env: {
        ...env,
        PORT: String(port),
        DATABASE_URL: '',
        BOTMUX_DISABLED: 'true',
        BUBAI_AUTH_REQUIRED: 'false',
        BUZZ_BOT_TOKEN: 'fixture-token',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    async function bub(...args: string[]) {
      const invocation = crypto.randomUUID();
      const outFile = path.join(dir, invocation + '.stdout');
      const errFile = path.join(dir, invocation + '.stderr');
      const p = Bun.spawn(['node', bundle, ...args], {
        env,
        stdout: Bun.file(outFile),
        stderr: Bun.file(errFile),
      });
      const code = await p.exited;
      const out = fs.readFileSync(outFile, 'utf8');
      const err = fs.readFileSync(errFile, 'utf8');
      if (code) throw new Error(err || out);
      return out;
    }
    const sdk = new BubaiClient({ baseUrl: serverUrl });
    let ws: ReturnType<typeof sdk.connectWebSocket> | undefined;
    try {
      await until(
        () =>
          fetch(serverUrl + '/health').then(
            (r) => r.ok,
            () => false,
          ),
        'server startup',
      );
      const { channel } = await sdk.createChannel({ name: 'direct-room', userId: 'u-owner' });
      const start = ['--channel', channel.id, '--turn-timeout-ms', '4000'];
      await bub('start', '--cli', cli, '--cwd', dir, '--name', 'LocalTest', ...start);
      const status = async () => JSON.parse(await bub('status', '--json')).bridge;
      expect((await status()).mode).toBe('direct');
      expect((await status()).directAgents).toHaveLength(1);
      let open = false;
      ws = sdk.connectWebSocket({
        userId: 'u-owner',
        onStateChange: (state) => {
          open = state === 'open';
        },
      });
      await until(async () => open, 'user connected');
      const send = (text: string) =>
        ws!.send({
          type: 'message.send',
          payload: {
            senderId: 'u-owner',
            channelId: channel.id,
            content: '@LocalTest ' + text,
          },
        });
      const card = (label: string, pred: (m: ChatMessage) => boolean) =>
        until(
          async () => (await sdk.getChannelMessages(channel.id)).messages.find((m) => m.card && pred(m)),
          label,
        );
      send('first');
      await card(
        'live progress',
        (m) => m.card?.status === 'running' && m.card.progress?.steps[0]?.status === 'running',
      );
      send('second');
      const second = await card('queued second reply', (m) => m.content === 'reply @LocalTest second');
      expect(second.card?.progress?.steps[0]?.status).toBe('done');
      const calls = () =>
        fs
          .readFileSync(path.join(dir, 'calls'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      expect(calls()).toHaveLength(2);
      expect(calls()[1].args).toContain('session-1');
      expect(calls()[1].prompt).toBe('@LocalTest second');
      send('expire');
      await card('recreated session', (m) => m.content === 'reply @LocalTest expire');
      expect(calls().at(-1).args).not.toContain('session-1');
      send('fail-me');
      await card('nonzero exit', (m) => m.card?.status === 'failed' && m.content.includes('fixture failure'));
      send('hang-timeout');
      await card('timeout', (m) => m.card?.status === 'timeout');
      const reap = async () => {
        const pid = Number(fs.readFileSync(path.join(dir, 'descendant'), 'utf8'));
        await until(async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }, 'process tree cleanup');
        fs.unlinkSync(path.join(dir, 'busy'));
        fs.unlinkSync(path.join(dir, 'descendant'));
      };
      await reap();
      send('hang-crash');
      await until(async () => fs.existsSync(path.join(dir, 'descendant')), 'second child spawned');
      process.kill((await status()).pid, 'SIGKILL');
      await reap();
      await bub('start', ...start);
      await card('recovered card', (m) => m.card?.status === 'failed' && m.content.includes('重启'));
      await bub('stop');
      expect(await status()).toBeNull();
    } finally {
      ws?.close();
      await bub('stop').catch(() => {});
      server.kill();
      await server.exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
}
