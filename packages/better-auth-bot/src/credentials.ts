import type { apiKey, ApiKeyConfigurationOptions } from '@better-auth/api-key';
import type { InferAPI } from 'better-auth';
import { APIError } from 'better-auth/api';

export const BOT_KEY_CONFIG_ID = 'bot';
export const BOT_SERVER_KEY_CONFIG_ID = 'bot-server';
export const BOT_SERVER_KEY_PREFIX = 'bot-server_';

export const botApiKeyConfig = {
  configId: BOT_KEY_CONFIG_ID,
  references: 'user',
  storage: 'database',
  defaultPrefix: 'bot_',
  enableMetadata: true,
  enableSessionForAPIKeys: false,
  rateLimit: { enabled: false },
} satisfies ApiKeyConfigurationOptions;

export const botServerApiKeyConfig = {
  ...botApiKeyConfig,
  configId: BOT_SERVER_KEY_CONFIG_ID,
  defaultPrefix: BOT_SERVER_KEY_PREFIX,
} satisfies ApiKeyConfigurationOptions;

type Permissions = Record<string, string[]>;

interface BotKeyOptions {
  name?: string;
  expiresIn?: number;
  permissions?: Permissions;
  metadata?: Record<string, unknown>;
}

type BotCredentialApi = Pick<
  InferAPI<ReturnType<typeof apiKey>['endpoints']>,
  'createApiKey' | 'verifyApiKey' | 'updateApiKey'
> & {
  getBotUser(input: { query: { userId: string } }): Promise<{
    botDisabledAt: Date | null;
  }>;
};

/** Server-side helpers bound to a Better Auth instance using both plugins. */
export function botCredentials(
  api: BotCredentialApi,
  configId:
    | typeof BOT_KEY_CONFIG_ID
    | typeof BOT_SERVER_KEY_CONFIG_ID = BOT_KEY_CONFIG_ID,
) {
  return {
    async issueBotKey(userId: string, options: BotKeyOptions = {}) {
      const user = await api.getBotUser({ query: { userId } });
      if (user.botDisabledAt) {
        throw new APIError('FORBIDDEN', { message: 'Bot is disabled' });
      }
      const { id, key, expiresAt } = await api.createApiKey({
        body: { ...options, configId, userId },
      });
      return { keyId: id, key, expiresAt };
    },

    async verifyBotKey(key: string, permissions?: Permissions) {
      const result = await api.verifyApiKey({
        body: {
          configId,
          key,
          ...(permissions && { permissions }),
        },
      });
      if (!result.valid || !result.key) return null;

      const { id, referenceId, metadata, permissions: granted } = result.key;
      try {
        const user = await api.getBotUser({ query: { userId: referenceId } });
        if (user.botDisabledAt) return null;
      } catch (error) {
        if (error instanceof APIError && error.status === 'NOT_FOUND')
          return null;
        throw error;
      }
      return {
        keyId: id,
        userId: referenceId,
        permissions: granted ?? null,
        metadata,
      };
    },

    async revokeBotKey(userId: string, keyId: string) {
      await api.getBotUser({ query: { userId } });
      await api.updateApiKey({
        body: { configId, userId, keyId, enabled: false },
      });
    },
  };
}
