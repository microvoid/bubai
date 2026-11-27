import {
  botCredentials,
  consoleVerificationOTP,
  createAuth,
  resolveDisplayName,
  type Auth,
} from '@bubai/auth';
import type { ChatDb } from '@buzz-botmux/db';

const DEFAULT_DEV_SECRET = 'bubai-dev-better-auth-secret-change-in-production-0123456789';

export { resolveDisplayName };

/**
 * Default OTP sender: uses Resend HTTP API when `RESEND_API_KEY` is configured,
 * otherwise falls back to `consoleVerificationOTP` for local development.
 */
export const envVerificationOTP: NonNullable<
  Parameters<typeof createAuth>[0]['sendVerificationOTP']
> = async ({ email, otp, type }, request) => {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey) {
    return consoleVerificationOTP({ email, otp, type }, request);
  }
  const from = process.env.EMAIL_FROM?.trim() || 'Bubai <noreply@bubai.local>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `Your Bubai verification code: ${otp}`,
      text: `Your Bubai verification code is ${otp}. It expires in 5 minutes.`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to send OTP email via Resend (${res.status}): ${body}`);
  }
};

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
    sendVerificationOTP: sendVerificationOTP ?? envVerificationOTP,
  });
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
        name: resolveDisplayName(result.user.name, result.user.email),
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
  headers: Headers;
  authRequired: boolean;
  fallbackUserId?: string | null;
}): Promise<RequestIdentity | null> {
  const session = await resolveAuthSession(params.auth, params.headers);
  if (session) {
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
