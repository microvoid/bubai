import {
  getCurrentAdapter,
  type AuthContext,
  type BetterAuthPlugin,
  type DBTransactionAdapter,
} from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { z } from 'zod';

const userId = z.string().min(1);
const profile = z.strictObject({
  name: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().pipe(z.email()),
});
const createInput = profile.extend({
  id: userId.optional(),
  createdByUserId: userId,
});
const target = z.strictObject({ userId });

export interface BotUser {
  id: string;
  name: string;
  email: string;
  kind: 'BOT';
  botCreatedByUserId: string | null;
  botDisabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BotAuthorizationRequest = { request: Request } & (
  | { action: 'create'; body: z.infer<typeof profile> }
  | { action: 'get' | 'disable'; userId: string }
);

export interface BotOptions {
  /** Authorize an HTTP operation and identify the authenticated caller. */
  authorize?: (
    input: BotAuthorizationRequest,
  ) => { userId: string } | null | Promise<{ userId: string } | null>;
}

const selectedBotFields = [
  'id',
  'name',
  'email',
  'kind',
  'botCreatedByUserId',
  'botDisabledAt',
  'createdAt',
  'updatedAt',
];

function botUserWhere(userId: string) {
  return [
    { field: 'id', value: userId },
    { field: 'kind', value: 'BOT' },
  ];
}

function botUserResult(user: BotUser) {
  return {
    ...user,
    botCreatedByUserId: user.botCreatedByUserId ?? null,
    botDisabledAt: user.botDisabledAt ?? null,
  };
}

async function readBotUser(adapter: DBTransactionAdapter, userId: string) {
  const user = await adapter.findOne<BotUser>({
    model: 'user',
    where: botUserWhere(userId),
    select: selectedBotFields,
  });
  if (!user)
    throw new APIError('NOT_FOUND', {
      code: 'BOT_USER_NOT_FOUND',
      message: 'Bot user not found.',
    });
  return botUserResult(user);
}

async function createBotUser(
  context: AuthContext,
  input: z.infer<typeof createInput>,
) {
  const { createdByUserId, id, email, name } = input;
  const creator = await context.internalAdapter.findUserById(createdByUserId);
  if (!creator)
    throw new APIError('NOT_FOUND', {
      code: 'BOT_CREATOR_NOT_FOUND',
      message: 'Bot creator not found.',
    });
  if ('botDisabledAt' in creator && creator.botDisabledAt != null)
    throw new APIError('FORBIDDEN', {
      code: 'BOT_CREATOR_DISABLED',
      message: 'Disabled Bot users cannot create Bot users.',
    });
  if (
    (id && (await context.internalAdapter.findUserById(id))) ||
    (await context.internalAdapter.findUserByEmail(email))
  )
    throw new APIError('CONFLICT', {
      code: 'BOT_USER_CONFLICT',
      message: 'A user already exists with this ID or email.',
    });

  // Bot lifecycle writes bypass the hooks that protect these fields from account APIs.
  const adapter = await getCurrentAdapter(context.adapter);
  const now = new Date();
  const created = await adapter.create<Record<string, unknown>, BotUser>({
    model: 'user',
    data: {
      ...(id ? { id } : {}),
      email,
      name,
      emailVerified: false,
      kind: 'BOT',
      botCreatedByUserId: createdByUserId,
      botDisabledAt: null,
      createdAt: now,
      updatedAt: now,
    },
    forceAllowId: true,
    select: selectedBotFields,
  });
  return botUserResult(created);
}

async function disableBotUser(adapter: DBTransactionAdapter, userId: string) {
  const now = new Date();
  await adapter.updateMany({
    model: 'user',
    where: [...botUserWhere(userId), { field: 'botDisabledAt', value: null }],
    update: { botDisabledAt: now, updatedAt: now },
  });
  return readBotUser(adapter, userId);
}

function lifecycleProtected() {
  return new APIError('FORBIDDEN', {
    code: 'BOT_USER_LIFECYCLE_PROTECTED',
    message: 'Manage Bot identity through the Bot plugin.',
  });
}

async function requireHuman(context: AuthContext, userId: string) {
  const user = await context.internalAdapter.findUserById(userId);
  if (user && 'kind' in user && user.kind === 'BOT')
    throw new APIError('FORBIDDEN', {
      code: 'BOT_HUMAN_AUTH_FORBIDDEN',
      message: 'Bot users cannot create sessions or link accounts.',
    });
}

function httpEndpoints(authorize: NonNullable<BotOptions['authorize']>) {
  async function requireAuthorization(
    input: BotAuthorizationRequest | undefined,
  ) {
    const caller = input && (await authorize(input));
    if (!caller?.userId)
      throw new APIError('FORBIDDEN', {
        code: 'BOT_OPERATION_FORBIDDEN',
        message: 'This Bot operation is forbidden.',
      });
    return caller.userId;
  }

  return {
    createBotHttp: createAuthEndpoint(
      '/bot/create',
      { method: 'POST', body: profile },
      async (ctx) => {
        const createdByUserId = await requireAuthorization(
          ctx.request && {
            request: ctx.request,
            action: 'create',
            body: ctx.body,
          },
        );
        return ctx.json(
          await createBotUser(ctx.context, { ...ctx.body, createdByUserId }),
        );
      },
    ),
    getBotHttp: createAuthEndpoint(
      '/bot/get',
      { method: 'GET', query: target },
      async (ctx) => {
        const { userId } = ctx.query;
        await requireAuthorization(
          ctx.request && { request: ctx.request, action: 'get', userId },
        );
        const adapter = await getCurrentAdapter(ctx.context.adapter);
        return ctx.json(await readBotUser(adapter, userId));
      },
    ),
    disableBotHttp: createAuthEndpoint(
      '/bot/disable',
      { method: 'POST', body: target },
      async (ctx) => {
        const { userId } = ctx.body;
        await requireAuthorization(
          ctx.request && { request: ctx.request, action: 'disable', userId },
        );
        const adapter = await getCurrentAdapter(ctx.context.adapter);
        return ctx.json(await disableBotUser(adapter, userId));
      },
    ),
  };
}

export function bot(options: BotOptions = {}) {
  return {
    id: 'bot',
    schema: {
      user: {
        fields: {
          kind: { type: ['HUMAN', 'BOT'], defaultValue: 'HUMAN', input: false },
          botCreatedByUserId: {
            type: 'string',
            required: false,
            input: false,
            references: { model: 'user', field: 'id', onDelete: 'set null' },
          },
          botDisabledAt: { type: 'date', required: false, input: false },
        },
      },
    },
    init(authContext) {
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                async before(user) {
                  if (
                    (user.kind !== undefined && user.kind !== 'HUMAN') ||
                    user.botCreatedByUserId != null ||
                    user.botDisabledAt != null
                  )
                    throw lifecycleProtected();
                },
              },
              update: {
                async before(user) {
                  if (
                    'kind' in user ||
                    'botCreatedByUserId' in user ||
                    'botDisabledAt' in user
                  )
                    throw lifecycleProtected();
                },
              },
            },
            session: {
              create: {
                before: (session, ctx) =>
                  requireHuman(ctx?.context ?? authContext, session.userId),
              },
            },
            account: {
              create: {
                before: (account, ctx) =>
                  requireHuman(ctx?.context ?? authContext, account.userId),
              },
            },
          },
        },
      };
    },
    endpoints: {
      createBotUser: createAuthEndpoint.serverOnly(
        { method: 'POST', body: createInput },
        async (ctx) => ctx.json(await createBotUser(ctx.context, ctx.body)),
      ),
      getBotUser: createAuthEndpoint.serverOnly(
        { method: 'GET', query: target },
        async (ctx) => {
          const adapter = await getCurrentAdapter(ctx.context.adapter);
          return ctx.json(await readBotUser(adapter, ctx.query.userId));
        },
      ),
      disableBotUser: createAuthEndpoint.serverOnly(
        { method: 'POST', body: target },
        async (ctx) => {
          const adapter = await getCurrentAdapter(ctx.context.adapter);
          return ctx.json(await disableBotUser(adapter, ctx.body.userId));
        },
      ),
      ...(options.authorize ? httpEndpoints(options.authorize) : {}),
    },
  } satisfies BetterAuthPlugin;
}
