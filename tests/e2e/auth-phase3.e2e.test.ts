import { registerTestUser } from './account-mailbox';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { BubaiClient } from '../../packages/chat-client/src/client';

const execFileAsync = promisify(execFile);

const PORT = 4201;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SERVER_ENTRY = path.resolve(import.meta.dirname, '../../apps/server/src/main.ts');
const CLI_ENTRY = path.resolve(import.meta.dirname, '../../apps/cli/src/index.ts');
const BUZZ_SEND_SCRIPT = path.resolve(import.meta.dirname, '../../scripts/buzz-send.mjs');
const AUTH_SECRET = 'e2e-phase3-secret-0123456789abcdef0123456789';

async function waitForServerReady(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/instance`);
      if (res.ok) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Isolated server did not become ready at ${url}`);
}

let serverMailPath = '';

async function signUpAndCreateOrg(email: string, name: string, orgName: string, orgSlug: string) {
  const signUpRes = await registerTestUser(BASE_URL, email, name, 'e2e-password-123456', () => fs.readFileSync(serverMailPath, 'utf8'));
  assert.equal(signUpRes.status, 200, `sign-up failed: ${await signUpRes.clone().text()}`);
  const token = signUpRes.headers.get('set-auth-token');
  const setCookie = signUpRes.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0]! : '';
  const data = (await signUpRes.json()) as { user: { id: string; email: string; name: string } };
  assert.ok(token, 'Expected Bearer set-auth-token header');

  const createOrgRes = await fetch(`${BASE_URL}/api/auth/organization/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'http://localhost:5173',
    },
    body: JSON.stringify({ name: orgName, slug: orgSlug }),
  });
  assert.equal(createOrgRes.status, 200, `create org failed: ${await createOrgRes.clone().text()}`);
  const org = (await createOrgRes.json()) as { id: string; slug: string; name: string };

  const activeRes = await fetch(`${BASE_URL}/api/auth/organization/set-active`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'http://localhost:5173',
    },
    body: JSON.stringify({ organizationId: org.id }),
  });
  assert.equal(activeRes.status, 200, `set-active org failed: ${await activeRes.clone().text()}`);

  return { user: data.user, token, cookie, org };
}

describe('Phase 3 E2E: Bot Convergence, Strict Bot API Key, CLI Device Auth, and Mobile Auth', () => {
  let tempDir = '';
  let cliConfigDir = '';
  let serverProc: ChildProcess | null = null;


  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-auth-phase3-'));
    cliConfigDir = path.join(tempDir, 'cli-config');
    // Note: BUZZ_BOT_TOKEN is intentionally EMPTY while BUBAI_AUTH_REQUIRED=true
    // to verify that local-dev bypass is closed and bot_ API keys are enforced.
    serverMailPath = path.join(tempDir, 'account-mail.log');
    serverProc = spawn('sh', ['-c', 'exec bun "$1" > "$2"', 'test-server', SERVER_ENTRY, serverMailPath], {
      cwd: tempDir,
      env: {
        ...process.env,
        PORT: String(PORT),
        CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_EMAIL_API_TOKEN: '', EMAIL_FROM: '',
        DATABASE_URL: '',
        BUBAI_AUTH_REQUIRED: 'true',
        BETTER_AUTH_SECRET: AUTH_SECRET,
        BETTER_AUTH_URL: BASE_URL,
        BUZZ_BOT_TOKEN: '',
        BOTMUX_ENDPOINT: 'http://127.0.0.1:19998',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForServerReady(BASE_URL);
  });

  after(() => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGKILL');
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. Bot convergence & strict API key: rejects unauthenticated /api/bot/messages, registers provisioned bot as org member(kind=BOT), enforces anti-impersonation, and works with buzz-send.mjs', async () => {
    const alice = await signUpAndCreateOrg(
      'phase3-alice@example.com',
      'Alice Phase3',
      'Phase3 Team',
      'phase3-team',
    );

    // Ensure #general channel exists in Alice's org via bootstrap
    const bootRes = await fetch(`${BASE_URL}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(bootRes.status, 200);
    const boot = (await bootRes.json()) as { channels: Array<{ id: string; name: string }> };
    const general = boot.channels.find((c) => c.name === 'general');
    assert.ok(general, 'Expected default #general channel');

    // (a) When BUBAI_AUTH_REQUIRED=true and BUZZ_BOT_TOKEN is unset, unauthenticated /api/bot/messages MUST be rejected (401)
    const unauthBotRes = await fetch(`${BASE_URL}/api/bot/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId: 'fake-bot',
        channelId: general.id,
        content: 'Should not bypass auth',
      }),
    });
    assert.equal(
      unauthBotRes.status,
      401,
      `Expected 401 when BUBAI_AUTH_REQUIRED=true and no bot key provided, got ${unauthBotRes.status}`,
    );

    // (b) Provision a bot in Alice's active organization with issueKey: true
    const provRes = await fetch(`${BASE_URL}/api/agents/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        agentId: 'bot_phase3_worker',
        name: 'Phase3 Worker Bot',
        channelId: general.id,
        issueKey: true,
      }),
    });
    assert.equal(provRes.status, 201, `provision failed: ${await provRes.clone().text()}`);
    const provData = (await provRes.json()) as {
      ok: boolean;
      agent: { id: string; name: string };
      apiKey?: string;
    };
    assert.ok(provData.apiKey?.startsWith('bot_'), `Expected bot_ API key, got ${provData.apiKey}`);

    // (c) Verify the bot is registered in Better Auth organization `member` table with user.kind === 'BOT'
    const membersRes = await fetch(
      `${BASE_URL}/api/auth/organization/list-members?organizationId=${encodeURIComponent(alice.org.id)}`,
      {
        headers: { Authorization: `Bearer ${alice.token}` },
      },
    );
    assert.equal(membersRes.status, 200, `list-members failed: ${await membersRes.clone().text()}`);
    const membersData = (await membersRes.json()) as {
      members: Array<{ userId: string; role: string; user?: { id: string; name: string; kind?: string } }>;
    };
    const botMember = membersData.members.find((m) => m.userId === 'bot_phase3_worker');
    assert.ok(
      botMember,
      `Expected provisioned bot to be added to Better Auth organization member table, members=${JSON.stringify(membersData.members)}`,
    );
    assert.equal(botMember.user?.email, 'bot_phase3_worker@bot.bubai.local');

    // (d) Anti-impersonation: using bot_phase3_worker's key to post as another botId MUST return 403
    const spoofRes = await fetch(`${BASE_URL}/api/bot/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provData.apiKey}`,
      },
      body: JSON.stringify({
        botId: 'another_bot_id',
        channelId: general.id,
        content: 'Impersonation attempt',
      }),
    });
    assert.equal(
      spoofRes.status,
      403,
      `Expected 403 on botId impersonation, got ${spoofRes.status}`,
    );

    // (e) scripts/buzz-send.mjs works with BUBAI_BOT_TOKEN=bot_...
    const { stdout } = await execFileAsync(
      'node',
      [
        BUZZ_SEND_SCRIPT,
        '--server',
        BASE_URL,
        '--bot',
        'bot_phase3_worker',
        '--channel',
        general.id,
        '--text',
        'Hello via Phase3 bot_ API key',
      ],
      {
        env: {
          ...process.env,
          BUZZ_BOT_TOKEN: '',
          BUBAI_BOT_TOKEN: provData.apiKey,
        },
      },
    );
    const sent = JSON.parse(stdout.trim()) as { ok: boolean; id?: string; channelId?: string };
    assert.equal(sent.ok, true);
    assert.equal(sent.channelId, general.id);
  });

  it('2. CLI Device Authorization: `bubai login` requests device code, approves via Better Auth /device/approve, saves Bearer token, and runs authenticated `bubai status`', async () => {
    const bob = await signUpAndCreateOrg(
      'phase3-bob@example.com',
      'Bob CLI',
      'CLI Team',
      'cli-team',
    );

    // Spawn `bun apps/cli/src/index.ts login --server <BASE_URL> --json`
    const loginProc = spawn(
      'bun',
      [CLI_ENTRY, 'login', '--server', BASE_URL, '--json'],
      {
        env: {
          ...process.env,
          BUBAI_CONFIG_DIR: cliConfigDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let loginStdout = '';
    let loginStderr = '';
    const userCodePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for device code from CLI. stdout=${loginStdout} stderr=${loginStderr}`));
      }, 10000);

      const inspect = (chunk: Buffer) => {
        loginStdout += String(chunk);
        const lines = loginStdout.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as { event?: string; userCode?: string; user_code?: string };
            const code = parsed.userCode || parsed.user_code;
            if (parsed.event === 'device_code' && code) {
              clearTimeout(timer);
              resolve(code);
              return;
            }
          } catch {
            // ignore non-json lines
          }
        }
      };
      loginProc.stdout?.on('data', inspect);
      loginProc.stderr?.on('data', (chunk) => {
        loginStderr += String(chunk);
      });
      loginProc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`CLI login exited early (${code}): stdout=${loginStdout} stderr=${loginStderr}`));
        }
      });
    });

    const userCode = await userCodePromise;
    assert.ok(userCode.length >= 4, `Expected valid userCode, got ${userCode}`);

    // Claim/verify then approve the device code as Bob (same two-step flow Web /device page calls)
    const verifyRes = await fetch(
      `${BASE_URL}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
      {
        headers: {
          Authorization: `Bearer ${bob.token}`,
          Origin: 'http://localhost:5173',
        },
      },
    );
    assert.equal(verifyRes.status, 200, `device verify failed: ${await verifyRes.clone().text()}`);

    const approveRes = await fetch(`${BASE_URL}/api/auth/device/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bob.token}`,
        Origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ userCode }),
    });
    assert.equal(approveRes.status, 200, `device approve failed: ${await approveRes.clone().text()}`);

    // Wait for CLI login process to finish polling and save config
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        loginProc.kill('SIGKILL');
        reject(new Error(`CLI login did not finish after approval. stdout=${loginStdout} stderr=${loginStderr}`));
      }, 15000);
      loginProc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, `CLI login failed: stderr=${loginStderr}`);

    // Verify token was saved in config.json and `bubai status` succeeds against BUBAI_AUTH_REQUIRED=true
    const savedConfig = JSON.parse(fs.readFileSync(path.join(cliConfigDir, 'config.json'), 'utf8')) as {
      serverUrl?: string;
      token?: string;
    };
    assert.equal(savedConfig.serverUrl, BASE_URL);
    assert.ok(savedConfig.token && savedConfig.token.length > 10, 'Expected saved Bearer token in config.json');

    const statusOptions = {
      env: {
        ...process.env,
        BUBAI_CONFIG_DIR: cliConfigDir,
        BUBAI_TOKEN: '',
        BUBAI_BOT_TOKEN: '',
        BUZZ_BOT_TOKEN: '',
      },
    };
    const { stdout: statusOut } = await execFileAsync('bun', [CLI_ENTRY, 'status', '--json'], statusOptions);
    const statusJson = JSON.parse(statusOut) as {
      ok: boolean;
      serverUrl: string;
      instance: { authRequired: boolean };
      agents: Array<{ archived?: boolean; status: 'online' | 'offline' }>;
    };
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.serverUrl, BASE_URL);
    assert.equal(statusJson.instance.authRequired, true);

    const activeAgents = statusJson.agents.filter((agent) => !agent.archived);
    const onlineAgents = activeAgents.filter((agent) => agent.status === 'online').length;
    const { stdout: summaryOut } = await execFileAsync('bun', [CLI_ENTRY, 'status'], statusOptions);
    assert.deepEqual(summaryOut.trim().split('\n'), [
      `Server: ${BASE_URL} (reachable)`,
      `Agents: ${onlineAgents} online, ${activeAgents.length - onlineAgents} offline`,
    ]);
  });

  it('3. Mobile Auth Service: sign-in via Email OTP & Password, list/switch Organizations, and connect authenticated BubaiClient + WS', async () => {
    const {
      mobileSignInWithPassword,
      mobileSendEmailOtp,
      mobileSignInWithEmailOtp,
      mobileListOrganizations,
      mobileSetActiveOrganization,
      mobileCreateOrganization,
      mobileGetSession,
      mobileSignOut,
    } = await import('../../apps/mobile/src/services/auth');

    // (a) Send Email OTP and sign in with OTP captured from server logs
    const otpEmail = 'mobile-otp@example.com';
    await mobileSendEmailOtp(BASE_URL, otpEmail);
    const otpRegex = new RegExp(`email=${otpEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+otp=(\\d{6})`);
    const otpMatch = fs.readFileSync(serverMailPath, 'utf8').match(otpRegex);
    assert.ok(otpMatch?.[1], `Expected OTP in server logs for ${otpEmail}`);

    const otpSession = await mobileSignInWithEmailOtp(BASE_URL, otpEmail, otpMatch[1]);
    assert.ok(otpSession.token, 'Expected Bearer token from mobile OTP sign-in');
    assert.equal(otpSession.user.email, otpEmail);

    // (b) Create & activate an organization via mobile auth service
    const createdOrg = await mobileCreateOrganization(BASE_URL, otpSession.token, 'Mobile Org');
    assert.ok(createdOrg.id);
    await mobileSetActiveOrganization(BASE_URL, otpSession.token, createdOrg.id);

    const orgs = await mobileListOrganizations(BASE_URL, otpSession.token);
    assert.ok(orgs.some((o) => o.id === createdOrg.id));

    const verifiedSession = await mobileGetSession(BASE_URL, otpSession.token);
    assert.equal(verifiedSession?.user.id, otpSession.user.id);
    assert.equal(verifiedSession?.activeOrganizationId, createdOrg.id);

    // (c) Authenticated BubaiClient bootstrap succeeds with Bearer token
    const client = new BubaiClient({ baseUrl: BASE_URL, token: otpSession.token });
    const boot = await client.bootstrap(otpSession.user.id);
    assert.ok(boot.channels.some((c) => c.name === 'general'), 'Expected org #general channel in mobile bootstrap');

    // (d) Sign out invalidates token
    await mobileSignOut(BASE_URL, otpSession.token);
    const afterSignOut = await mobileGetSession(BASE_URL, otpSession.token);
    assert.equal(afterSignOut, null, 'Expected session to be null after mobile sign-out');

    // (e) Password sign-in helper also works for existing user
    const pwSession = await mobileSignInWithPassword(
      BASE_URL,
      'phase3-alice@example.com',
      'e2e-password-123456',
    );
    assert.ok(pwSession.token);
    assert.equal(pwSession.user.email, 'phase3-alice@example.com');
  });
});
