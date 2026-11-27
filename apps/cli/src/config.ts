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

export interface BubaiCliConfig {
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
