import {
  botCredentials,
  createAuth,
  resolveDisplayName,
  type Auth,
} from '@bubai/auth';
import type { ChatDb } from '@buzz-botmux/db';

import { codeEmail, linkEmail } from './account-email';

export function passwordAuthEnabled() {
  return process.env.BUBAI_EMAIL_PASSWORD_ENABLED === undefined
    ? process.env.NODE_ENV !== 'production'
    : process.env.BUBAI_EMAIL_PASSWORD_ENABLED === 'true';
}

const DEFAULT_DEV_SECRET = 'bubai-dev-better-auth-secret-change-in-production-0123456789';

export { resolveDisplayName };

interface CloudflareEmailResponse {
  success: boolean;
  result?: {
    delivered?: string[];
    queued?: string[];
  };
}

export const envVerificationOTP: NonNullable<Parameters<typeof createAuth>[0]['sendVerificationOTP']> =
  async ({ email, otp, type }) => sendMail(email, codeEmail(otp, type), () => `[bubai-auth][otp] type=${type} email=${email} otp=${otp}`);

const envAccountLink: NonNullable<Parameters<typeof createAuth>[0]['sendAccountLink']> =
  async (kind, email, url) => sendMail(email, linkEmail(kind, url), () => `[bubai-auth][${kind}] email=${email} url=${url}`);

async function sendMail(email: string, message: ReturnType<typeof codeEmail>, developmentMessage: () => string) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
  const from = process.env.EMAIL_FROM?.trim();

  if (!accountId && !apiToken && !from && process.env.NODE_ENV !== 'production') {
    console.info(developmentMessage());
    return;
  }
  if (!accountId || !apiToken || !from) {
    throw new Error('Configure CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_API_TOKEN, and EMAIL_FROM to send verification emails');
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { address: from, name: 'BubAI' },
        to: [email],
        ...message,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Cloudflare Email Sending request failed (HTTP ${res.status})`);
  }
  const response = await res.json().catch(() => null) as CloudflareEmailResponse | null;
  if (response?.success !== true || !(response.result?.delivered?.length || response.result?.queued?.length)) {
    throw new Error('Cloudflare Email Sending did not accept the verification email');
  }
}

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
  sendAccountLink?: Parameters<typeof createAuth>[0]['sendAccountLink'];
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
  emailAndPassword = passwordAuthEnabled(),
  sendAccountLink = envAccountLink,
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
    emailAndPassword,
    sendAccountLink,
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
