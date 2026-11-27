import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { CdpSession, findChromeBinary } from './browser-cdp.ts';
import { after, before, describe, it } from 'node:test';

const WEB_URL = process.env.E2E_WEB_URL || 'http://localhost:5173';
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9241);

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

    // Page.reload acknowledges navigation before Chrome replaces the old document.
    const oldDocument = await cdp.eval<number>('performance.timeOrigin');
    await cdp.send('Page.reload', {});
    await cdp.waitFor(() => cdp!.eval<boolean>(`performance.timeOrigin !== ${oldDocument}`));
    const restored = await cdp.waitFor(
      () =>
        cdp!.eval<{ text: string; hasMention: boolean } | null>(`(() => {
          const editor = document.querySelector('.spike-editor');
          if (editor?.getAttribute('contenteditable') !== 'true') return null;
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
