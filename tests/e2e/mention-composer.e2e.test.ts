import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

const WEB_URL = process.env.E2E_WEB_URL || 'http://localhost:5173';
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9241);

function findChromeBinary(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (existsSync(path)) return path;
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
        // Chrome still starting up
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
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error('Timed out waiting for condition in E2E');
  }

  async clearComposer(): Promise<void> {
    const rect = await this.eval<{ x: number; y: number } | null>(`(() => {
      const ed = document.querySelector('.spike-editor');
      if (!ed) return null;
      ed.focus();
      const r = ed.getBoundingClientRect();
      return { x: r.x + 12, y: r.y + 10 };
    })()`);
    assert.ok(rect, 'Composer .spike-editor should exist');

    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
    // Select all (Cmd+A on macOS, Ctrl+A elsewhere) + Backspace
    const mod = process.platform === 'darwin' ? 4 : 2;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: mod });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: mod });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await new Promise((r) => setTimeout(r, 120));
  }

  close() {
    this.ws.close();
  }
}

describe('Web composer @ mention E2E (real headless Chrome)', () => {
  let chrome: ChildProcess | null = null;
  let cdp: CdpSession | null = null;

  before(async () => {
    const chromeBin = findChromeBinary();
    assert.ok(chromeBin, 'Chrome binary not found; set CHROME_PATH to run browser E2E');

    const health = await fetch(WEB_URL).catch(() => null);
    assert.ok(health?.ok, `Web dev server not reachable at ${WEB_URL}`);

    chrome = spawn(
      chromeBin,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=/tmp/bubai-e2e-mention-${Date.now()}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    cdp = await CdpSession.connect(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Console.enable');
    await cdp.send('Page.navigate', { url: WEB_URL });

    await cdp.waitFor(
      () => cdp!.eval<boolean>(`document.querySelector('.spike-editor')?.getAttribute('contenteditable') === 'true'`),
      12000,
    );
  });

  after(() => {
    cdp?.close();
    chrome?.kill('SIGKILL');
  });

  it('opens @ popover, scrolls to last agent option, and inserts mention on real mouse click', async () => {
    assert.ok(cdp);
    await cdp.clearComposer();
    await cdp.send('Input.insertText', { text: '@' });

    const optionCount = await cdp.waitFor(
      () => cdp!.eval<number>(`document.querySelectorAll('[data-mention] [role="option"]').length`),
    );
    assert.ok(optionCount > 0, 'Expected at least 1 mention candidate');

    const target = await cdp.eval<{ x: number; y: number; id: string }>(`(() => {
      const list = document.querySelector('[data-mention] [role="listbox"]');
      list.scrollTop = list.scrollHeight;
      const opts = Array.from(document.querySelectorAll('[data-mention] [role="option"]'));
      const last = opts[opts.length - 1];
      const r = last.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: last.getAttribute('data-completion-id') || '' };
    })()`);

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1,
    });

    const inserted = await cdp.waitFor(() =>
      cdp!.eval<{ mentionId: string | null; popupOpen: boolean }>(`(() => {
        const chip = document.querySelector('.spike-editor [data-mention-id]');
        if (!chip) return null;
        return {
          mentionId: chip.getAttribute('data-mention-id'),
          popupOpen: Boolean(document.querySelector('[data-mention]')),
        };
      })()`),
    );

    assert.equal(inserted.mentionId, target.id);
    assert.equal(inserted.popupOpen, false);
  });

  it('filters candidates by query and inserts mention on Enter', async () => {
    assert.ok(cdp);
    await cdp.clearComposer();
    await cdp.send('Input.insertText', { text: '@Local' });

    const filtered = await cdp.waitFor(
      () => cdp!.eval<number>(`document.querySelectorAll('[data-mention] [role="option"]').length`),
    );
    assert.ok(filtered > 0, 'Expected @Local to match at least one local agent');

    const expectedId = await cdp.eval<string>(
      `document.querySelector('[data-mention] [aria-selected="true"]')?.getAttribute('data-completion-id') || ''`,
    );

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });

    const inserted = await cdp.waitFor(() =>
      cdp!.eval<{ mentionId: string | null; popupOpen: boolean }>(`(() => {
        const chip = document.querySelector('.spike-editor [data-mention-id]');
        if (!chip) return null;
        return {
          mentionId: chip.getAttribute('data-mention-id'),
          popupOpen: Boolean(document.querySelector('[data-mention]')),
        };
      })()`),
    );

    assert.equal(inserted.mentionId, expectedId);
    assert.equal(inserted.popupOpen, false);
  });

  it('navigates options with ArrowDown and inserts selected candidate with Enter without console errors', async () => {
    assert.ok(cdp);
    await cdp.clearComposer();
    await cdp.send('Input.insertText', { text: '@' });

    await cdp.waitFor(
      () => cdp!.eval<number>(`document.querySelectorAll('[data-mention] [role="option"]').length`),
    );

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
    });
    await new Promise((r) => setTimeout(r, 80));

    const expectedId = await cdp.eval<string>(
      `document.querySelector('[data-mention] [aria-selected="true"]')?.getAttribute('data-completion-id') || ''`,
    );

    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });

    const inserted = await cdp.waitFor(() =>
      cdp!.eval<{ mentionId: string | null; popupOpen: boolean }>(`(() => {
        const chip = document.querySelector('.spike-editor [data-mention-id]');
        if (!chip) return null;
        return {
          mentionId: chip.getAttribute('data-mention-id'),
          popupOpen: Boolean(document.querySelector('[data-mention]')),
        };
      })()`),
    );

    assert.equal(inserted.mentionId, expectedId);
    assert.equal(inserted.popupOpen, false);
    assert.deepEqual(cdp.consoleErrors, []);
  });

  it('persists unsent composer draft (including mention chip and text) across page reload and clears storage when emptied', async () => {
    assert.ok(cdp);
    // Append unsent text after the mention chip inserted in the previous test
    await cdp.send('Input.insertText', { text: 'unsent draft survives reload' });

    await cdp.waitFor(() =>
      cdp!.eval<boolean>(`(() => {
        const text = document.querySelector('.spike-editor')?.textContent || '';
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('buzz-draft.v1:'));
        return text.includes('unsent draft survives reload') && keys.length > 0;
      })()`),
    );

    // Reload the page completely
    await cdp.send('Page.reload', {});
    const restored = await cdp.waitFor(
      () =>
        cdp!.eval<{ text: string; hasMention: boolean } | null>(`(() => {
          const editor = document.querySelector('.spike-editor');
          if (!editor) return null;
          const text = editor.textContent || '';
          const hasMention = Boolean(editor.querySelector('[data-mention-id]'));
          if (!text.includes('unsent draft survives reload') || !hasMention) return null;
          return { text, hasMention };
        })()`),
      10000,
    );
    assert.equal(restored.hasMention, true);
    assert.match(restored.text, /unsent draft survives reload/);

    // Verify Shift+Enter inserts a newline at the end of the restored draft (not at the start)
    await cdp.eval(`document.querySelector('.spike-editor')?.focus()`);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      modifiers: 8,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      modifiers: 8,
    });
    await cdp.send('Input.insertText', { text: 'second line after Shift+Enter' });

    const afterNewline = await cdp.waitFor(() =>
      cdp!.eval<{ html: string; hasBr: boolean } | null>(`(() => {
        const editor = document.querySelector('.spike-editor');
        if (!editor) return null;
        const html = editor.innerHTML;
        if (!html.includes('second line after Shift+Enter')) return null;
        return { html, hasBr: Boolean(editor.querySelector('br')) };
      })()`),
    );
    assert.equal(afterNewline.hasBr, true, `Expected <br> after Shift+Enter, got: ${afterNewline.html}`);
    assert.ok(
      afterNewline.html.indexOf('unsent draft survives reload') <
        afterNewline.html.indexOf('second line after Shift+Enter'),
      `Expected restored draft cursor at end so Shift+Enter appends after existing text, got: ${afterNewline.html}`,
    );

    // Clear composer -> localStorage draft entry should be removed
    await cdp.clearComposer();
    const cleared = await cdp.waitFor(() =>
      cdp!.eval<boolean>(
        `Object.keys(localStorage).filter((k) => k.startsWith('buzz-draft.v1:')).length === 0`,
      ),
    );
    assert.equal(cleared, true);
    assert.deepEqual(cdp.consoleErrors, []);
  });
});
