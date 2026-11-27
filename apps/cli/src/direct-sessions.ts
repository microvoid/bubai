import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath, writeJson } from './config';

export function openSessions(dir?: string) {
  const file = path.join(path.dirname(getConfigPath(dir)), 'sessions.json');
  function read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }
  return {
    get(key: string) {
      return read()[key];
    },
    set(key: string, session?: string) {
      const bindings = read();
      if (session) bindings[key] = session;
      else delete bindings[key];
      writeJson(file, bindings);
    },
  };
}
