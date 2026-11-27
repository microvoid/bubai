import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const WEB_URL = process.env.E2E_WEB_URL || 'http://localhost:5173';
const API_URL = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9244);
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'tests/e2e/artifacts/timeline-positioning');

function findChromeBinary(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

class CdpSession {
  private ws: WebSocket;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly consoleErrors: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(JSON.stringify(msg.params.exceptionDetails));
      } else if (msg.method === 'Console.messageAdded' && msg.params.message.level === 'error') {
        this.consoleErrors.push(String(msg.params.message.text));
      }
    };
  }

  static async connect(port: number): Promise<CdpSession> {
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('CDP WebSocket failed to connect'));
          });
          return new CdpSession(ws);
        }
      } catch {
        // Chrome starting up
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Chrome CDP did not become ready on port ${port}`);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Page eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value as T;
  }

  async waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await fn();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error('Timed out waiting for condition in E2E');
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async tapAt(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 1 }],
    });
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  }

  async screenshot(name: string): Promise<void> {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(ARTIFACTS_DIR, name), Buffer.from(data, 'base64'));
  }

  close(): void {
    this.ws.close();
  }
}

async function apiJson<T>(urlPath: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${urlPath}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${init?.method || 'GET'} ${urlPath} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

describe('Timeline & Thread Message Positioning E2E', () => {
  let chrome: ChildProcess | null = null;
  let cdp: CdpSession | null = null;
  let primaryChannelId = '';
  let secondaryChannelId = '';
  let botId = '';
  const seededIds: string[] = [];
  let threadRootId = '';
  const threadReplyIds: string[] = [];

  async function getScrollerMetrics() {
    return cdp!.eval<{
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      distanceFromBottom: number;
      jumpVisible: boolean;
      jumpLabel: string;
    } | null>(`(() => {
      const el = document.querySelector('[data-message-scroller]');
      if (!el) return null;
      const jumpBtn = el.querySelector('button[aria-label*="latest"], button[aria-label*="new message"]')
        || Array.from(el.querySelectorAll('button')).find((b) => /Jump to latest|new message/i.test(b.textContent || ''));
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop,
        jumpVisible: el.hasAttribute('data-jump-visible'),
        jumpLabel: jumpBtn ? (jumpBtn.textContent || '').trim() : '',
      };
    })()`);
  }

  before(async () => {
    // 1. Discover an available bot for posting messages via /api/bot/messages
    const bootstrap = await apiJson<{ participants: Array<{ id: string; role: string }> }>('/api/bootstrap');
    const agent = bootstrap.participants.find((p) => p.role === 'agent');
    assert.ok(agent, 'Need at least one agent participant to seed E2E timeline messages');
    botId = agent.id;

    // 2. Create two temporary channels for switching & positioning tests
    const suffix = Date.now().toString(36);
    const ch1 = await apiJson<{ channel: { id: string } }>('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: `e2e-pos-a-${suffix}`, userId: 'u-owner' }),
    });
    primaryChannelId = ch1.channel.id;

    const ch2 = await apiJson<{ channel: { id: string } }>('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: `e2e-pos-b-${suffix}`, userId: 'u-owner' }),
    });
    secondaryChannelId = ch2.channel.id;

    // 3. Seed 24 tall messages in primaryChannel so the timeline overflows well beyond viewport height
    for (let i = 1; i <= 24; i += 1) {
      const tallBody = [
        `E2E-MSG-${String(i).padStart(2, '0')} timeline positioning verification block.`,
        `Line 2 for message ${i}: testing virtualizer height estimation and stick-to-bottom.`,
        `Line 3 for message ${i}: ensuring tall markdown rows settle accurately.`,
        i >= 20 ? `Extra tall tail block for message ${i}:\n- bullet A\n- bullet B\n- bullet C\n- bullet D` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const posted = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
        method: 'POST',
        body: JSON.stringify({ botId, channelId: primaryChannelId, content: tallBody }),
      });
      seededIds.push(posted.message.id);
    }

    // Seed 1 message in secondaryChannel
    await apiJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({ botId, channelId: secondaryChannelId, content: 'Secondary channel marker' }),
    });

    // Pin message #5 for Pin-jump test
    await apiJson(`/api/channels/${encodeURIComponent(primaryChannelId)}/pins`, {
      method: 'POST',
      body: JSON.stringify({ messageId: seededIds[4], userId: 'u-owner' }),
    });

    // Seed 14 replies under the last message (#24) so the thread sheet overflows vertically
    threadRootId = seededIds[seededIds.length - 1];
    for (let r = 1; r <= 14; r += 1) {
      const reply = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
        method: 'POST',
        body: JSON.stringify({
          botId,
          channelId: primaryChannelId,
          threadId: threadRootId,
          content: `Thread reply #${r}\nSecond line of reply #${r} to make thread scroller overflow.`,
        }),
      });
      threadReplyIds.push(reply.message.id);
    }

    // 4. Launch headless Chrome pointed directly at primaryChannel
    const binary = findChromeBinary();
    assert.ok(binary, 'Chrome binary not found');
    const userDataDir = `/tmp/bubai-e2e-pos-${Date.now()}`;
    chrome = spawn(
      binary,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--window-size=1440,900',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        `${WEB_URL}/#channel=${primaryChannelId}`,
      ],
      { stdio: 'ignore' },
    );
    cdp = await CdpSession.connect(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Console.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await cdp.waitFor(async () => {
      return cdp!.eval<boolean>(
        `Boolean(document.querySelector('[data-message-id="${threadRootId}"]'))`,
      );
    }, 10000);
  });

  after(async () => {
    cdp?.close();
    if (chrome && !chrome.killed) {
      chrome.kill('SIGTERM');
    }
    // Clean up temporary test channels
    for (const id of [primaryChannelId, secondaryChannelId]) {
      if (!id) continue;
      await fetch(`${API_URL}/api/channels/${encodeURIComponent(id)}?userId=u-owner`, {
        method: 'DELETE',
      }).catch(() => undefined);
    }
  });

  it('1. Opening and switching back to a tall channel always lands cleanly at the bottom', async () => {
    const initial = await cdp!.waitFor(async () => {
      const m = await getScrollerMetrics();
      if (!m || m.scrollHeight <= m.clientHeight + 200) return false;
      return m.distanceFromBottom < 80 && !m.jumpVisible ? m : false;
    }, 8000);
    assert.ok(initial.distanceFromBottom < 80, `Expected initial bottom settle, got ${JSON.stringify(initial)}`);

    // Scroll up manually to the very top of primaryChannel
    await cdp!.eval(`(() => {
      const el = document.querySelector('[data-message-scroller]');
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    })()`);
    await cdp!.waitFor(async () => {
      const m = await getScrollerMetrics();
      return m && m.jumpVisible && m.distanceFromBottom > 300 ? m : false;
    }, 5000);

    // Switch to secondaryChannel, then switch back to primaryChannel via hash navigation
    await cdp!.eval(`window.location.hash = '#channel=${secondaryChannelId}'`);
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`document.body.innerText.includes('Secondary channel marker')`);
    }, 6000);

    await cdp!.eval(`window.location.hash = '#channel=${primaryChannelId}'`);
    const afterSwitchBack = await cdp!.waitFor(async () => {
      const m = await getScrollerMetrics();
      if (!m || m.scrollHeight <= m.clientHeight + 200) return false;
      return m.distanceFromBottom < 80 && !m.jumpVisible ? m : false;
    }, 8000);
    assert.ok(
      afterSwitchBack.distanceFromBottom < 80 && !afterSwitchBack.jumpVisible,
      `Switching back should always land at bottom (Option 1), got ${JSON.stringify(afterSwitchBack)}`,
    );
  });

  it('2. Stick-to-bottom follows live new messages AND in-place tall message expansion', async () => {
    // Append a short live message while at bottom
    const live = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: primaryChannelId,
        content: 'Live streaming placeholder...',
      }),
    });

    await cdp!.waitFor(async () => {
      const hasRow = await cdp!.eval<boolean>(
        `Boolean(document.querySelector('[data-message-id="${live.message.id}"]'))`,
      );
      const m = await getScrollerMetrics();
      return hasRow && m && m.distanceFromBottom < 80 && !m.jumpVisible;
    }, 6000);

    // Click and touch-tap inside the message row (not scrolling) to verify pointer/touch on content doesn't break stick-to-bottom
    const livePos = await cdp!.eval<{ x: number; y: number } | null>(`(() => {
      const row = document.querySelector('[data-message-id="${live.message.id}"]');
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(20, r.height / 2) };
    })()`);
    assert.ok(livePos, 'Live message row should be clickable');
    await cdp!.clickAt(livePos.x, livePos.y);
    await cdp!.tapAt(livePos.x, livePos.y);

    // Expand that SAME last message in-place via PATCH into a tall 25-line reply (simulating Agent reply settling)
    const expandedContent = Array.from(
      { length: 25 },
      (_, idx) => `Expanded Agent reply line ${idx + 1}: verifying ResizeObserver stick-to-bottom lock.`,
    ).join('\n\n');
    const patched = await apiJson<{ message: { id: string } }>(
      `/api/messages/${encodeURIComponent(live.message.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content: expandedContent }),
      },
    );
    assert.equal(patched.message.id, live.message.id, 'PATCH must update the same message in-place');

    const afterExpand = await cdp!.waitFor(async () => {
      const hasExpandedText = await cdp!.eval<boolean>(
        `Boolean(document.querySelector('[data-message-id="${live.message.id}"]')?.textContent?.includes('Expanded Agent reply line 25'))`,
      );
      const m = await getScrollerMetrics();
      return hasExpandedText && m && m.distanceFromBottom < 80 && !m.jumpVisible ? m : false;
    }, 3000).catch(async (err) => {
      const diag = await cdp!.eval(`(() => {
        const el = document.querySelector('[data-message-scroller]');
        const row = document.querySelector('[data-message-id="${live.message.id}"]');
        const ol = el?.querySelector(':scope > ol');
        const hit = document.elementFromPoint(${livePos.x}, ${livePos.y});
        return {
          hasRow: Boolean(row),
          hasLine25: Boolean(row?.textContent?.includes('Expanded Agent reply line 25')),
          hasOl: Boolean(ol),
          olHeight: ol?.getBoundingClientRect().height,
          hitTag: hit?.tagName,
          hitIsScroller: hit === el,
          scrollTop: el?.scrollTop,
          scrollHeight: el?.scrollHeight,
          clientHeight: el?.clientHeight,
          dist: el ? el.scrollHeight - el.clientHeight - el.scrollTop : -1,
          jumpVisible: el?.hasAttribute('data-jump-visible'),
        };
      })()`);
      throw new Error(`${err.message} | test2 diag=${JSON.stringify(diag)}`);
    });
    assert.ok(
      afterExpand.distanceFromBottom < 80 && !afterExpand.jumpVisible,
      `Expected timeline to stay pinned to bottom after in-place expansion, got ${JSON.stringify(afterExpand)}`,
    );
  });

  it('3. Scrolling up pauses auto-follow, shows new-message badge on arrival, and Jump to latest restores bottom', async () => {
    // Scroll up away from bottom
    await cdp!.eval(`(() => {
      const el = document.querySelector('[data-message-scroller]');
      el.scrollTop = 100;
      el.dispatchEvent(new Event('scroll'));
    })()`);

    const scrolledUp = await cdp!.waitFor(async () => {
      const m = await getScrollerMetrics();
      return m && m.jumpVisible && m.distanceFromBottom > 300 ? m : false;
    }, 5000);
    const savedScrollTop = scrolledUp.scrollTop;

    // Post a new message while user is reading history
    await apiJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: primaryChannelId,
        content: 'Background message arriving while user reads history',
      }),
    });

    const withBadge = await cdp!.waitFor(async () => {
      const m = await getScrollerMetrics();
      return m && m.jumpVisible && /1 new message/i.test(m.jumpLabel) ? m : false;
    }, 6000);
    assert.ok(
      Math.abs(withBadge.scrollTop - savedScrollTop) < 120,
      `User reading position should not jump to bottom when new message arrives: before=${savedScrollTop}, after=${withBadge.scrollTop}`,
    );

    // Click Jump to latest button
    const btnPos = await cdp!.eval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector('[data-message-scroller]');
      const btn = Array.from(el.querySelectorAll('button')).find((b) => /new message|Jump to latest/i.test(b.textContent || ''));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    assert.ok(btnPos, 'Jump to latest button should be clickable');
    await cdp!.clickAt(btnPos.x, btnPos.y);

    const backAtBottom = await cdp!.waitFor(async () => {
      const m = await getScrollerMetrics();
      return m && m.distanceFromBottom < 80 && !m.jumpVisible ? m : false;
    }, 6000);
    assert.ok(backAtBottom.distanceFromBottom < 80);
  });

  it('4. URL #message= jump and Pin panel jump center & highlight the target message without being hijacked', async () => {
    const urlTargetId = seededIds[2]; // message #3
    await cdp!.eval(`window.location.hash = '#channel=${primaryChannelId}&message=${urlTargetId}'`);

    const urlPositioned = await cdp!.waitFor(async () => {
      return cdp!.eval<{ inView: boolean; jumpVisible: boolean } | null>(`(() => {
        const scroller = document.querySelector('[data-message-scroller]');
        const row = scroller?.querySelector('[data-message-id="${urlTargetId}"]');
        if (!scroller || !row) return null;
        const sr = scroller.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        const inView = rr.bottom > sr.top && rr.top < sr.bottom;
        return inView ? { inView, jumpVisible: scroller.hasAttribute('data-jump-visible') } : null;
      })()`);
    }, 8000).catch(async (err) => {
      const diag = await cdp!.eval(`(() => {
        const scroller = document.querySelector('[data-message-scroller]');
        const ids = Array.from(document.querySelectorAll('[data-message-id]')).map((n) => n.getAttribute('data-message-id'));
        return {
          hash: window.location.hash,
          scrollTop: scroller?.scrollTop,
          scrollHeight: scroller?.scrollHeight,
          clientHeight: scroller?.clientHeight,
          jumpVisible: scroller?.hasAttribute('data-jump-visible'),
          renderedCount: ids.length,
          firstRendered: ids[0],
          lastRendered: ids[ids.length - 1],
          hasTarget: ids.includes('${urlTargetId}'),
        };
      })()`);
      throw new Error(`${err.message} | diag=${JSON.stringify(diag)}`);
    });
    assert.equal(urlPositioned.inView, true, 'URL #message target should be visible in viewport');
    assert.equal(urlPositioned.jumpVisible, true, 'Jump to latest should be visible after jumping to old message');

    // Wait briefly to confirm stick-to-bottom does NOT hijack the focused position back to bottom
    await new Promise((r) => setTimeout(r, 400));
    const stillFocused = await cdp!.eval<boolean>(`(() => {
      const scroller = document.querySelector('[data-message-scroller]');
      const row = scroller?.querySelector('[data-message-id="${urlTargetId}"]');
      if (!scroller || !row) return false;
      const sr = scroller.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      return rr.bottom > sr.top && rr.top < sr.bottom;
    })()`);
    assert.equal(stillFocused, true, 'Stick-to-bottom must not hijack URL messageFocus');

    // Open Pins panel and click pinned message #5
    const pinnedId = seededIds[4];
    const pinsBtn = await cdp!.eval<{ x: number; y: number } | null>(`(() => {
      const btn = document.querySelector('button[aria-label*="Pinned"], button[aria-label*="pin" i]');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    assert.ok(pinsBtn, 'Pins button should be present in channel header');
    await cdp!.clickAt(pinsBtn.x, pinsBtn.y);

    const pinItemPos = await cdp!.waitFor(async () => {
      return cdp!.eval<{ x: number; y: number } | null>(`(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const item = btns.find((el) => (el.textContent || '').includes('E2E-MSG-05'));
        if (!item) return null;
        const r = item.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 5000);
    await cdp!.clickAt(pinItemPos.x, pinItemPos.y);

    const pinPositioned = await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const scroller = document.querySelector('[data-message-scroller]');
        const row = scroller?.querySelector('[data-message-id="${pinnedId}"]');
        if (!scroller || !row) return false;
        const sr = scroller.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        return rr.bottom > sr.top && rr.top < sr.bottom;
      })()`);
    }, 6000);
    assert.equal(pinPositioned, true, 'Pin panel click should jump to pinned message #5');
  });

  it('5. Opening BuzzInlineThreadSheet directly defaults to scrolling to the latest bottom reply', async () => {
    // Jump back to latest so threadRootId (#24) is in view
    await cdp!.eval(`window.location.hash = '#channel=${primaryChannelId}&message=${threadRootId}'`);
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(
        `Boolean(document.querySelector('[data-message-id="${threadRootId}"]'))`,
      );
    }, 6000);

    // Click the replies summary / thread button on threadRootId to open BuzzInlineThreadSheet
    const threadTrigger = await cdp!.waitFor(async () => {
      return cdp!.eval<{ x: number; y: number } | null>(`(() => {
        const root = document.querySelector('[data-message-id="${threadRootId}"]');
        if (!root) return null;
        const btn = Array.from(root.querySelectorAll('button')).find((b) =>
          /14 repl|repl|thread/i.test(b.textContent || b.getAttribute('aria-label') || ''),
        );
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 6000);
    await cdp!.clickAt(threadTrigger.x, threadTrigger.y);

    const lastReplyId = threadReplyIds[threadReplyIds.length - 1];
    const threadMetrics = await cdp!.waitFor(async () => {
      return cdp!.eval<{
        scrollTop: number;
        scrollHeight: number;
        clientHeight: number;
        distanceFromBottom: number;
        lastVisible: boolean;
      } | null>(`(() => {
        const rows = document.querySelector('[data-thread-rows]');
        const scroller = rows?.parentElement;
        const lastRow = rows?.querySelector('[data-message-id="${lastReplyId}"]');
        if (!scroller || !lastRow) return null;
        if (scroller.scrollHeight <= scroller.clientHeight + 20) return null;
        const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        const sr = scroller.getBoundingClientRect();
        const rr = lastRow.getBoundingClientRect();
        const lastVisible = rr.bottom > sr.top && rr.top < sr.bottom;
        if (distanceFromBottom >= 80 || !lastVisible) return null;
        return {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          distanceFromBottom,
          lastVisible,
        };
      })()`);
    }, 8000);

    assert.ok(
      threadMetrics.distanceFromBottom < 80 && threadMetrics.lastVisible,
      `Expected thread sheet to open scrolled to bottom latest reply, got ${JSON.stringify(threadMetrics)}`,
    );
    await cdp!.screenshot('timeline-positioning-verified.png');
    assert.equal(cdp!.consoleErrors.length, 0, `Unexpected console errors: ${cdp!.consoleErrors.join('; ')}`);
  });

  it('6. Thread sheet sticks to bottom on in-place reply expansion and does not yank when user scrolled up', async () => {
    // Post a short placeholder reply in the currently open thread while at bottom
    const liveReply = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: primaryChannelId,
        threadId: threadRootId,
        content: 'Thread Agent thinking placeholder...',
      }),
    });

    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const rows = document.querySelector('[data-thread-rows]');
        const sc = rows?.parentElement;
        if (!sc || !rows?.querySelector('[data-message-id="${liveReply.message.id}"]')) return false;
        return sc.scrollHeight - sc.clientHeight - sc.scrollTop < 80;
      })()`);
    }, 6000);

    // Touch-tap inside the live reply (no scroll) to verify touchStart on content doesn't break thread stick-to-bottom
    const liveReplyPos = await cdp!.eval<{ x: number; y: number } | null>(`(() => {
      const row = document.querySelector('[data-thread-rows] [data-message-id="${liveReply.message.id}"]');
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(16, r.height / 2) };
    })()`);
    assert.ok(liveReplyPos, 'Live thread reply row should be tappable');
    await cdp!.tapAt(liveReplyPos.x, liveReplyPos.y);

    // Expand that SAME reply in-place via PATCH into a tall 24-line Markdown reply (replies.length unchanged)
    const expandedReply = Array.from(
      { length: 24 },
      (_, idx) => `Thread expanded line ${idx + 1}: verifying thread stick-to-bottom on in-place update.`,
    ).join('\n\n');
    const patchedReply = await apiJson<{ message: { id: string } }>(
      `/api/messages/${encodeURIComponent(liveReply.message.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content: expandedReply }),
      },
    );
    assert.equal(patchedReply.message.id, liveReply.message.id, 'PATCH must update the same thread reply in-place');

    const afterThreadExpand = await cdp!.waitFor(async () => {
      return cdp!.eval<{ dist: number; hasLine24: boolean } | null>(`(() => {
        const rows = document.querySelector('[data-thread-rows]');
        const sc = rows?.parentElement;
        const row = rows?.querySelector('[data-message-id="${liveReply.message.id}"]');
        if (!sc || !row) return null;
        const hasLine24 = (row.textContent || '').includes('Thread expanded line 24');
        if (!hasLine24) return null;
        const dist = sc.scrollHeight - sc.clientHeight - sc.scrollTop;
        return dist < 80 ? { dist, hasLine24 } : null;
      })()`);
    }, 3000);
    assert.ok(afterThreadExpand.dist < 80, `Thread should stay at bottom after in-place expansion`);

    // Scroll up inside the thread sheet and post a new reply -> must NOT yank user back to bottom
    await cdp!.eval(`(() => {
      const sc = document.querySelector('[data-thread-rows]')?.parentElement;
      if (sc) {
        sc.scrollTop = 0;
        sc.dispatchEvent(new Event('scroll'));
      }
    })()`);
    await new Promise((r) => setTimeout(r, 150));

    const bgReply = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: primaryChannelId,
        threadId: threadRootId,
        content: 'Background thread reply while user reads top of thread',
      }),
    });

    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(
        `Boolean(document.querySelector('[data-thread-rows] [data-message-id="${bgReply.message.id}"]'))`,
      );
    }, 6000);
    await new Promise((r) => setTimeout(r, 200));

    const threadTopAfterBg = await cdp!.eval<number>(`(() => {
      const sc = document.querySelector('[data-thread-rows]')?.parentElement;
      return sc ? sc.scrollTop : -1;
    })()`);
    assert.ok(
      threadTopAfterBg < 120,
      `Thread sheet should not yank user to bottom while scrolled up (scrollTop=${threadTopAfterBg})`,
    );
  });

  it('7. Reopening a thread normally after a deep-linked reply jump clears stale replyFocus and scrolls to bottom', async () => {
    const oldReplyId = threadReplyIds[1]; // 2nd reply near top of thread
    await cdp!.eval(`window.location.hash = '#channel=${primaryChannelId}&message=${oldReplyId}'`);

    // Wait until deep-linked reply is highlighted inside the thread sheet
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const row = document.querySelector('[data-thread-rows] [data-message-id="${oldReplyId}"]');
        return Boolean(row && row.hasAttribute('data-message-highlighted'));
      })()`);
    }, 8000);

    // Close the thread sheet via the Close thread button
    const closeBtn = await cdp!.waitFor(async () => {
      return cdp!.eval<{ x: number; y: number } | null>(`(() => {
        const btn = document.querySelector('button[aria-label="Close thread"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 5000);
    await cdp!.clickAt(closeBtn.x, closeBtn.y);

    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`!document.querySelector('[data-thread-rows]')`);
    }, 5000);

    // Reopen the same thread normally by clicking the replies count button on threadRootId
    const reopenTrigger = await cdp!.waitFor(async () => {
      return cdp!.eval<{ x: number; y: number } | null>(`(() => {
        const root = document.querySelector('[data-message-id="${threadRootId}"]');
        if (!root) return null;
        const btn = Array.from(root.querySelectorAll('button')).find((b) =>
          /\\d+\\s+repl/i.test((b.textContent || '').trim()),
        );
        if (!btn) return null;
        btn.scrollIntoView({ block: 'center' });
        const r = btn.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 6000);
    await cdp!.clickAt(reopenTrigger.x, reopenTrigger.y);

    // Wait for thread rows to render and settle, then assert stale highlight is cleared and scrolled to bottom
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const rows = document.querySelector('[data-thread-rows]');
        const sc = rows?.parentElement;
        return Boolean(sc && sc.scrollHeight > sc.clientHeight + 20);
      })()`);
    }, 6000).catch(async (err) => {
      const diag = await cdp!.eval(`(() => {
        const root = document.querySelector('[data-message-id="${threadRootId}"]');
        const btn = root && Array.from(root.querySelectorAll('button')).find((b) => /\\d+\\s+repl/i.test((b.textContent || '').trim()));
        const hit = btn ? document.elementFromPoint(btn.getBoundingClientRect().left + btn.getBoundingClientRect().width / 2, btn.getBoundingClientRect().top + btn.getBoundingClientRect().height / 2) : null;
        return {
          hasRoot: Boolean(root),
          btnText: btn?.textContent?.trim(),
          btnRect: btn?.getBoundingClientRect(),
          hitTag: hit?.tagName,
          hitClass: hit?.className,
          hitText: hit?.textContent?.slice(0, 40),
          hasThreadRows: Boolean(document.querySelector('[data-thread-rows]')),
        };
      })()`);
      throw new Error(`${err.message} | test7 diag=${JSON.stringify(diag)}`);
    });
    await new Promise((r) => setTimeout(r, 300));

    const reopenState = await cdp!.eval<{
      oldHighlighted: boolean;
      distanceFromBottom: number;
      scrollTop: number;
    }>(`(() => {
      const rows = document.querySelector('[data-thread-rows]');
      const sc = rows?.parentElement;
      const oldRow = rows?.querySelector('[data-message-id="${oldReplyId}"]');
      return {
        oldHighlighted: Boolean(oldRow && oldRow.hasAttribute('data-message-highlighted')),
        distanceFromBottom: sc ? sc.scrollHeight - sc.clientHeight - sc.scrollTop : -1,
        scrollTop: sc ? sc.scrollTop : -1,
      };
    })()`);

    assert.equal(
      reopenState.oldHighlighted,
      false,
      `Stale replyFocus should be cleared on reopen, got ${JSON.stringify(reopenState)}`,
    );
    assert.ok(
      reopenState.distanceFromBottom < 80,
      `Reopened thread should scroll to bottom latest reply, got ${JSON.stringify(reopenState)}`,
    );
  });
});
