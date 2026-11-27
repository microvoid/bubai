import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const WEB_URL = process.env.E2E_WEB_URL || 'http://localhost:5173';
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9243);
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'tests/e2e/artifacts/thread-sheet');

function findChromeBinary(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
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

  async pressEscape(): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
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

describe('Thread Reply Sheet & Emoji Picker State E2E', () => {
  let chrome: ChildProcess | null = null;
  let cdp: CdpSession | null = null;

  before(async () => {
    const binary = findChromeBinary();
    assert.ok(binary, 'Chrome binary not found');
    const userDataDir = `/tmp/bubai-e2e-thread-${Date.now()}`;
    chrome = spawn(
      binary,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--window-size=1440,900',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        WEB_URL,
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
      return cdp!.eval<boolean>(`Boolean(document.querySelector('[data-message-id]'))`);
    }, 10000);
  });

  after(() => {
    cdp?.close();
    chrome?.kill('SIGKILL');
  });

  it('reproduces / verifies thread sheet opening, emoji reaction interaction, Escape layering, and closing lifecycle', async () => {
    const session = cdp!;

    // Install instrumentation probe for ComposerSheet DOM lifecycle, animations, and geometry
    await session.eval(`(() => {
      const probe = {
        sheetMounts: 0,
        sheetUnmounts: 0,
        endingStyleSeen: false,
        animateCalls: [],
        initialOpenHadRoot: null,
        heightSamples: [],
      };
      const origAnimate = HTMLElement.prototype.animate;
      HTMLElement.prototype.animate = function(keyframes, options) {
        if (this.hasAttribute('data-details-sheet-surface')) {
          probe.animateCalls.push({
            t: Math.round(performance.now()),
            keyframes,
            duration: options?.duration,
            fill: options?.fill,
          });
        }
        return origAnimate.call(this, keyframes, options);
      };

      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLElement) {
              const sheet = node.matches('[data-details-sheet-surface]')
                ? node
                : node.querySelector('[data-details-sheet-surface]');
              if (sheet) {
                probe.sheetMounts += 1;
                if (probe.initialOpenHadRoot === null) {
                  const rows = sheet.querySelectorAll('[data-thread-rows] [data-message-id]').length;
                  probe.initialOpenHadRoot = rows > 0;
                }
              }
            }
          }
          for (const node of m.removedNodes) {
            if (node instanceof HTMLElement) {
              const sheet = node.matches('[data-details-sheet-surface]')
                ? node
                : node.querySelector('[data-details-sheet-surface]');
              if (sheet) {
                probe.sheetUnmounts += 1;
              }
            }
          }
          if (m.type === 'attributes' && m.target instanceof HTMLElement &&
              m.target.hasAttribute('data-details-sheet-surface') &&
              m.target.hasAttribute('data-ending-style')) {
            probe.endingStyleSeen = true;
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ending-style'] });
      window.__threadProbe = probe;
    })()`);

    // 1. Click "Reply in thread" on the last message in main timeline
    const clickedReply = await session.eval<boolean>(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-message-scroller] [data-message-id]'));
      const row = rows[rows.length - 1];
      const btn = row?.querySelector('button[aria-label="Reply in thread"]');
      if (!(btn instanceof HTMLElement)) return false;
      btn.click();
      return true;
    })()`);
    assert.ok(clickedReply, 'Reply in thread button should exist on timeline message');

    await session.waitFor(async () => {
      return session.eval<boolean>(`Boolean(document.querySelector('[data-details-sheet-surface] [data-thread-rows] [data-message-id]'))`);
    }, 5000);
    await new Promise((r) => setTimeout(r, 320));
    await session.screenshot('01-thread-opened.png');

    // Record baseline animate count and sheet element reference
    const beforeEmoji = await session.eval<{
      animateCount: number;
      sheetHeight: number;
      initialOpenHadRoot: boolean | null;
      sheetMounts: number;
    }>(`(() => {
      const sheet = document.querySelector('[data-details-sheet-surface]');
      window.__sheetEl = sheet;
      return {
        animateCount: window.__threadProbe.animateCalls.length,
        sheetHeight: Math.round(sheet.getBoundingClientRect().height),
        initialOpenHadRoot: window.__threadProbe.initialOpenHadRoot,
        sheetMounts: window.__threadProbe.sheetMounts,
      };
    })()`);

    // 2. Click "Add reaction" inside open thread sheet
    const clickedReaction = await session.eval<boolean>(`(() => {
      const sheet = document.querySelector('[data-details-sheet-surface]');
      const btn = sheet?.querySelector('button[aria-label="Add reaction"]');
      if (!(btn instanceof HTMLElement)) return false;
      btn.click();
      return true;
    })()`);
    assert.ok(clickedReaction, 'Add reaction button should exist inside thread sheet');

    await session.waitFor(async () => {
      return session.eval<boolean>(`Boolean(document.querySelector('.buzz-popover-popup em-emoji-picker'))`);
    }, 5000);
    await new Promise((r) => setTimeout(r, 120));
    await session.screenshot('02-emoji-popover-open.png');

    // Check if pressing Escape closes ONLY emoji popover and keeps thread sheet open
    await session.pressEscape();
    await new Promise((r) => setTimeout(r, 200));
    const afterEsc = await session.eval<{ popoverOpen: boolean; sheetOpen: boolean; sameSheetEl: boolean }>(`(() => {
      const sheet = document.querySelector('[data-details-sheet-surface]');
      return {
        popoverOpen: Boolean(document.querySelector('.buzz-popover-popup')),
        sheetOpen: Boolean(sheet),
        sameSheetEl: sheet === window.__sheetEl,
      };
    })()`);

    // Re-open emoji popover (if thread stayed open) and select an emoji
    let afterEmojiSelect: {
      sheetOpen: boolean;
      sameSheetEl: boolean;
      newAnimateCalls: number;
      sheetHeightAfter: number;
      sheetMounts: number;
      sheetUnmounts: number;
    } | null = null;

    if (afterEsc.sheetOpen) {
      await session.eval(`(() => {
        const sheet = document.querySelector('[data-details-sheet-surface]');
        const btn = sheet?.querySelector('button[aria-label="Add reaction"]');
        if (btn instanceof HTMLElement) btn.click();
      })()`);
      await session.waitFor(async () => {
        return session.eval<boolean>(`Boolean(document.querySelector('.buzz-popover-popup em-emoji-picker'))`);
      }, 5000);

      // Click first actual emoji button inside emoji-mart shadow root (skip category nav buttons)
      const clickedEmoji = await session.eval<boolean>(`(() => {
        const picker = document.querySelector('.buzz-popover-popup em-emoji-picker');
        const btn = picker?.shadowRoot?.querySelector('section .scroll button[aria-label], section [data-emoji-set] button, section .category button');
        const fallback = Array.from(picker?.shadowRoot?.querySelectorAll('button') ?? []).find(
          (b) => b.querySelector('span[aria-hidden]') || /\\p{Extended_Pictographic}/u.test(b.textContent || ''),
        );
        const target = btn ?? fallback;
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      })()`);
      assert.ok(clickedEmoji, 'Should click an emoji inside emoji-mart');
      await new Promise((r) => setTimeout(r, 350));
      await session.screenshot('03-after-emoji-selected.png');

      afterEmojiSelect = await session.eval(`(() => {
        const sheet = document.querySelector('[data-details-sheet-surface]');
        return {
          sheetOpen: Boolean(sheet),
          sameSheetEl: sheet === window.__sheetEl,
          newAnimateCalls: window.__threadProbe.animateCalls.length - ${beforeEmoji.animateCount},
          sheetHeightAfter: sheet ? Math.round(sheet.getBoundingClientRect().height) : 0,
          sheetMounts: window.__threadProbe.sheetMounts,
          sheetUnmounts: window.__threadProbe.sheetUnmounts,
        };
      })()`);

      // 3. Close thread via close button and verify graceful ending animation
      await session.eval(`(() => {
        const btn = document.querySelector('button[aria-label="Close thread"]');
        if (btn instanceof HTMLElement) btn.click();
      })()`);
      await new Promise((r) => setTimeout(r, 350));
    }

    const finalProbe = await session.eval<{
      endingStyleSeen: boolean;
      composerInertAfterClose: boolean;
      composerCoveredAfterClose: boolean;
      animateCalls: unknown[];
      consoleErrors: string[];
    }>(`(() => {
      const mainComposer = document.querySelector('[data-composer-dock] > [data-message-composer]');
      return {
        endingStyleSeen: window.__threadProbe.endingStyleSeen,
        composerInertAfterClose: Boolean(mainComposer?.inert),
        composerCoveredAfterClose: Boolean(mainComposer?.hasAttribute('data-composer-covered')),
        animateCalls: window.__threadProbe.animateCalls,
      };
    })()`);

    console.log('=== E2E PROBE REPORT ===');
    console.log(JSON.stringify({
      beforeEmoji,
      afterEsc,
      afterEmojiSelect,
      endingStyleSeen: finalProbe.endingStyleSeen,
      composerInertAfterClose: finalProbe.composerInertAfterClose,
      composerCoveredAfterClose: finalProbe.composerCoveredAfterClose,
      animateCallsCount: finalProbe.animateCalls.length,
      consoleErrors: session.consoleErrors,
    }, null, 2));

    assert.equal(session.consoleErrors.length, 0, `Console errors: ${session.consoleErrors.join('\n')}`);
    assert.equal(beforeEmoji.initialOpenHadRoot, true, 'Thread sheet should render root immediately without empty-state flash');
    assert.equal(afterEsc.popoverOpen, false, 'Escape should close emoji popover');
    assert.equal(afterEsc.sheetOpen, true, 'Escape on emoji popover must NOT close the outer thread sheet');
    assert.ok(afterEmojiSelect, 'Emoji select probe should run');
    assert.equal(afterEmojiSelect.sheetOpen, true, 'Thread sheet must remain open after selecting emoji');
    assert.equal(afterEmojiSelect.sameSheetEl, true, 'Thread sheet DOM node must not remount on emoji selection');
    assert.equal(afterEmojiSelect.newAnimateCalls, 0, 'Thread sheet must not re-run open/close animation on emoji selection');
    assert.equal(finalProbe.endingStyleSeen, true, 'Closing thread sheet should run ending transition instead of instant unmount');
    assert.equal(finalProbe.composerInertAfterClose, false, 'Main composer should not remain inert after close');
  });
});
