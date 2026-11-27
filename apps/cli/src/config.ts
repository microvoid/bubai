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

export function saveCliConfig(patch: Partial<BubaiCliConfig>, overrideDir?: string): BubaiCliConfig {
  const file = getConfigPath(overrideDir);
  const next: BubaiCliConfig = { ...loadCliConfig(overrideDir), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
