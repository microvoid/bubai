import { botCredentials, createAuth, type Auth } from '@bubai/auth';
import { users, type ChatDb } from '@buzz-botmux/db';

const DEFAULT_DEV_SECRET = 'bubai-dev-better-auth-secret-change-in-production-0123456789';

export interface ResolvedAuthSession {
  userId: string;
  organizationId: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
}

export interface RequestIdentity {
  authenticated: boolean;
  userId: string;
  organizationId: string | null;
  user: ResolvedAuthSession['user'] | null;
}

export interface BotVerificationResult {
  ok: boolean;
  botUserId?: string;
  method?: 'bot-key' | 'bot-server-key' | 'static-token' | 'local-dev';
}

export interface CreateServerAuthOptions {
  db: ChatDb;
  port?: number;
  baseURL?: string;
  secret?: string;
  trustedOrigins?: string[];
  emailAndPassword?: boolean;
  sendVerificationOTP?: Parameters<typeof createAuth>[0]['sendVerificationOTP'];
}

export function resolveTrustedOrigins(params?: {
  port?: number;
  baseURL?: string;
  trustedOrigins?: string[];
}): string[] {
  const port = params?.port ?? Number(process.env.PORT || 4000);
  const resolvedBaseURL = (
    params?.baseURL ||
    process.env.BETTER_AUTH_URL ||
    process.env.PUBLIC_URL ||
    `http://127.0.0.1:${port}`
  ).replace(/\/+$/, '');

  const envOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return [
    ...new Set([
      resolvedBaseURL,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:8081',
      'http://127.0.0.1:8081',
      ...envOrigins,
      ...(params?.trustedOrigins || []),
    ]),
  ];
}

export function createServerAuth({
  db,
  port = Number(process.env.PORT || 4000),
  baseURL,
  secret,
  trustedOrigins,
  emailAndPassword,
  sendVerificationOTP,
}: CreateServerAuthOptions): Auth {
  const resolvedBaseURL = (
    baseURL ||
    process.env.BETTER_AUTH_URL ||
    process.env.PUBLIC_URL ||
    `http://127.0.0.1:${port}`
  ).replace(/\/+$/, '');

  const origins = resolveTrustedOrigins({ port, baseURL: resolvedBaseURL, trustedOrigins });

  const explicitSecret = secret?.trim() || process.env.BETTER_AUTH_SECRET?.trim() || '';
  if (!explicitSecret && process.env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET must be set in production');
  }
  const resolvedSecret = explicitSecret || DEFAULT_DEV_SECRET;

  return createAuth({
    database: db,
    secret: resolvedSecret,
    baseURL: resolvedBaseURL,
    trustedOrigins: origins,
    ...(emailAndPassword !== undefined ? { emailAndPassword } : {}),
    ...(sendVerificationOTP ? { sendVerificationOTP } : {}),
  });
}

const syncedUsersByDb = new WeakMap<object, Map<string, string>>();

/**
 * Keep the legacy `users` table in sync with Better Auth `user` rows so existing
 * foreign keys (`channel_reads`, `channel_members`, `messages`, `sidebar_groups`,
 * `thread_reads`) continue working seamlessly during Phase 1 migration.
 * Deduplicated in-memory per DB instance so repeated requests with unchanged
 * profile fields do not issue redundant DB writes.
 */
export async function syncAuthUserToLegacyUsers(
  db: ChatDb,
  authUser: ResolvedAuthSession['user'],
): Promise<boolean> {
  const effectiveName =
    authUser.name.trim() || authUser.email.split('@')[0] || authUser.email || 'User';
  const fingerprint = `${effectiveName}\0${authUser.image ?? ''}`;
  let cache = syncedUsersByDb.get(db);
  if (!cache) {
    cache = new Map<string, string>();
    syncedUsersByDb.set(db, cache);
  }
  if (cache.get(authUser.id) === fingerprint) {
    return false;
  }

  await db
    .insert(users)
    .values({
      id: authUser.id,
      name: effectiveName,
      avatarUrl: authUser.image ?? null,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        name: effectiveName,
        avatarUrl: authUser.image ?? null,
      },
    });
  cache.set(authUser.id, fingerprint);
  return true;
}

/** Build a Headers instance suitable for Better Auth session lookup, optionally accepting a WS ?token= query param. */
export function buildSessionHeaders(reqHeaders: Headers, queryToken?: string | null): Headers {
  const headers = new Headers(reqHeaders);
  if (queryToken && !headers.get('authorization')) {
    headers.set('authorization', `Bearer ${queryToken.trim()}`);
  }
  return headers;
}

export async function resolveAuthSession(
  auth: Auth,
  headers: Headers,
): Promise<ResolvedAuthSession | null> {
  try {
    const result = await auth.api.getSession({ headers });
    if (!result?.user?.id || !result.session) return null;
    const activeOrgId =
      'activeOrganizationId' in result.session &&
      typeof result.session.activeOrganizationId === 'string' &&
      result.session.activeOrganizationId.trim()
        ? result.session.activeOrganizationId.trim()
        : null;
    return {
      userId: result.user.id,
      organizationId: activeOrgId,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        image: result.user.image ?? null,
      },
    };
  } catch {
    return null;
  }
}

export async function resolveRequestIdentity(params: {
  auth: Auth;
  db: ChatDb;
  headers: Headers;
  authRequired: boolean;
  fallbackUserId?: string | null;
}): Promise<RequestIdentity | null> {
  const session = await resolveAuthSession(params.auth, params.headers);
  if (session) {
    await syncAuthUserToLegacyUsers(params.db, session.user);
    return {
      authenticated: true,
      userId: session.userId,
      organizationId: session.organizationId,
      user: session.user,
    };
  }

  if (params.authRequired) {
    return null;
  }

  return {
    authenticated: false,
    userId: params.fallbackUserId?.trim() || 'u-owner',
    organizationId: null,
    user: null,
  };
}

/**
 * Verify a bot outbound request (e.g. POST /api/bot/messages).
 * - If Authorization Bearer starts with `bot_` or `bot-server_`, validates via Better Auth API Key plugin.
 * - Otherwise falls back to legacy `BUZZ_BOT_TOKEN` (or allows local dev when no static token is configured).
 */
export async function verifyBotRequest(
  auth: Auth,
  headers: Headers,
  staticBotToken?: string,
  queryToken?: string | null,
  requireAuth = false,
): Promise<BotVerificationResult> {
  const authHeader = headers.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (queryToken?.trim() || '');

  if (bearer.startsWith('bot-server_')) {
    const creds = botCredentials(auth.api, 'bot-server');
    const verified = await creds.verifyBotKey(bearer);
    if (!verified) return { ok: false };
    return { ok: true, botUserId: verified.userId, method: 'bot-server-key' };
  }

  if (bearer.startsWith('bot_')) {
    const creds = botCredentials(auth.api, 'bot');
    const verified = await creds.verifyBotKey(bearer);
    if (!verified) return { ok: false };
    return { ok: true, botUserId: verified.userId, method: 'bot-key' };
  }

  if (staticBotToken) {
    if (bearer !== staticBotToken) return { ok: false };
    return { ok: true, method: 'static-token' };
  }

  if (requireAuth) {
    return { ok: false };
  }

  return { ok: true, method: 'local-dev' };
}
