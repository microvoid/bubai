import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_DDL, authSchema, botCredentials } from '@bubai/auth';
import { channels, eq, openChatDatabase } from '@buzz-botmux/db';
import {
  buildSessionHeaders,
  createServerAuth,
  resolveAuthSession,
  resolveDisplayName,
  resolveRequestIdentity,
  verifyBotRequest,
} from './auth';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function openTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-auth-phase1-'));
  tempDirs.push(dir);
  return openChatDatabase({ dataDir: dir, databaseUrl: '', beforeDdl: AUTH_DDL });
}

describe('Phase 1 server auth + DB integration', () => {
  it('initializes Better Auth tables, supports cookie/bearer/OTP sessions, org scoping, legacy user sync, and bot keys', async () => {
    const { db, close } = await openTempDb();
    const otps: Array<{ email: string; otp: string; type: string }> = [];

    try {
      const links: Array<{ kind: string; url: URL }> = [];
      const auth = createServerAuth({
        db,
        port: 4123,
        secret: 'test-secret-0123456789abcdef0123456789abcdef',
        emailAndPassword: true,
        sendAccountLink: async (kind, _email, url) => { links.push({ kind, url: new URL(url) }); },
        sendVerificationOTP: async ({ email, otp, type }) => {
          otps.push({ email, otp, type });
        },
      });

      // 1. Unauthenticated identity respects authRequired toggle
      const blocked = await resolveRequestIdentity({
        auth,
        headers: new Headers(),
        authRequired: true,
        fallbackUserId: 'spoofed-user',
      });
      expect(blocked).toBeNull();

      const compat = await resolveRequestIdentity({
        auth,
        headers: new Headers(),
        authRequired: false,
      });
      expect(compat?.authenticated).toBe(false);
      expect(compat?.userId).toBe('u-owner');

      // 2. Only the verified email link starts the password signup session
      const signUp = await auth.api.signUpEmail({
        body: {
          name: 'Alice',
          email: 'alice@example.com',
          password: 'dev-password-123456',
        },
        returnHeaders: true,
      });
      expect(signUp.response.token).toBeNull();
      expect(links.map(link => link.kind)).toEqual(['verify']);
      const verified = await auth.api.verifyEmail({
        query: { token: links[0]!.url.searchParams.get('token')! }, returnHeaders: true,
      });
      const cookie = verified.headers.get('set-cookie');
      const bearerToken = verified.headers.get('set-auth-token');
      expect(cookie).toBeTruthy();
      expect(bearerToken).toBeTruthy();

      // 3. Create + activate organization
      const org = await auth.api.createOrganization({
        headers: new Headers({ cookie: cookie! }),
        body: { name: 'Bubai Core', slug: 'bubai-core' },
      });
      expect(org?.id).toBeTruthy();

      await auth.api.setActiveOrganization({
        headers: new Headers({ cookie: cookie! }),
        body: { organizationId: org!.id },
      });

      // 4. resolveRequestIdentity uses session userId (ignoring spoofed fallback) and exposes orgId
      const cookieIdentity = await resolveRequestIdentity({
        auth,
        headers: new Headers({ cookie: cookie! }),
        authRequired: true,
        fallbackUserId: 'u-spoofed',
      });
      expect(cookieIdentity?.authenticated).toBe(true);
      expect(cookieIdentity?.userId).toBe(signUp.response.user.id);
      expect(cookieIdentity?.organizationId).toBe(org!.id);

      const [authUserRow] = await db
        .select()
        .from(authSchema.user)
        .where(eq(authSchema.user.id, signUp.response.user.id));
      expect(authUserRow?.name).toBe('Alice');

      // 5. Bearer token via Authorization header AND WS ?token= query param
      const wsHeaders = buildSessionHeaders(new Headers(), bearerToken);
      const wsSession = await resolveAuthSession(auth, wsHeaders);
      expect(wsSession?.userId).toBe(signUp.response.user.id);
      expect(wsSession?.organizationId).toBe(org!.id);

      // 6. Channels can reference Better Auth organization.id
      const [createdChannel] = await db
        .insert(channels)
        .values({
          name: 'org-general',
          topic: 'Org scoped channel',
          kind: 'channel',
          organizationId: org!.id,
          createdByUserId: signUp.response.user.id,
        })
        .returning();
      expect(createdChannel?.organizationId).toBe(org!.id);

      // 7. Email OTP sign-in works end-to-end
      await auth.api.sendVerificationOTP({
        body: { email: 'bob@example.com', type: 'sign-in' },
      });
      expect(otps.length).toBe(1);
      const otpSignIn = await auth.api.signInEmailOTP({
        body: { email: 'bob@example.com', otp: otps[0]!.otp },
      });
      expect(otpSignIn.user.email).toBe('bob@example.com');

      expect(links).toHaveLength(1);
      await auth.api.requestPasswordReset({ body: { email: 'alice@example.com', redirectTo: '/' } });
      expect(links[1]?.kind).toBe('reset');
      const reset = { body: { token: links[1]!.url.pathname.split('/').pop()!, newPassword: 'replacement-password' } };
      await auth.api.resetPassword(reset);
      await expect(auth.api.resetPassword(reset)).rejects.toThrow();
      const updated = await auth.api.signInEmail({ body: { email: 'alice@example.com', password: reset.body.newPassword } });
      expect(updated.user.id).toBe(signUp.response.user.id);

      // 8. Bot user + bot_ API key verification
      const botUser = await auth.api.createBotUser({
        body: {
          name: 'Local Gemini Bot',
          email: 'gemini@bot.local',
          createdByUserId: signUp.response.user.id,
        },
      });
      const issued = await botCredentials(auth.api).issueBotKey(botUser.id);
      const okBot = await verifyBotRequest(
        auth,
        new Headers({ authorization: `Bearer ${issued.key}` }),
        'legacy-static-secret',
      );
      expect(okBot).toEqual({ ok: true, botUserId: botUser.id, method: 'bot-key' });

      const badBot = await verifyBotRequest(
        auth,
        new Headers({ authorization: 'Bearer bot_invalid_key' }),
        'legacy-static-secret',
      );
      expect(badBot.ok).toBe(false);

      const legacyBot = await verifyBotRequest(
        auth,
        new Headers({ authorization: 'Bearer legacy-static-secret' }),
        'legacy-static-secret',
      );
      expect(legacyBot).toEqual({ ok: true, method: 'static-token' });

      // 9. resolveDisplayName handles empty names cleanly
      expect(resolveDisplayName('  ', 'bob@example.com')).toBe('bob');
      expect(resolveDisplayName('Alice', 'alice@example.com')).toBe('Alice');
      expect(resolveDisplayName('', '')).toBe('User');

      // 10. Production secret guard throws when BETTER_AUTH_SECRET is missing
      const prevNodeEnv = process.env.NODE_ENV;
      const prevSecret = process.env.BETTER_AUTH_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.BETTER_AUTH_SECRET;
        expect(() => createServerAuth({ db, port: 4123 })).toThrow(
          /BETTER_AUTH_SECRET must be set in production/,
        );
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        if (prevSecret !== undefined) process.env.BETTER_AUTH_SECRET = prevSecret;
      }
    } finally {
      await close();
    }
  });
});
