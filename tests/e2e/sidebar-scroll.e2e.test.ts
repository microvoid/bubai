import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const WEB_DIR = resolve(import.meta.dir, '../../apps/web');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

async function waitFor<T>(read: () => Promise<T | null | false> | T | null | false, label: string) {
  const deadline = Date.now() + 8000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

function startFixtureApi() {
  const user = { id: 'u-owner', name: 'Sidebar Viewer', email: 'sidebar@example.test' };
  const organization = { id: 'sidebar-fixture', name: 'Workspace', slug: 'workspace' };
  const agents = Array.from({ length: 24 }, (_, index) => ({
    id: `agent-${index + 1}`,
    name: `Sidebar Agent ${index + 1}`,
    role: 'agent',
    status: 'online',
  }));
  const channels = ['general', 'design'].map((id) => ({
    id, name: id, kind: 'channel', topic: '', unreadCount: 0, createdAt: 1,
  }));
  const history = (channelId: string) => ({
    messages: Array.from({ length: 50 }, (_, index) => ({
      id: channelId + '-' + index, channelId, senderId: agents[0]!.id, senderRole: 'agent',
      content: 'Reply ' + index + ' in ' + channelId, createdAt: Date.now() - (50 - index) * 60000,
    })),
    hasMore: false,
  });
  const responses = new Map<string, unknown>([
    ['/api/instance', { name: 'Bubai', authRequired: false }],
    ['/api/auth/get-session', { user, session: { activeOrganizationId: organization.id } }],
    ['/api/auth/organization/list', [organization]],
    ['/api/channels/general/messages', history('general')],
    ['/api/channels/design/messages', history('design')],
    ['/api/channels/design/members', { members: [] }],
    ['/api/channels/general/members', { members: [] }],
    ['/api/activity', { items: [] }],
    ['/api/bootstrap', {
      channels,
      participants: [...agents, { id: 'archived-agent', name: 'Old Sidebar Agent', role: 'agent', archived: true }],
      sessions: [],
      asks: [],
    }],
  ]);
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === '/ws' && server.upgrade(request)) return;
      return Response.json(responses.get(pathname) ?? null, {
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('origin') ?? 'null',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') ?? '',
        },
      });
    },
    websocket: { message() {} },
  });
}

async function connectChrome(port: string) {
  const page = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    const pages = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    return pages.find(({ type }) => type === 'page') ?? null;
  }, 'Chrome blank page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((accept, reject) => {
    socket.onopen = () => accept();
    socket.onerror = () => reject(new Error('Could not connect to Chrome'));
  });

  let requestId = 0;
  async function send(method: string, params: Record<string, unknown> = {}) {
    const id = ++requestId;
    return await new Promise<any>((accept, reject) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        if (message.error) reject(new Error(message.error.message));
        else accept(message.result);
      };
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    send,
    close: () => socket.close(),
    async evaluate<T>(expression: string): Promise<T> {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    async click({ x, y }: { x: number; y: number }) {
      const mouse = { x, y, button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed' });
      await send('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' });
    },
  };
}

type SidebarGeometry = {
  scrollTop: number;
  maxScroll: number;
  headerTop: number;
  footerTop: number;
  listBottom: number;
  lastTop: number;
  lastBottom: number;
  archive: { x: number; y: number; expanded: boolean; count: string; controlsVisible: boolean };
  profile: { x: number; y: number };
  wheelPoint: { x: number; y: number };
};

const geometry = `(() => {
  const sidebar = document.querySelector('aside[aria-label="Workspace navigation"]');
  const scroll = sidebar?.querySelector('[data-sidebar-scrollport]');
  const header = sidebar?.querySelector('.panel-header');
  const profile = sidebar?.querySelector('[data-profile-trigger]');
  const archive = Array.from(scroll?.querySelectorAll('button[aria-controls][aria-expanded]') ?? [])
    .find((button) => button.querySelector('.navigation-item-label')?.textContent === '已归档');
  const controls = archive && document.getElementById(archive.getAttribute('aria-controls'));
  if (!scroll || !header || !profile || !archive || !controls) return null;
  const list = scroll.getBoundingClientRect();
  const footer = profile.parentElement.getBoundingClientRect();
  const disclosure = archive.getBoundingClientRect();
  const last = (controls.querySelector('button') ?? archive).getBoundingClientRect();
  const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  return {
    scrollTop: scroll.scrollTop,
    maxScroll: scroll.scrollHeight - scroll.clientHeight,
    headerTop: header.getBoundingClientRect().top,
    footerTop: footer.top,
    listBottom: list.bottom,
    lastTop: last.top,
    lastBottom: last.bottom,
    archive: {
      ...center(disclosure),
      count: archive.querySelector('.navigation-item-trailing')?.textContent.trim(),
      expanded: archive.getAttribute('aria-expanded') === 'true',
      controlsVisible: !controls.hidden && controls.textContent.includes('Old Sidebar Agent'),
    },
    profile: center(profile.getBoundingClientRect()),
    wheelPoint: center(list),
  };
})()`;

test('workspace sidebar scrolls above the account footer and keeps archived agents reachable', async (t) => {
  const chromePath = CHROME_CANDIDATES.find((entry): entry is string => !!entry && existsSync(entry));
  assert.ok(chromePath, 'Install Chrome or set CHROME_PATH to run browser E2E tests');
  const tempDir = mkdtempSync(join(tmpdir(), 'bubai-sidebar-e2e-'));
  const profileDir = join(tempDir, 'chrome');
  const api = startFixtureApi();
  let web: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof connectChrome>> | undefined;
  t.after(() => {
    browser?.close();
    chrome?.kill('SIGKILL');
    web?.kill();
    api.stop(true);
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Ask the OS for a free port before spawning the Vite dev server.
  const socket = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const webPort = socket.port;
  socket.stop();
  const address = `http://127.0.0.1:${webPort}/`;
  web = spawn('node', ['--input-type=module', '-e', `
    import { createServer } from './node_modules/vite/dist/node/index.js';
    const vite = await createServer({
      cacheDir: process.argv[1],
      logLevel: 'error',
      server: { host: '127.0.0.1', port: Number(process.argv[2]), strictPort: true, watch: null, hmr: false },
    });
    await vite.listen();
  `, join(tempDir, 'vite'), String(webPort)], {
    cwd: WEB_DIR,
    env: { ...process.env, VITE_SERVER_URL: api.url.origin },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let webError = '';
  web.stderr?.on('data', (data) => { webError += String(data); });
  await waitFor(async () => {
    assert.equal(web?.exitCode, null, `Vite stopped early: ${webError}`);
    return (await fetch(address).catch(() => null))?.ok ?? false;
  }, 'Vite to listen on loopback');

  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profileDir, 'DevToolsActivePort');
  const port = await waitFor(() => {
    if (!existsSync(portFile)) return null;
    return readFileSync(portFile, 'utf8').split('\n')[0] || null;
  }, 'Chrome debugging port');
  const page = await connectChrome(port);
  browser = page;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 450, deviceScaleFactor: 1, mobile: false,
  });
  await page.send('Page.navigate', { url: address });

  const toggle = 'button[aria-controls="workspace-navigation"]';
  for (const width of [320, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await waitFor(() => page.evaluate<boolean>(`document.querySelector('main')?.clientWidth >= ${width} - 24`), 'full-width conversation');
    assert.equal(await page.evaluate<number>("document.getElementById('workspace-navigation').clientWidth"), 0);
    await page.evaluate(`document.querySelector('${toggle}').click()`);
    await waitFor(() => page.evaluate<boolean>(`document.getElementById('workspace-navigation').clientWidth >= ${width} - 24`), 'full-width channel list');
    const channel = width === 320 ? 'design' : 'general';
    assert.ok(await page.evaluate<boolean>("document.querySelector('[data-message-scroller]').clientHeight > 0"));
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-channel-id="${channel}"] button')`), 'channel list loaded');
    await page.evaluate(`document.querySelector('[data-channel-id="${channel}"] button').click()`);
    await waitFor(() => page.evaluate<boolean>(`document.querySelector('${toggle}').getAttribute('aria-expanded') === 'false'`), 'channel selection to return to chat');
    await waitFor(() => page.evaluate<boolean>(`(() => {
      const row = document.querySelector('[data-message-id="${channel}-49"]');
      const viewport = document.querySelector('[data-message-scroller]').getBoundingClientRect();
      if (!row || getComputedStyle(row).visibility !== 'visible') return false;
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.bottom <= viewport.bottom + 1 && rect.top >= viewport.top;
    })()`), 'latest message visible without a scroll gesture');
    await page.evaluate(`document.querySelector('[data-activity-nav]').click()`);
    await waitFor(() => page.evaluate<boolean>(`document.querySelector('[data-pane="activity"]')?.clientWidth >= ${width} - 24`), 'full-width Activity');
    await page.evaluate(`document.querySelector('[data-activity-nav]').click()`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 450, deviceScaleFactor: 1, mobile: false,
  });

  const read = () => page.evaluate<SidebarGeometry | null>(geometry);
  const initial = await waitFor(read, 'sidebar fixture rows');
  assert.ok(initial.maxScroll > 150, 'The fixture should overflow the short viewport');
  assert.equal(initial.scrollTop, 0);
  assert.equal(initial.archive.expanded, false);
  assert.equal(initial.archive.count, '1');
  assert.equal(initial.archive.controlsVisible, false);
  assert.ok(initial.listBottom <= initial.footerTop + 1, 'List viewport must end before the account footer');

  async function wheelToEnd() {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', ...initial.wheelPoint, deltaX: 0, deltaY: 2400,
    });
    const end = await waitFor(async () => {
      const current = await read();
      return current && current.scrollTop > 0 && current.maxScroll - current.scrollTop < 2 && current;
    }, 'sidebar to scroll to its end');
    assert.equal(end.headerTop, initial.headerTop, 'Header should stay fixed while the list scrolls');
    assert.equal(end.footerTop, initial.footerTop, 'Account footer should stay fixed while the list scrolls');
    assert.ok(end.lastBottom < end.footerTop - 1, 'The last row should sit fully above the footer with clearance');
    assert.ok(end.lastTop < end.lastBottom, 'The last row should have visible height');
    return end;
  }

  const collapsed = await wheelToEnd();
  await page.click(collapsed.archive);
  await waitFor(async () => {
    const current = await read();
    return current && current.archive.expanded && current.archive.controlsVisible;
  }, 'archived agents to expand');
  const expanded = await wheelToEnd();
  assert.ok(expanded.maxScroll > collapsed.maxScroll, 'Archived rows should add to the same scrollport');
  await page.click(expanded.archive);
  await waitFor(async () => {
    const current = await read();
    return current && !current.archive.expanded && !current.archive.controlsVisible;
  }, 'archived agents to collapse');

  await page.click(expanded.profile);
  await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-profile-menu][data-open]")'), 'account menu to open');
});
