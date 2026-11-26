import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import { authSchema, botCredentials, createAuth } from '../src/index.js';

async function openDatabase() {
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema: authSchema });
  const { apply } = await pushSchema(authSchema, db as never);
  await apply();
  return { db, close: () => pglite.close() };
}

test('createAuth works with the plugin-generated schema', async () => {
  const { db, close } = await openDatabase();
  const otps: string[] = [];

  try {
    const auth = createAuth({
      database: db,
      secret: '0123456789abcdef0123456789abcdef',
      baseURL: 'http://127.0.0.1:4000',
      emailAndPassword: true,
      sendVerificationOTP: async ({ otp }) => {
        otps.push(otp);
      },
    });

    const signUp = await auth.api.signUpEmail({
      body: { name: 'Alice', email: 'alice@example.com', password: 'dev-password-123456' },
      returnHeaders: true,
    });
    const cookie = signUp.headers.get('set-cookie');
    assert.ok(cookie);

    const org = await auth.api.createOrganization({
      headers: new Headers({ cookie }),
      body: { name: 'Bubai Core', slug: 'bubai-core' },
    });
    assert.equal(org?.slug, 'bubai-core');

    const botUser = await auth.api.createBotUser({
      body: {
        name: 'Claude Coder',
        email: 'claude-coder@bot.example.com',
        createdByUserId: signUp.response.user.id,
      },
    });
    assert.equal(botUser.kind, 'BOT');

    const creds = botCredentials(auth.api);
    const issued = await creds.issueBotKey(botUser.id);
    assert.equal((await creds.verifyBotKey(issued.key))?.userId, botUser.id);

    await auth.api.sendVerificationOTP({ body: { email: 'bob@example.com', type: 'sign-in' } });
    assert.equal(otps.length, 1);
    const signIn = await auth.api.signInEmailOTP({
      body: { email: 'bob@example.com', otp: otps[0]! },
    });
    assert.equal(signIn.user.email, 'bob@example.com');
  } finally {
    await close();
  }
});
