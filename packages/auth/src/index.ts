import { apiKey } from '@better-auth/api-key';
import { expo } from '@better-auth/expo';
import { bot } from '@bubai/better-auth-bot';
import {
  botApiKeyConfig,
  botServerApiKeyConfig,
} from '@bubai/better-auth-bot/credentials';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins/admin';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { emailOTP, type EmailOTPOptions } from 'better-auth/plugins/email-otp';
import {
  organization,
  type DefaultOrganizationPlugin,
  type OrganizationEndpoints,
  type OrganizationOptions,
  type TeamEndpoints,
} from 'better-auth/plugins/organization';
import * as schema from './schema.js';

export { botCredentials } from '@bubai/better-auth-bot/credentials';
export { AUTH_DDL } from './ddl.js';
export * as authSchema from './schema.js';

type DrizzleDatabase = Parameters<typeof drizzleAdapter>[0];
type DefaultOptions = Record<never, never>;

type TeamOptions = OrganizationOptions & {
  teams: { enabled: true };
  dynamicAccessControl?: { enabled?: false };
};
type OrganizationPlugin = DefaultOrganizationPlugin<TeamOptions> & {
  endpoints: OrganizationEndpoints<TeamOptions> & TeamEndpoints<TeamOptions>;
};

export interface AuthOptions extends BetterAuthOptions {
  plugins: [
    ReturnType<typeof bearer>,
    ReturnType<typeof emailOTP>,
    ReturnType<typeof expo>,
    OrganizationPlugin,
    ReturnType<typeof admin<DefaultOptions>>,
    ReturnType<typeof bot>,
    ReturnType<typeof deviceAuthorization>,
    ReturnType<typeof apiKey>,
  ];
}

export type Auth = ReturnType<typeof betterAuth<AuthOptions>>;

export interface CreateAuthOptions {
  database: DrizzleDatabase;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  emailAndPassword?: boolean;
  sendVerificationOTP?: EmailOTPOptions['sendVerificationOTP'];
}

/** Canonical display-name fallback when Better Auth `user.name` is empty (e.g. first-time Email OTP). */
export function resolveDisplayName(
  name?: string | null,
  email?: string | null,
  fallback = 'User',
): string {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedEmail = email?.trim();
  if (trimmedEmail) {
    const localPart = trimmedEmail.split('@')[0]?.trim();
    if (localPart) return localPart;
    return trimmedEmail;
  }
  return fallback;
}

/** Logs OTP codes to the console; replace with a real email sender in production. */
export const consoleVerificationOTP: EmailOTPOptions['sendVerificationOTP'] =
  async ({ email, otp, type }) => {
    console.info(`[bubai-auth][otp] type=${type} email=${email} otp=${otp}`);
  };

export function createAuth({
  database,
  secret,
  baseURL,
  trustedOrigins = [],
  emailAndPassword = process.env.NODE_ENV !== 'production',
  sendVerificationOTP = consoleVerificationOTP,
}: CreateAuthOptions): Auth {
  const options: AuthOptions = {
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    secret,
    baseURL,
    emailAndPassword: { enabled: emailAndPassword },
    trustedOrigins: [...new Set([...trustedOrigins, 'bubai://'])],
    plugins: [
      bearer(),
      emailOTP({ sendVerificationOTP }),
      expo(),
      organization<TeamOptions>({ teams: { enabled: true } }),
      admin({}),
      bot(),
      deviceAuthorization(),
      apiKey([botApiKeyConfig, botServerApiKeyConfig]),
    ],
  };
  return betterAuth(options);
}
