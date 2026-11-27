import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadCliConfig, saveCliConfig, type PiAgentConfig } from './config';

export interface PiToolAgentProfile {
  id: string;
  name: string;
  allowedBins: string[];
  skillPaths: string[];
  systemPrompt: string;
  defaultTimeoutMs: number;
}

const media = {
  dreamina: { bin: 'dreamina-canvas', name: '即梦' },
  libtv: { bin: 'libtv', name: 'LibTV' },
};

export function findBin(bin: string) {
  const candidates = path.isAbsolute(bin) ? [bin] : path.basename(bin) === bin ?
    (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, bin)) : [];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch { /* Continue through PATH. */ }
  }
}

export function detectedProfiles() {
  return Object.entries(media).filter(([, value]) => findBin(value.bin)).map(([id]) => id);
}

export function resolveProfile(agent: PiAgentConfig): PiToolAgentProfile {
  const builtin = media[agent.profile as keyof typeof media];
  const bin = agent.bin || builtin?.bin;
  if (!['custom', 'default'].includes(agent.profile) && !builtin) throw new Error('Unknown Pi profile');
  const binary = bin && findBin(bin);
  if (bin && !binary) throw new Error('Missing configured executable: ' + bin);
  const skillPaths = agent.skill ? [agent.skill] : [];
  return { id: agent.profile, name: agent.name, allowedBins: binary ? [binary] : [], skillPaths,
    defaultTimeoutMs: agent.timeoutMs ?? (builtin ? 25 * 60_000 : 30 * 60_000),
    systemPrompt: [builtin ? 'Create media with ' + builtin.bin + '. Inspect its help for the supported commands.' : '',
      ...skillPaths.map(file => fs.readFileSync(file, 'utf8'))].filter(Boolean).join('\n') };
}

export function configurePiAgent(flags: Record<string,string|boolean>, wrap: boolean) {
  const profile = wrap ? 'custom' : String(flags.profile);
  const builtin = media[profile as keyof typeof media];
  if (!wrap && !builtin && profile !== 'default') throw new Error('Expected --profile default|dreamina|libtv');
  if (wrap && (!flags.bin || !flags.skill || !flags.name)) throw new Error('Expected --bin, --skill and --name');
  const workingDir = fs.realpathSync(path.resolve(String(flags.cwd || '.')));
  if (!fs.statSync(workingDir).isDirectory()) throw new Error('Expected working directory');
  let skill = flags.skill ? fs.realpathSync(String(flags.skill)) : undefined;
  if (skill && fs.statSync(skill).isDirectory()) skill = path.join(skill, 'SKILL.md');
  const bin = wrap ? findBin(String(flags.bin)) : undefined;
  if (wrap && !bin) throw new Error('Executable not found');
  const name = String(flags.name || builtin?.name || 'BubAI 助手');
  const agents = loadCliConfig().piAgents ?? [];
  const existing = agents.find(a => a.name === name && a.profile === profile);
  const timeoutMs = flags['timeout-ms'] === undefined ? undefined : Number(flags['timeout-ms']);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647))
    throw new Error('Invalid --timeout-ms');
  const agent = { externalId: existing?.externalId || 'pi-' + randomUUID(), profile, name, workingDir, skill, bin, timeoutMs };
  resolveProfile(agent);
  saveCliConfig({piAgents: [...agents.filter(a => a !== existing), agent]});
  return agent;
}
