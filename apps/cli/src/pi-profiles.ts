import { findExecutable } from '@bubx/agent/process';
import { media, resolveProfile } from '@bubx/agent/profiles';
export { detectedProfiles } from '@bubx/agent/profiles';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadCliConfig, saveCliConfig } from './config';

export function configurePiAgent(flags: Record<string, string | boolean>, wrap: boolean) {
  const profile = wrap ? 'custom' : String(flags.profile);
  const builtin = media[profile as keyof typeof media];
  if (!wrap && !builtin && profile !== 'default')
    throw new Error('Expected --profile default|dreamina|libtv');
  if (wrap && (!flags.bin || !flags.skill || !flags.name))
    throw new Error('Expected --bin, --skill and --name');
  const workingDir = fs.realpathSync(path.resolve(String(flags.cwd || '.')));
  if (!fs.statSync(workingDir).isDirectory()) throw new Error('Expected working directory');
  let skill = flags.skill ? fs.realpathSync(String(flags.skill)) : undefined;
  if (skill && fs.statSync(skill).isDirectory()) skill = path.join(skill, 'SKILL.md');
  const bin = wrap ? findExecutable(String(flags.bin)) : undefined;
  if (wrap && !bin) throw new Error('Executable not found');
  const name = String(flags.name || builtin?.name || 'BubAI 助手');
  const agents = loadCliConfig().piAgents ?? [];
  const existing = agents.find((a) => a.name === name && a.profile === profile);
  const timeoutMs = flags['timeout-ms'] === undefined ? undefined : Number(flags['timeout-ms']);
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
  )
    throw new Error('Invalid --timeout-ms');
  const agent = {
    externalId: existing?.externalId || 'pi-' + randomUUID(),
    profile,
    name,
    workingDir,
    skill,
    bin,
    timeoutMs,
  };
  resolveProfile(agent);
  saveCliConfig({ piAgents: [...agents.filter((a) => a !== existing), agent] });
  return agent;
}
