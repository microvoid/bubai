import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

export function findChromeBinary(): string | null {
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

export class CdpSession {
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

  async clickElement(selector: string): Promise<void> {
    const point = await this.waitFor(() => this.eval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return null;
      el.scrollIntoView({ block: 'nearest' });
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
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
