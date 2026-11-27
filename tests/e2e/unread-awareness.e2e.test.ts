import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const WEB_URL = process.env.E2E_WEB_URL || 'http://localhost:5173';
const API_URL = process.env.E2E_API_URL || 'http://127.0.0.1:4000';
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9245);
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'tests/e2e/artifacts/unread-awareness');

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

describe('Channel & Thread Unread Awareness E2E', () => {
  let chrome: ChildProcess | null = null;
  let cdp: CdpSession | null = null;
  let channelAId = '';
  let channelBId = '';
  let botId = '';
  let channelBRootId = '';

  before(async () => {
    const bootstrap = await apiJson<{ participants: Array<{ id: string; role: string }> }>('/api/bootstrap');
    const agent = bootstrap.participants.find((p) => p.role === 'agent');
    assert.ok(agent, 'Need at least one agent participant');
    botId = agent.id;

    const suffix = Date.now().toString(36);
    const chA = await apiJson<{ channel: { id: string } }>('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: `e2e-unread-a-${suffix}`, userId: 'u-owner' }),
    });
    channelAId = chA.channel.id;

    const chB = await apiJson<{ channel: { id: string } }>('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: `e2e-unread-b-${suffix}`, userId: 'u-owner' }),
    });
    channelBId = chB.channel.id;

    // Seed initial messages and mark both channels read so we start from a clean read state
    await apiJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({ botId, channelId: channelAId, content: 'Channel A baseline message' }),
    });
    const rootB = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({ botId, channelId: channelBId, content: 'Channel B thread root message' }),
    });
    channelBRootId = rootB.message.id;

    await apiJson(`/api/channels/${encodeURIComponent(channelAId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ userId: 'u-owner', includeThreads: true }),
    });
    await apiJson(`/api/channels/${encodeURIComponent(channelBId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ userId: 'u-owner', includeThreads: true }),
    });

    const binary = findChromeBinary();
    assert.ok(binary, 'Chrome binary not found');
    const userDataDir = `/tmp/bubai-e2e-unread-${Date.now()}`;
    chrome = spawn(
      binary,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--window-size=1440,900',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        `${WEB_URL}/#channel=${channelAId}`,
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
        `Boolean(document.querySelector('[data-channel-id="${channelBId}"]')) && document.body.innerText.includes('Channel A baseline message')`,
      );
    }, 10000);
  });

  after(async () => {
    cdp?.close();
    if (chrome && !chrome.killed) {
      chrome.kill('SIGTERM');
    }
    for (const id of [channelAId, channelBId]) {
      if (!id) continue;
      await fetch(`${API_URL}/api/channels/${encodeURIComponent(id)}?userId=u-owner`, {
        method: 'DELETE',
      }).catch(() => undefined);
    }
  });

  it('1. Cross-channel top-level message highlights sidebar row, shows badge, and updates document.title', async () => {
    await apiJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({ botId, channelId: channelBId, content: 'New top-level message in B' }),
    });

    const rowState = await cdp!.waitFor(async () => {
      return cdp!.eval<{ unread: boolean; badgeText: string; title: string } | null>(`(() => {
        const row = document.querySelector('[data-channel-id="${channelBId}"]');
        if (!row) return null;
        const navItem = row.querySelector('.navigation-item');
        const unread = navItem?.hasAttribute('data-unread') ?? false;
        const badge = row.querySelector('.buzz-count-badge');
        const badgeText = badge ? (badge.textContent || '').trim() : '';
        if (!unread || badgeText !== '1') return null;
        return { unread, badgeText, title: document.title };
      })()`);
    }, 6000);

    assert.equal(rowState.unread, true);
    assert.equal(rowState.badgeText, '1');
    assert.match(rowState.title, /^\(\d+\) BubAI$/);
  });

  it('2. Cross-channel thread reply lights up sidebar thread badge, persists on channel open, and clears when opening thread', async () => {
    // Post a thread reply in Channel B while still viewing Channel A
    await apiJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: channelBId,
        threadId: channelBRootId,
        content: 'Unread thread reply from another channel',
      }),
    });

    // Switch into Channel B -> top-level unread clears, but thread unread MUST remain visible!
    await cdp!.eval(`(() => {
      const row = document.querySelector('[data-channel-id="${channelBId}"] .navigation-item');
      row?.click();
    })()`);

    const threadSummaryState = await cdp!.waitFor(async () => {
      return cdp!.eval<{
        hasThreadUnreadDot: boolean;
        summaryText: string;
        sidebarHasThreadBadge: boolean;
      } | null>(`(() => {
        const root = document.querySelector('[data-message-id="${channelBRootId}"]');
        const summary = root?.querySelector('[data-thread-summary]');
        if (!summary) return null;
        const hasThreadUnreadDot = summary.getAttribute('data-thread-unread') === 'true';
        const summaryText = (summary.textContent || '').trim();
        const sidebarRow = document.querySelector('[data-channel-id="${channelBId}"]');
        const sidebarHasThreadBadge = Boolean(sidebarRow?.querySelector('[data-thread-unread-badge="true"]'));
        if (!hasThreadUnreadDot || !/1 new/i.test(summaryText)) return null;
        return { hasThreadUnreadDot, summaryText, sidebarHasThreadBadge };
      })()`);
    }, 8000);

    assert.equal(threadSummaryState.hasThreadUnreadDot, true);
    assert.match(threadSummaryState.summaryText, /1 new/i);
    assert.equal(threadSummaryState.sidebarHasThreadBadge, true);
    await cdp!.screenshot('thread-unread-indicator.png');

    // Click the thread summary button -> opens thread and clears thread unread
    const summaryPos = await cdp!.eval<{ x: number; y: number } | null>(`(() => {
      const summary = document.querySelector('[data-message-id="${channelBRootId}"] [data-thread-summary]');
      if (!summary) return null;
      const r = summary.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    assert.ok(summaryPos, 'Thread summary button should be clickable');
    await cdp!.clickAt(summaryPos.x, summaryPos.y);

    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const summary = document.querySelector('[data-message-id="${channelBRootId}"] [data-thread-summary]');
        const sidebarRow = document.querySelector('[data-channel-id="${channelBId}"]');
        return Boolean(summary)
          && !summary.hasAttribute('data-thread-unread')
          && !sidebarRow?.querySelector('[data-thread-unread-badge="true"]');
      })()`);
    }, 6000);

    // Verify server-side persistence via /api/bootstrap (threadUnreadCount === 0)
    const afterBootstrap = await apiJson<{ channels: Array<{ id: string; threadUnreadCount?: number }> }>(
      '/api/bootstrap?userId=u-owner',
    );
    const chBAfter = afterBootstrap.channels.find((c) => c.id === channelBId);
    assert.equal(chBAfter?.threadUnreadCount ?? 0, 0, 'thread_reads should persist cleared unread on server');
  });

  it('3. Live thread reply in active channel (with thread closed) lights up thread summary red dot', async () => {
    // Close the thread sheet first
    await cdp!.eval(`(() => {
      const closeBtn = document.querySelector('button[aria-label="Close thread"]');
      closeBtn?.click();
    })()`);
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`!document.querySelector('[data-thread-rows]')`);
    }, 5000);

    // Post another reply in that thread while viewing Channel B
    await apiJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: channelBId,
        threadId: channelBRootId,
        content: 'Second live thread reply while thread is closed',
      }),
    });

    const liveUnread = await cdp!.waitFor(async () => {
      return cdp!.eval<{ text: string; unread: boolean } | null>(`(() => {
        const summary = document.querySelector('[data-message-id="${channelBRootId}"] [data-thread-summary]');
        if (!summary) return null;
        const unread = summary.getAttribute('data-thread-unread') === 'true';
        const text = (summary.textContent || '').trim();
        return unread && /1 new/i.test(text) ? { text, unread } : null;
      })()`);
    }, 6000);

    assert.equal(liveUnread.unread, true);
    assert.match(liveUnread.text, /1 new/i);

    // P1: Channel header unread threads quick-jump dropdown should appear and open the thread
    const headerTrigger = await cdp!.waitFor(async () => {
      return cdp!.eval<{ text: string; x: number; y: number } | null>(`(() => {
        const btn = document.querySelector('[data-unread-threads-trigger="true"]');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { text: (btn.textContent || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 5000);
    assert.match(headerTrigger.text, /1 unread thread/i);
    await cdp!.clickAt(headerTrigger.x, headerTrigger.y);

    const jumpItem = await cdp!.waitFor(async () => {
      return cdp!.eval<{ x: number; y: number } | null>(`(() => {
        const item = document.querySelector('[data-unread-thread-jump="${channelBRootId}"]');
        if (!item) return null;
        const r = item.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 5000);
    await cdp!.clickAt(jumpItem.x, jumpItem.y);

    // Clicking the unread-thread jump item should open the thread sheet and clear the unread trigger
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(
        `Boolean(document.querySelector('[data-thread-rows]')) && !document.querySelector('[data-unread-threads-trigger="true"]')`,
      );
    }, 6000);
  });

  it('4. P1 @mention red badge in sidebar + Activity panel aggregates mentions and jumps on click', async () => {
    // Switch back to Channel A
    await cdp!.eval(`(() => {
      const row = document.querySelector('[data-channel-id="${channelAId}"] .navigation-item');
      row?.click();
    })()`);
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`document.body.innerText.includes('Channel A baseline message')`);
    }, 6000);

    // Post an @all mention in Channel B while viewing Channel A
    const mentionMsg = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: channelBId,
        content: '@all please review this P1 mention alert',
      }),
    });

    // Verify red @1 mention badge appears on Channel B in the sidebar
    const mentionBadgeText = await cdp!.waitFor(async () => {
      return cdp!.eval<string | null>(`(() => {
        const row = document.querySelector('[data-channel-id="${channelBId}"]');
        const badge = row?.querySelector('[data-mention-badge="true"]');
        return badge ? (badge.textContent || '').trim() : null;
      })()`);
    }, 6000);
    assert.equal(mentionBadgeText, '@1');

    // Open Activity panel from sidebar top
    const activityNavPos = await cdp!.eval<{ x: number; y: number } | null>(`(() => {
      const nav = document.querySelector('[data-activity-nav="true"]');
      if (!nav) return null;
      const r = nav.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    assert.ok(activityNavPos, 'Activity nav item should be visible in sidebar');
    await cdp!.clickAt(activityNavPos.x, activityNavPos.y);

    // Verify mention item appears in Activity panel and clicking it jumps to Channel B
    const activityItemPos = await cdp!.waitFor(async () => {
      return cdp!.eval<{ x: number; y: number } | null>(`(() => {
        const item = document.querySelector('[data-activity-panel="true"] [data-activity-message-id="${mentionMsg.message.id}"]');
        if (!item) return null;
        const r = item.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 6000);
    await cdp!.screenshot('activity-panel-mention.png');
    await cdp!.clickAt(activityItemPos.x, activityItemPos.y);

    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(
        `Boolean(document.querySelector('[data-message-id="${mentionMsg.message.id}"]')) && !document.querySelector('[data-activity-panel="true"]')`,
      );
    }, 6000);
    assert.equal(cdp!.consoleErrors.length, 0, `Unexpected console errors: ${cdp!.consoleErrors.join('; ')}`);
  });

  it('5. P1 Activity filter tabs (@Mentions / Threads) and @username mention work end-to-end', async () => {
    // Switch back to Channel A
    await cdp!.eval(`(() => {
      const row = document.querySelector('[data-channel-id="${channelAId}"] .navigation-item');
      row?.click();
    })()`);
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`document.body.innerText.includes('Channel A baseline message')`);
    }, 6000);

    // Fetch current u-owner display name so we test exact @<username> mention matching
    const bootstrap = await apiJson<{ participants: Array<{ id: string; name: string }> }>(
      '/api/bootstrap?userId=u-owner',
    );
    const ownerName = bootstrap.participants.find((p) => p.id === 'u-owner')?.name || '许星';

    // Post both an @<ownerName> top-level mention AND a thread reply in Channel B
    const directMention = await apiJson<{ message: { id: string } }>('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: channelBId,
        content: `@${ownerName} 请确认这条直接点名消息`,
      }),
    });
    await apiJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        channelId: channelBId,
        threadId: channelBRootId,
        content: 'Unread thread reply for Activity Threads filter verification',
      }),
    });

    // Open Activity panel
    const activityNavPos = await cdp!.waitFor(async () => {
      return cdp!.eval<{ x: number; y: number } | null>(`(() => {
        const nav = document.querySelector('[data-activity-nav="true"]');
        if (!nav) return null;
        const r = nav.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }, 5000);
    await cdp!.clickAt(activityNavPos.x, activityNavPos.y);

    // Wait for both mention and thread items to appear in Activity panel
    await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const panel = document.querySelector('[data-activity-panel="true"]');
        if (!panel) return false;
        const hasMention = Boolean(panel.querySelector('[data-activity-item="mention"][data-activity-message-id="${directMention.message.id}"]'));
        const hasThread = Boolean(panel.querySelector('[data-activity-item="thread"][data-activity-channel-id="${channelBId}"]'));
        return hasMention && hasThread;
      })()`);
    }, 6000);

    // Click "@Mentions" filter tab -> only mention items should be shown
    await cdp!.eval(`(() => {
      const panel = document.querySelector('[data-activity-panel="true"]');
      const btn = Array.from(panel?.querySelectorAll('button') || []).find((b) => /@Mentions/.test(b.textContent || ''));
      btn?.click();
    })()`);
    const mentionTabOk = await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const panel = document.querySelector('[data-activity-panel="true"]');
        if (!panel) return false;
        const mentions = panel.querySelectorAll('[data-activity-item="mention"]').length;
        const threads = panel.querySelectorAll('[data-activity-item="thread"]').length;
        return mentions >= 1 && threads === 0;
      })()`);
    }, 4000);
    assert.equal(mentionTabOk, true);

    // Click "Threads" filter tab -> only thread items should be shown
    await cdp!.eval(`(() => {
      const panel = document.querySelector('[data-activity-panel="true"]');
      const btn = Array.from(panel?.querySelectorAll('button') || []).find((b) => /^Threads/.test((b.textContent || '').trim()));
      btn?.click();
    })()`);
    const threadTabOk = await cdp!.waitFor(async () => {
      return cdp!.eval<boolean>(`(() => {
        const panel = document.querySelector('[data-activity-panel="true"]');
        if (!panel) return false;
        const mentions = panel.querySelectorAll('[data-activity-item="mention"]').length;
        const threads = panel.querySelectorAll('[data-activity-item="thread"]').length;
        return threads >= 1 && mentions === 0;
      })()`);
    }, 4000);
    assert.equal(threadTabOk, true);

    // Mark Channel B as read (includeThreads: true) and verify bootstrap clears unreadCount, threadUnreadCount & mentionCount
    await apiJson(`/api/channels/${encodeURIComponent(channelBId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ userId: 'u-owner', includeThreads: true }),
    });
    const afterClear = await apiJson<{
      channels: Array<{ id: string; unreadCount: number; threadUnreadCount?: number; mentionCount?: number }>;
    }>('/api/bootstrap?userId=u-owner');
    const chB = afterClear.channels.find((c) => c.id === channelBId);
    assert.equal(chB?.unreadCount ?? 0, 0);
    assert.equal(chB?.threadUnreadCount ?? 0, 0);
    assert.equal(chB?.mentionCount ?? 0, 0);
    assert.equal(cdp!.consoleErrors.length, 0, `Unexpected console errors: ${cdp!.consoleErrors.join('; ')}`);
  });
});
