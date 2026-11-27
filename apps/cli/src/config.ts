import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BubaiCliConfig {
  serverUrl?: string;
  token?: string;
  userId?: string;
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
