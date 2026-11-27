import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { randomUUID } from 'node:crypto';

export type CliId = 'claude' | 'codex';
export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access';
export interface DirectCliAgentConfig {
  externalId: string;
  cliId: CliId;
  name: string;
  workingDir: string;
  permissionMode: PermissionMode;
}

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface PiModelConfig {
  auth?: 'byok' | 'bub-login';
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}
export interface PiAgentConfig {
  externalId: string;
  name: string;
  profile: string;
  workingDir?: string;
  bin?: string;
  skill?: string;
  timeoutMs?: number;
}

export function resolvePiModel(config = loadCliConfig(), env = process.env): PiModelConfig {
  const stored = config.piModel;
  const provider = env.BUBAI_LLM_PROVIDER || stored?.provider ||
    (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY ? 'anthropic' :
      env.GEMINI_API_KEY && !env.OPENAI_API_KEY ? 'google' : 'openai');
  const keys: Record<string, string | undefined> = {
    openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY, google: env.GEMINI_API_KEY,
  };
  const defaults: Record<string, string> = {
    openai: 'gpt-4o-mini', anthropic: 'claude-sonnet-4-5', google: 'gemini-2.5-flash',
  };
  const previous = stored?.provider === provider ? stored : undefined;
  const baseUrl = env.BUBAI_LLM_BASE_URL || previous?.baseUrl;
  const sameEndpoint = baseUrl === previous?.baseUrl;
  const hosted = previous?.auth === 'bub-login';
  if (hosted && (!config.serverUrl || !baseUrl || new URL(baseUrl).origin !== new URL(config.serverUrl).origin)) {
    throw new Error('A hosted model must use the logged-in BubAI server origin');
  }
  const apiKey = (hosted && config.token) || env.BUBAI_LLM_API_KEY || (sameEndpoint && previous?.apiKey) || (!baseUrl && keys[provider]);
  if (!apiKey) throw new Error('Set BUBAI_LLM_API_KEY or run bub config set --llm-provider <provider> --llm-model <model> --llm-api-key <key>');
  const model = env.BUBAI_LLM_MODEL || previous?.model || defaults[provider];
  if (!model) throw new Error('Set BUBAI_LLM_MODEL for this provider');
  return { provider, model, baseUrl, apiKey };
}

export interface BubaiCliConfig {
  piModel?: PiModelConfig;
  piAgents?: PiAgentConfig[];
  serverUrl?: string;
  token?: string;
  userId?: string;
  localAgents?: DirectCliAgentConfig[];
}

export function getConfigPath(overrideDir?: string): string {
  const dir = overrideDir || process.env.BUBAI_CONFIG_DIR || path.join(os.homedir(), '.bubai');
  return path.join(dir, 'config.json');
}

export function loadCliConfig(overrideDir?: string): BubaiCliConfig {
  const file = getConfigPath(overrideDir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BubaiCliConfig;
  } catch {
    return {};
  }
}

export function saveCliConfig(
  patch: Partial<BubaiCliConfig>,
  overrideDir?: string,
  opts?: { clearTokenOnServerChange?: boolean },
): BubaiCliConfig {
  const file = getConfigPath(overrideDir);
  const current = loadCliConfig(overrideDir);
  const serverChanged =
    Boolean(opts?.clearTokenOnServerChange) &&
    Boolean(patch.serverUrl) &&
    Boolean(current.serverUrl) &&
    patch.serverUrl !== current.serverUrl &&
    patch.token === undefined;
  const next: BubaiCliConfig = {
    ...current,
    ...patch,
    ...(serverChanged ? { token: undefined } : {}),
  };
  if (next.token === undefined) delete next.token;
  writeJson(file, next);
  return next;
}
