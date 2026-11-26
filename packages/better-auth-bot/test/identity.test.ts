import assert from 'node:assert/strict';
import test from 'node:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { APIError } from 'better-auth/api';
import { bot } from '../src/index.js';

const baseURL = 'http://localhost:43123';
const password = 'test-only-password';

function setup(options?: Parameters<typeof bot>[0]) {
  const database = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const auth = betterAuth({
    baseURL,
    secret: 'test-only-better-auth-bot-secret-43-characters',
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    plugins: [bot(options)],
  });
  return { auth, database };
}

type Auth = ReturnType<typeof setup>['auth'];

async function createCreator(auth: Auth) {
  const { user } = await auth.api.signUpEmail({
    body: { name: 'Creator', email: 'creator@example.test', password },
  });
  return user;
}

function request(
  auth: Auth,
  path: string,
  options: { body?: object; authorized?: boolean } = {},
) {
  const { body, authorized } = options;
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: baseURL,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authorized ? { 'X-Test-Authorization': 'allowed' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

test('server methods preserve an explicit Bot User ID and creator', async () => {
  const { auth, database } = setup();
  const creator = await createCreator(auth);
  const input = {
    id: 'existing-application-bot-id',
    createdByUserId: creator.id,
    email: 'bot@example.test',
    name: 'Release Bot',
  };
  const created = await auth.api.createBotUser({ body: input });

  assert.equal(created.id, input.id);
  assert.equal(created.kind, 'BOT');
  assert.equal(created.botCreatedByUserId, creator.id);
  assert.equal(created.email, input.email);
  assert.equal(created.name, input.name);
  assert.equal(created.botDisabledAt, null);
  assert.deepEqual(
    await auth.api.getBotUser({ query: { userId: created.id } }),
    created,
  );
  await assert.rejects(auth.api.getBotUser({ query: { userId: creator.id } }));
  await assert.rejects(
    auth.api.createBotUser({
      body: { ...input, id: creator.id, email: 'other-bot@example.test' },
    }),
  );
  await assert.rejects(
    auth.api.createBotUser({
      body: { ...input, id: 'another-bot-id', email: creator.email },
    }),
  );
  assert.equal(database.user.length, 2);

  const child = await auth.api.createBotUser({
    body: {
      createdByUserId: created.id,
      name: 'Child Bot',
      email: 'child@example.test',
    },
  });
  assert.equal(child.botCreatedByUserId, created.id);

  const disabled = await auth.api.disableBotUser({
    body: { userId: created.id },
  });
  assert.ok(disabled.botDisabledAt);
  assert.equal(disabled.botCreatedByUserId, creator.id);
  assert.deepEqual(
    await auth.api.getBotUser({ query: { userId: created.id } }),
    disabled,
  );
  const disabledAgain = await auth.api.disableBotUser({
    body: { userId: created.id },
  });
  assert.deepEqual(disabledAgain.botDisabledAt, disabled.botDisabledAt);
  await assert.rejects(
    auth.api.createBotUser({
      body: {
        createdByUserId: created.id,
        name: 'Another Bot',
        email: 'another@example.test',
      },
    }),
    (error: unknown) =>
      error instanceof APIError && error.body?.code === 'BOT_CREATOR_DISABLED',
  );
});

test('server-only identity and account boundaries reject unauthorized callers', async () => {
  const { auth, database } = setup();
  const creator = await createCreator(auth);
  const created = await auth.api.createBotUser({
    body: {
      createdByUserId: creator.id,
      email: 'bot@example.test',
      name: 'Release Bot',
    },
  });
  assert.ok(created.id);
  assert.equal(
    (
      await request(auth, '/bot/create', {
        body: { name: 'Untrusted Bot', email: 'untrusted@example.test' },
      })
    ).status,
    404,
  );
  assert.equal(
    (await request(auth, `/bot/get?userId=${created.id}`)).status,
    404,
  );
  assert.equal(
    (await request(auth, '/bot/disable', { body: { userId: created.id } }))
      .status,
    404,
  );
  const { internalAdapter } = await auth.$context;
  const sessionCount = database.session.length;
  const accountCount = database.account.length;
  const rejectsBotAccount = (error: unknown) =>
    error instanceof APIError &&
    error.body?.code === 'BOT_HUMAN_AUTH_FORBIDDEN';
  await assert.rejects(
    internalAdapter.createSession(created.id),
    rejectsBotAccount,
  );
  await assert.rejects(
    internalAdapter.createAccount({
      accountId: created.id,
      providerId: 'credential',
      userId: created.id,
      password,
    }),
    rejectsBotAccount,
  );
  await assert.rejects(
    auth.api.signInEmail({ body: { email: created.email, password } }),
    APIError,
  );
  assert.equal(database.session.length, sessionCount);
  assert.equal(database.account.length, accountCount);
  const rejectsLifecycleMutation = (error: unknown) =>
    error instanceof APIError &&
    error.body?.code === 'BOT_USER_LIFECYCLE_PROTECTED';
  await assert.rejects(
    internalAdapter.updateUser(created.id, { kind: 'HUMAN' }),
    rejectsLifecycleMutation,
  );
  assert.equal(
    (await auth.api.getBotUser({ query: { userId: created.id } })).kind,
    'BOT',
  );
  assert.ok(await internalAdapter.createSession(creator.id));
});

test('opt-in HTTP aliases forward authorization and use the trusted creator', async () => {
  const actions: unknown[] = [];
  const { auth } = setup({
    authorize(input) {
      actions.push(
        input.action === 'create'
          ? { action: input.action, body: input.body }
          : { action: input.action, userId: input.userId },
      );
      return input.request.headers.get('X-Test-Authorization') === 'allowed'
        ? { userId: creatorId }
        : null;
    },
  });
  const creatorId = (await createCreator(auth)).id;

  const body = { name: 'Release Bot', email: 'bot@example.test' };
  const denied = await request(auth, '/bot/create', { body });
  assert.equal(denied.status, 403);
  const forged = await request(auth, '/bot/create', {
    body: { ...body, createdByUserId: 'forged-id' },
    authorized: true,
  });
  assert.equal(forged.status, 400);

  const registered = await request(auth, '/bot/create', {
    body,
    authorized: true,
  });
  assert.equal(registered.ok, true);
  const created = await registered.json();
  assert.equal(created.kind, 'BOT');
  assert.equal(created.botCreatedByUserId, creatorId);

  const loaded = await request(auth, `/bot/get?userId=${created.id}`, {
    authorized: true,
  });
  assert.equal(loaded.ok, true);
  assert.deepEqual(await loaded.json(), created);

  const response = await request(auth, '/bot/disable', {
    body: { userId: created.id },
    authorized: true,
  });
  assert.equal(response.ok, true);
  assert.ok((await response.json()).botDisabledAt);
  assert.deepEqual(actions, [
    { action: 'create', body },
    { action: 'create', body },
    { action: 'get', userId: created.id },
    { action: 'disable', userId: created.id },
  ]);
});
