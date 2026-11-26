import assert from 'node:assert/strict';
import test from 'node:test';
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { botApiKeyConfig, botCredentials } from '../src/credentials.js';
import { bot } from '../src/index.js';

test('Bot credentials are scoped to active Bot users and their configured permissions', async () => {
  const auth = betterAuth({
    baseURL: 'https://identity.example.test',
    secret: 'test-secret-at-least-thirty-two-characters',
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      apikey: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [bot(), apiKey([botApiKeyConfig, { configId: 'other' }])],
  });
  const human = await auth.api.signUpEmail({
    body: {
      name: 'Creator',
      email: 'creator@example.test',
      password: 'test-password',
    },
  });
  const identity = await auth.api.createBotUser({
    body: {
      createdByUserId: human.user.id,
      name: 'Reader',
      email: 'reader@example.test',
    },
  });
  const credentials = botCredentials(auth.api);
  await assert.rejects(credentials.issueBotKey(human.user.id));

  const { key, keyId } = await credentials.issueBotKey(identity.id, {
    permissions: { projects: ['read'] },
    metadata: { installation: 'one' },
  });
  assert.deepEqual(
    await credentials.verifyBotKey(key, { projects: ['read'] }),
    {
      keyId,
      userId: identity.id,
      permissions: { projects: ['read'] },
      metadata: { installation: 'one' },
    },
  );
  assert.equal(
    await credentials.verifyBotKey(key, { projects: ['write'] }),
    null,
  );

  const other = await auth.api.createApiKey({
    body: { userId: identity.id, configId: 'other' },
  });
  assert.equal(await credentials.verifyBotKey(other.key), null);
  await assert.rejects(credentials.revokeBotKey(identity.id, other.id));
  await credentials.revokeBotKey(identity.id, keyId);
  assert.equal(await credentials.verifyBotKey(key), null);

  const second = await credentials.issueBotKey(identity.id);
  await auth.api.disableBotUser({ body: { userId: identity.id } });
  assert.equal(await credentials.verifyBotKey(second.key), null);
  await assert.rejects(credentials.issueBotKey(identity.id));
});
