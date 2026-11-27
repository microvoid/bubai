// Run with BUBAI_LIVE_RELAY=1 bun test tests/e2e/live-agent-relay.e2e.test.ts
import { expect, test } from 'bun:test';
import { registerTestUser } from './account-mailbox';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CdpSession, findChromeBinary } from './browser-cdp';

const root = path.resolve(import.meta.dir, '../..');
function freePort() {
  const socket = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop();
  return port;
}

async function ready(url: string) {
  for (let i = 0; i < 150; i++) {
    if (await fetch(url).then(r => r.ok).catch(() => false)) return;
    await Bun.sleep(200);
  }
  throw new Error('Service did not start: ' + url);
}

type Agent = { id: string; name: string; adapterType: string; status: string };
type Row = { id: string; senderId: string; senderRole: string; content: string; botmuxSessionId?: string;
  adapterMeta?: { agentMentionHop?: number }; card?: { status: string; summary?: string } };

type Mode = 'relay' | 'codex' | 'claude';
async function runBrowserTurn(mode: Mode) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bubai-live-relay-'));
  const apiPort = freePort(), webPort = freePort(), chromePort = freePort();
  const api = 'http://127.0.0.1:' + apiPort, web = 'http://127.0.0.1:' + webPort;
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  let browser: CdpSession | undefined;
  let stopBridge: (() => void) | undefined;
  try {
    processes.push(Bun.spawn([process.execPath, path.join(root, 'apps/server/src/main.ts')], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(apiPort),
        BETTER_AUTH_URL: api, NODE_ENV: 'development', DATABASE_URL: '', BUBAI_AUTH_REQUIRED: 'false', BOTMUX_DISABLED: String(mode !== 'relay'), BUZZ_BOT_TOKEN: 'local-e2e',
        BOTMUX_ENDPOINT: process.env.BOTMUX_ENDPOINT, BOTMUX_TOKEN: process.env.BOTMUX_TOKEN,
        BETTER_AUTH_TRUSTED_ORIGINS: web, BUBAI_MAX_AGENT_MENTION_HOPS: '2' },
      stdout: Bun.file(path.join(dir, 'server.log')), stderr: 'inherit',
    }));
    await ready(api + '/healthz');
    const signedIn = await registerTestUser(api, 'relay@example.test', 'Relay Tester', 'Relay-Test-Password-42',
      () => readFileSync(path.join(dir, 'server.log'), 'utf8'));
    expect(signedIn.ok).toBe(true);
    async function post(route: string, body: object) {
      const res = await fetch(api + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.ok).toBe(true);
      return res.json();
    }
    const nonce = crypto.randomUUID().slice(0, 8);
    const { channel } = await post('/api/channels', { name: 'live-relay-' + nonce });
    if (mode !== 'relay') {
      const bundle = path.join(dir, 'bub.mjs');
      execFileSync(path.join(root, 'apps/cli/node_modules/.bin/esbuild'), [path.join(root, 'apps/cli/src/index.ts'),
        '--bundle', '--platform=node', '--format=esm', '--target=node22', '--outfile=' + bundle]);
      const bub = (...args: string[]) => execFileSync('node', [bundle, ...args], {
        cwd: dir, env: { ...process.env, BUBAI_URL: api, BUBAI_CONFIG_DIR: dir, BUBAI_TOKEN: 'local-e2e' },
        stdio: ['ignore', 'ignore', 'inherit'], timeout: 30000,
      });
      stopBridge = () => bub('stop');
      bub('start', '--mode', 'direct', '--cli', mode, '--cwd', dir, '--name', 'LiveDirect',
        '--permission', 'read-only', '--channel', channel.id);
    }
    const { participants } = await (await fetch(api + '/api/bootstrap')).json();
    function agent(name: string): Agent {
      const match = participants.find((p: Agent) => p.name === name && (mode !== 'relay' || p.adapterType === 'botmux') && p.status === 'online');
      if (!match) throw new Error('Live agent unavailable: ' + name);
      return match;
    }
    const a = agent(mode === 'relay' ? process.env.E2E_AGENT_A || 'Local Codex 6.2 Sol' : 'LiveDirect');
    const b = mode === 'relay' ? agent(process.env.E2E_AGENT_B || 'Local Codex 6.2 Astra') : undefined;
    if (b) {
      expect(a.id).not.toBe(b.id);
      for (const bot of [a, b]) await post('/api/channels/' + channel.id + '/members', { agentId: bot.id });
    }
    processes.push(Bun.spawn(['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      cwd: path.join(root, 'apps/web'), env: { ...process.env, VITE_SERVER_URL: api }, stdout: 'ignore', stderr: 'inherit',
    }));
    await ready(web);
    const chrome = findChromeBinary();
    if (!chrome) throw new Error('Set CHROME_PATH for the live browser test');
    processes.push(Bun.spawn([chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
      '--remote-debugging-port=' + chromePort, '--user-data-dir=' + path.join(dir, 'chrome'), 'about:blank'], { stdout: 'ignore', stderr: 'ignore' }));
    browser = await CdpSession.connect(chromePort);
    for (const cookie of signedIn.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const equals = pair.indexOf('=');
      await browser.send('Network.setCookie', { url: api, name: pair.slice(0, equals), value: pair.slice(equals + 1), path: '/' });
    }
    await browser.send('Page.navigate', { url: web + '/#channel=' + channel.id });
    await browser.waitFor(() => browser!.eval("document.querySelector('.spike-editor')?.isContentEditable"), 30000);
    await browser.clearComposer();
    await browser.send('Input.insertText', { text: '@' });
    const selector = '[data-mention] [data-completion-id="' + a.id + '"]';
    await browser.clickElement(selector);
    const prompt = !b ? ' Use no tools. Reply only with DIRECT-' + nonce : ' Local relay test ' + nonce + '. Use no tools. Each agent replies with only one line. '
      + 'On the initial message, reply with the literal at sign immediately followed by "' + b.name + '" (omit quotes), then " STEP1-' + nonce + '". '
      + 'On receiving STEP1, mention ' + a.name + ' with the at sign, then STEP2-' + nonce + '. '
      + 'On receiving STEP2, mention ' + b.name + ' with the at sign, then DONE-' + nonce + '.';
    await browser.send('Input.insertText', { text: prompt });
    for (const type of ['keyDown', 'keyUp']) await browser.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const rows = async (): Promise<Row[]> => (await (await fetch(api + '/api/channels/' + channel.id + '/messages')).json()).messages;
    if (!b) {
      const reply = await browser.waitFor(async () => (await rows()).find(r =>
        r.senderId === a.id && r.card && r.card.status !== 'running'), 180000);
      expect(reply.card?.status, reply.content).toBe('completed');
      expect(reply.content.trim()).toBe('DIRECT-' + nonce);
      const selector = '[data-message-id="' + reply.id + '"]';
      await browser.waitFor(() => browser!.eval('document.querySelector(' + JSON.stringify(selector) + ')?.innerText.includes(' + JSON.stringify(reply.content) + ')'));
      return;
    }
    const steps = [[a, b, 'STEP1'], [b, a, 'STEP2'], [a, b, 'DONE']] as const;
    for (const [index, [sender, target, marker]] of steps.entries()) {
      const deadline = Date.now() + 180000;
      let reply: Row | undefined;
      while (Date.now() < deadline) {
        const history = await rows();
        reply = history.filter(r => r.senderRole === 'agent')[index];
        if (reply?.card && reply.card.status !== 'running') break;
        await Bun.sleep(500);
      }
      expect(reply?.card?.status).toBe('completed');
      expect(reply!.senderId).toBe(sender.id);
      expect(reply!.content).toContain('@' + target.name);
      expect(reply!.content).toContain(marker + '-' + nonce);
      expect(reply!.adapterMeta?.agentMentionHop ?? 0).toBe(index);
      expect(reply!.botmuxSessionId).toBeTruthy();
      expect(reply!.card?.summary).toMatch(/^Botmux turn completed/);
      const row = '[data-message-id="' + reply!.id + '"]';
      await browser.waitFor(() => browser!.eval('document.querySelector(' + JSON.stringify(row) + ')?.innerText.includes(' + JSON.stringify(marker + '-' + nonce) + ')'));
      console.log('Browser confirmed', sender.name, marker + '-' + nonce);
    }
    await Bun.sleep(6500);
    const history = await rows();
    expect(history.map(r => r.senderRole)).toEqual(['human', 'agent', 'agent', 'agent']);
    expect(history[0].content).toContain('@' + a.name);
  } finally {
    try { stopBridge?.(); } finally {
      browser?.close();
      for (const child of processes.reverse()) { child.kill(); await child.exited; }
      await rm(dir, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

test.skipIf(process.env.BUBAI_LIVE_RELAY !== '1')('browser message relays through two live Botmux agents and stops at the hop limit', () => runBrowserTurn('relay'), 650000);
for (const cli of ['codex', 'claude'] as const) {
  test.skipIf(!process.env.BUBAI_LIVE_DIRECT?.split(',').includes(cli))('browser mention invokes installed ' + cli, () => runBrowserTurn(cli), 240000);
}
