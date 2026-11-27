import { accountLink } from './account-mailbox';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const SERVER_PORT = Number(process.env.E2E_AUTH_SERVER_PORT || 4201);
const WEB_PORT = Number(process.env.E2E_AUTH_WEB_PORT || 5181);
const CDP_PORT = Number(process.env.E2E_AUTH_CDP_PORT || 9249);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const SERVER_ENTRY = path.resolve(import.meta.dir, '../../apps/server/src/main.ts');
const WEB_DIR = path.resolve(import.meta.dir, '../../apps/web');
const ARTIFACTS_DIR = path.resolve(import.meta.dir, 'artifacts/auth-phase2');

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

async function waitForHttp(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
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
        const text = String(msg.params.message.text || '');
        // Ignore expected 401 network log when intentionally testing session expiration
        if (!text.includes('401')) {
          this.consoleErrors.push(text);
        }
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
            ws.onerror = () => reject(new Error('CDP WebSocket failed'));
          });
          return new CdpSession(ws);
        }
      } catch {
        // Chrome starting
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

  async waitFor<T>(
    fn: () => Promise<T | null | undefined | false>,
    label = 'condition',
    timeoutMs = 10000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await fn();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async screenshot(name: string): Promise<string> {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await new Promise((r) => setTimeout(r, 180));
    const { data } = (await this.send('Page.captureScreenshot', { format: 'png' })) as {
      data: string;
    };
    const outPath = path.join(ARTIFACTS_DIR, name);
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    return outPath;
  }

  async setInputValue(selector: string, value: string): Promise<void> {
    const ok = await this.eval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.ok(ok, `Input not found: ${selector}`);
  }

  async click(selector: string): Promise<void> {
    const ok = await this.eval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    assert.ok(ok, `Clickable element not found: ${selector}`);
  }

  close() {
    this.ws.close();
  }
}

describe('Phase 2 Web Auth UI & Buzz Alignment E2E (real headless Chrome)', () => {
  let tempDir = '';
  let serverProc: ChildProcess | null = null;
  let webProc: ChildProcess | null = null;
  let chromeProc: ChildProcess | null = null;
  let cdp: CdpSession | null = null;
  let serverLogPath = '';

  before(async () => {
    const chromeBin = findChromeBinary();
    assert.ok(chromeBin, 'Chrome binary not found');

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-auth-phase2-e2e-'));
    serverLogPath = path.join(tempDir, 'server.log');
    fs.writeFileSync(serverLogPath, '');

    serverProc = spawn(
      'sh',
      ['-c', `exec bun ${JSON.stringify(SERVER_ENTRY)} >> ${JSON.stringify(serverLogPath)} 2>&1`],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          PORT: String(SERVER_PORT),
          CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_EMAIL_API_TOKEN: '', EMAIL_FROM: '',
          DATABASE_URL: '',
          BUBAI_AUTH_REQUIRED: 'true',
          BETTER_AUTH_SECRET: 'e2e-phase2-secret-0123456789abcdef0123456789',
          BETTER_AUTH_URL: SERVER_URL,
          BETTER_AUTH_TRUSTED_ORIGINS: WEB_URL,
          BOTMUX_ENDPOINT: 'http://127.0.0.1:19999',
        },
        stdio: 'ignore',
      },
    );

    await waitForHttp(`${SERVER_URL}/api/instance`);

    webProc = spawn(
      'pnpm',
      ['exec', 'vite', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
      {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          VITE_SERVER_URL: SERVER_URL,
        },
        stdio: 'ignore',
      },
    );

    await waitForHttp(WEB_URL);

    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    cdp = await CdpSession.connect(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Console.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const OrigWS = window.WebSocket;
        window.__e2eSockets = [];
        window.WebSocket = function(url, protocols) {
          const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
          window.__e2eSockets.push(ws);
          return ws;
        };
        window.WebSocket.prototype = OrigWS.prototype;
        Object.assign(window.WebSocket, OrigWS);
      })();`,
    });
    await cdp.send('Page.navigate', { url: WEB_URL });
  });

  after(() => {
    cdp?.close();
    chromeProc?.kill('SIGKILL');
    webProc?.kill('SIGKILL');
    serverProc?.kill('SIGKILL');
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('walks through full Phase 2 Auth UX: OTP screen -> Password signup -> Onboarding -> Profile menu -> Profile settings -> Community members/invite -> Session expired overlay -> OTP sign-in -> Invite landing', async () => {
    assert.ok(cdp);

    // 1. Cold launch unauthenticated -> Buzz-aligned AuthScreen (Email OTP default)
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-screen="sign-in"]'))`),
      'AuthScreen sign-in',
    );
    // Verify AuthScreen syncs theme with system/saved preference (Chrome headless defaults to light -> Buzz chartreuse #d7d72e)
    const initialTheme = await cdp.eval<{ colorMode: string | undefined; bg: string }>(`(() => {
      const el = document.querySelector('[data-auth-screen="sign-in"]');
      return {
        colorMode: document.documentElement.dataset.colorMode,
        bg: el ? getComputedStyle(el).backgroundColor : '',
      };
    })()`);
    assert.equal(
      initialTheme.colorMode,
      'light',
      `Expected AuthScreen to sync system light mode, got colorMode=${initialTheme.colorMode}`,
    );
    assert.equal(
      initialTheme.bg,
      'rgb(215, 215, 46)',
      `Expected Buzz light onboarding chartreuse rgb(215, 215, 46), got ${initialTheme.bg}`,
    );
    await cdp.screenshot('01-auth-signin-otp.png');

    // 2. Switch to dev Email+Password sign-up mode & create Alice
    await cdp.click('[data-auth-action="toggle-password-mode"]');
    await cdp.click('[data-auth-action="switch-to-signup"]');
    await cdp.setInputValue('[data-auth-input="name"]', 'Alice Lin');
    await cdp.setInputValue('[data-auth-input="email"]', 'alice@example.com');
    await cdp.setInputValue('[data-auth-input="password"]', 'dev-password-123456');
    await cdp.screenshot('02-auth-password-signup.png');
    await cdp.click('[data-auth-action="submit-password"]');

    const link = await accountLink(() => fs.readFileSync(serverLogPath, 'utf8'), 'alice@example.com', 'verify');
    await cdp.send('Page.navigate', { url: link });
    await cdp.waitFor(() => cdp!.eval<boolean>(`document.body.innerText.includes('邮箱已验证')`), 'Verified email');
    await cdp.click('[data-account-enter]');

    // 3. First-time user with 0 orgs -> OnboardingSetup screen
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-screen="onboarding"]'))`),
      'OnboardingSetup screen',
    );
    await cdp.setInputValue('[data-auth-input="org-name"]', 'Bubai Team');
    await cdp.screenshot('03-auth-onboarding-community.png');
    await cdp.click('[data-auth-action="create-org"]');

    // 4. Enters Workspace & opens Buzz-aligned bottom-left ProfileButton menu
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-trigger]'))`),
      'Workspace ProfileButton',
      12000,
    );
    await cdp.click('[data-profile-trigger]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-menu]'))`),
      'ProfileButton menu',
    );
    await cdp.screenshot('04-workspace-profile-menu.png');

    // 5. Open ProfileSettingsDialog, rename Alice -> Alice Updated, upload local avatar PNG, save
    await cdp.click('[data-profile-action="open-profile-settings"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-settings-dialog]'))`),
      'ProfileSettingsDialog',
    );
    await cdp.setInputValue('[data-auth-input="profile-name"]', 'Alice Updated');
    // Upload a real 1x1 PNG file via local file input
    const avatarPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const avatarFilePath = path.join(tempDir, 'avatar.png');
    fs.writeFileSync(avatarFilePath, Buffer.from(avatarPngBase64, 'base64'));
    const hasFileInput = await cdp.eval<boolean>(
      `Boolean(document.querySelector('input[type="file"][data-auth-input="profile-avatar-file"]'))`,
    );
    assert.ok(hasFileInput, 'Expected local avatar file input [data-auth-input="profile-avatar-file"]');
    const docNode = await cdp.send('DOM.getDocument', { depth: -1 });
    const fileInputNode = await cdp.send('DOM.querySelector', {
      nodeId: docNode.root.nodeId,
      selector: 'input[type="file"][data-auth-input="profile-avatar-file"]',
    });
    await cdp.send('DOM.setFileInputFiles', {
      nodeId: fileInputNode.nodeId,
      files: [avatarFilePath],
    });
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `(document.querySelector('[data-auth-input="profile-avatar"]')?.value || '').includes('/api/uploads/')`,
        ),
      'Uploaded avatar URL populated in input',
    );
    await cdp.screenshot('05-profile-settings-dialog.png');
    await cdp.click('[data-auth-action="save-profile"]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `document.querySelector('[data-profile-trigger]')?.textContent?.includes('Alice Updated')`,
        ),
      'Updated profile name in ProfileButton',
    );
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(`(() => {
          const img = document.querySelector('[data-profile-trigger] img');
          return Boolean(img && img.src.includes('/api/uploads/') && img.complete && img.naturalWidth > 0);
        })()`),
      'Uploaded avatar image rendered with auth cookie',
    );

    // 6. Open CommunityMembersDialog, verify human/bot grouping, invite bob@example.com as admin, capture invite link
    await cdp.click('[data-profile-trigger]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-menu]'))`),
      'Profile menu for members',
    );
    await cdp.click('[data-profile-action="open-community-members"]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(`Boolean(document.querySelector('[data-community-members-dialog]'))`),
      'CommunityMembersDialog',
    );
    const hasHumansGroup = await cdp.eval<boolean>(
      `Boolean(document.querySelector('[data-members-group="humans"]'))`,
    );
    assert.ok(hasHumansGroup, 'Expected CommunityMembersDialog to render [data-members-group="humans"]');
    const hasRoleSelect = await cdp.eval<boolean>(
      `Boolean(document.querySelector('[data-auth-input="invite-role"]'))`,
    );
    assert.ok(hasRoleSelect, 'Expected CommunityMembersDialog to render [data-auth-input="invite-role"]');
    await cdp.eval<void>(`(() => {
      const sel = document.querySelector('[data-auth-input="invite-role"]');
      if (sel) {
        sel.value = 'admin';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await cdp.setInputValue('[data-auth-input="invite-email"]', 'bob@example.com');
    await cdp.click('[data-auth-action="send-invite"]');
    const inviteUrl = await cdp.waitFor(
      () =>
        cdp!.eval<string>(
          `document.querySelector('[data-invite-link]')?.getAttribute('data-invite-link') || ''`,
        ),
      'Created invite link',
    );
    assert.ok(inviteUrl.includes('/invite/'), `Expected /invite/<id> URL, got ${inviteUrl}`);
    // Also invite charlie@example.com so we can test OnboardingSetup "Join existing" auto-fetched pending invitations
    await cdp.setInputValue('[data-auth-input="invite-email"]', 'charlie@example.com');
    await cdp.click('[data-auth-action="send-invite"]');
    await cdp.click('[data-community-tab="invites"]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `(() => {
            const txt = document.querySelector('[data-community-members-dialog]')?.textContent || '';
            return txt.includes('bob@example.com') && txt.includes('charlie@example.com');
          })()`,
        ),
      'Pending invitations visible in invites tab',
    );
    await cdp.screenshot('06-community-members-dialog.png');
    await cdp.click('[data-auth-action="close-community-members"]');

    // 7. REAL 401 SessionExpiredOverlay preserves Workspace draft without unmounting
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`document.querySelector('.spike-editor')?.getAttribute('contenteditable') === 'true'`),
      'Composer ready',
    );
    await cdp.eval<void>(`(() => {
      const ed = document.querySelector('.spike-editor');
      ed?.focus();
    })()`);
    await cdp.send('Input.insertText', { text: 'Draft must survive reauth' });

    // Clear real session cookies and click Activity button to trigger a genuine HTTP 401 from server
    await cdp.send('Network.clearBrowserCookies');
    await cdp.eval<void>(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Activity'));
      btn?.click();
    })()`);
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `Boolean(document.querySelector('[data-auth-screen="session-expired"]'))`,
        ),
      'SessionExpiredOverlay from real 401',
    );
    await cdp.screenshot('07-session-expired-overlay.png');

    // Re-authenticate in place using password mode and verify draft survived
    await cdp.click('[data-auth-action="toggle-password-mode"]');
    await cdp.setInputValue('[data-auth-input="password"]', 'dev-password-123456');
    await cdp.click('[data-auth-action="submit-password"]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `!document.querySelector('[data-auth-screen="session-expired"]')`,
        ),
      'SessionExpiredOverlay dismissed',
    );
    const preservedDraft = await cdp.eval<string>(
      `document.querySelector('.spike-editor')?.textContent || ''`,
    );
    assert.ok(
      preservedDraft.includes('Draft must survive reauth'),
      `Expected composer draft to survive re-auth, got "${preservedDraft}"`,
    );

    // 7b. REAL WS 401 (without any REST click!) triggers SessionExpiredOverlay automatically
    await cdp.send('Network.clearBrowserCookies');
    await cdp.eval<void>(`(() => {
      for (const ws of window.__e2eSockets || []) {
        if (
          ws.url.includes('/ws') &&
          (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ) {
          ws.close();
        }
      }
    })()`);
    await cdp
      .waitFor(
        () =>
          cdp!.eval<boolean>(
            `Boolean(document.querySelector('[data-auth-screen="session-expired"]'))`,
          ),
        'SessionExpiredOverlay from WS 401 reconnect',
        8000,
      )
      .catch(async (err) => {
        const diag = await cdp!.eval<unknown>(`({
          sockets: (window.__e2eSockets || []).map((s) => ({ url: s.url, readyState: s.readyState })),
          authScreen: document.querySelector('[data-auth-screen]')?.getAttribute('data-auth-screen') || null,
          profile: Boolean(document.querySelector('[data-profile-trigger]')),
        })`);
        throw new Error(`${err.message} | diag=${JSON.stringify(diag)} | consoleErrors=${JSON.stringify(cdp!.consoleErrors)}`);
      });
    await cdp.click('[data-auth-action="toggle-password-mode"]');
    await cdp.setInputValue('[data-auth-input="password"]', 'dev-password-123456');
    await cdp.click('[data-auth-action="submit-password"]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `!document.querySelector('[data-auth-screen="session-expired"]')`,
        ),
      'SessionExpiredOverlay dismissed after WS 401 re-auth',
    );

    // 8. Sign out -> Test full Email OTP sign-in flow as bob@example.com
    await cdp.click('[data-profile-trigger]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-menu]'))`),
      'Profile menu for sign-out',
    );
    await cdp.click('[data-profile-action="sign-out"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-screen="sign-in"]'))`),
      'Returned to AuthScreen after sign-out',
    );

    await cdp.setInputValue('[data-auth-input="email"]', 'bob@example.com');
    await cdp.click('[data-auth-action="send-otp"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-step="otp-verify"]'))`),
      'OTP verification step',
    );
    const bobOtp = await cdp
      .waitFor(
        async () => {
          const text = fs.existsSync(serverLogPath) ? fs.readFileSync(serverLogPath, 'utf8') : '';
          for (const line of text.split('\n')) {
            const m = line.match(/\[bubai-auth\]\[otp\].*email=bob@example\.com.*otp=(\d{6})/);
            if (m) return m[1]!;
          }
          return null;
        },
        'Captured OTP from server log file',
        6000,
      )
      .catch((err) => {
        const logs = fs.existsSync(serverLogPath) ? fs.readFileSync(serverLogPath, 'utf8') : '';
        throw new Error(`${err.message}\n--- SERVER LOGS ---\n${logs.slice(-1500)}`);
      });
    await cdp.setInputValue('[data-auth-input="otp"]', bobOtp);
    await cdp.screenshot('08-otp-verify-step.png');
    await cdp.click('[data-auth-action="verify-otp"]');

    // 9. Navigate to /invite/<id> as bob@example.com -> InviteLanding -> Accept -> Enters Bubai Team!
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `Boolean(document.querySelector('[data-auth-screen="onboarding"], [data-profile-trigger]'))`,
        ),
      'Signed in as Bob',
    );
    const invitePath = new URL(inviteUrl, WEB_URL).pathname;
    await cdp.send('Page.navigate', { url: `${WEB_URL}${invitePath}` });
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-screen="invite"]'))`),
      'InviteLanding screen',
    );
    await cdp.screenshot('09-invite-landing.png');
    await cdp.click('[data-auth-action="accept-invite"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-trigger]'))`),
      'Bob entered Workspace after accepting invite',
      12000,
    );
    const bobTriggerText = await cdp.eval<string>(
      `document.querySelector('[data-profile-trigger]')?.textContent || ''`,
    );
    assert.ok(
      bobTriggerText.includes('bob') && !bobTriggerText.includes('Owner'),
      `Expected Bob's ProfileButton to show "bob" (not "Owner"), got "${bobTriggerText}"`,
    );
    assert.ok(
      bobTriggerText.includes('Bubai Team'),
      `Expected Bob's ProfileButton to show active org "Bubai Team", got "${bobTriggerText}"`,
    );
    await cdp.screenshot('10-bob-joined-workspace.png');

    // 10. Sign out Bob -> Sign in as charlie@example.com via OTP -> Onboarding "Join existing" auto-lists pending invite!
    await cdp.click('[data-profile-trigger]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-menu]'))`),
      'Bob profile menu for sign-out',
    );
    await cdp.click('[data-profile-action="sign-out"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-screen="sign-in"]'))`),
      'Returned to AuthScreen after Bob sign-out',
    );
    await cdp.setInputValue('[data-auth-input="email"]', 'charlie@example.com');
    await cdp.click('[data-auth-action="send-otp"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-step="otp-verify"]'))`),
      'Charlie OTP verification step',
    );
    const charlieOtp = await cdp.waitFor(async () => {
      const text = fs.existsSync(serverLogPath) ? fs.readFileSync(serverLogPath, 'utf8') : '';
      for (const line of text.split('\n')) {
        const m = line.match(/\[bubai-auth\]\[otp\].*email=charlie@example\.com.*otp=(\d{6})/);
        if (m) return m[1]!;
      }
      return null;
    }, 'Captured Charlie OTP from server log', 6000);
    await cdp.setInputValue('[data-auth-input="otp"]', charlieOtp);
    await cdp.click('[data-auth-action="verify-otp"]');

    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-screen="onboarding"]'))`),
      'Charlie landed on OnboardingSetup',
    );
    await cdp.click('[data-auth-action="onboarding-tab-join"]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `Boolean(document.querySelector('[data-pending-invitations-list]')?.textContent?.includes('Bubai Team'))`,
        ),
      'Onboarding auto-fetched pending invitation for Bubai Team',
    );
    await cdp.click('[data-auth-action="accept-pending-invite"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-trigger]'))`),
      'Charlie entered Workspace via auto-fetched pending invite',
      12000,
    );

    // 11. Sign back in as Alice -> CommunityMembersDialog: change Charlie role admin -> member, then remove Charlie
    await cdp.click('[data-profile-trigger]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-menu]'))`),
      'Charlie profile menu for sign-out',
    );
    await cdp.click('[data-profile-action="sign-out"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-screen="sign-in"]'))`),
      'Returned to AuthScreen for Alice re-login',
    );
    await cdp.click('[data-auth-action="toggle-password-mode"]');
    await cdp.setInputValue('[data-auth-input="email"]', 'alice@example.com');
    await cdp.click('[data-auth-action="forgot-password"]');
    await cdp.click('[data-account-submit]');
    const resetLink = await accountLink(() => fs.readFileSync(serverLogPath, 'utf8'), 'alice@example.com', 'reset');
    await cdp.send('Page.navigate', { url: resetLink });
    await cdp.waitFor(() => cdp!.eval<boolean>(`Boolean(document.querySelector('input[autocomplete="new-password"]'))`), 'Password reset form');
    await cdp.setInputValue('input[autocomplete="new-password"]', 'updated-password-123456');
    await cdp.click('[data-account-submit]');
    await cdp.waitFor(() => cdp!.eval<boolean>(`document.body.innerText.includes('密码已更新')`), 'Password updated');
    await cdp.click('[data-account-back]');
    await cdp.waitFor(() => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-auth-action="toggle-password-mode"]'))`), 'Login after password reset');
    await cdp.click('[data-auth-action="toggle-password-mode"]');
    await cdp.setInputValue('[data-auth-input="email"]', 'alice@example.com');
    await cdp.setInputValue('[data-auth-input="password"]', 'updated-password-123456');
    await cdp.click('[data-auth-action="submit-password"]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-trigger]'))`),
      'Alice back in Workspace',
      12000,
    );
    await cdp.click('[data-profile-trigger]');
    await cdp.waitFor(
      () => cdp!.eval<boolean>(`Boolean(document.querySelector('[data-profile-menu]'))`),
      'Alice profile menu',
    );
    await cdp.click('[data-profile-action="open-community-members"]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `Boolean(document.querySelector('[data-member-row="charlie@example.com"]'))`,
        ),
      'Charlie row in CommunityMembersDialog',
    );
    await cdp.eval<void>(`(() => {
      const sel = document.querySelector('[data-member-row="charlie@example.com"] [data-member-role-select]');
      if (sel) {
        sel.value = 'member';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `document.querySelector('[data-member-row="charlie@example.com"] [data-member-role-select]')?.value === 'member'`,
        ),
      'Charlie role updated to member',
    );
    await cdp.click('[data-member-row="charlie@example.com"] [data-member-remove]');
    await cdp.waitFor(
      () =>
        cdp!.eval<boolean>(
          `!document.querySelector('[data-member-row="charlie@example.com"]')`,
        ),
      'Charlie removed from CommunityMembersDialog',
    );
    await cdp.click('[data-auth-action="close-community-members"]');

    assert.deepEqual(cdp.consoleErrors, [], `Unexpected console errors: ${cdp.consoleErrors.join('; ')}`);
  });
});
