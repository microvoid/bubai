import { findExecutable } from './local-process.js';
import fs from 'node:fs';
import type { PiAgentConfig } from './config.js';
export interface PiToolAgentProfile {
  id: string;
  name: string;
  allowedBins: string[];
  skillPaths: string[];
  systemPrompt: string;
  defaultTimeoutMs?: number;
}

export const media = {
  dreamina: { bin: 'dreamina-canvas', name: '即梦' },
  libtv: { bin: 'libtv', name: 'LibTV' },
};

export function detectedProfiles() {
  return Object.entries(media)
    .filter(([, value]) => findExecutable(value.bin))
    .map(([id]) => id);
}

export function resolveProfile(agent: PiAgentConfig): PiToolAgentProfile {
  const builtin = media[agent.profile as keyof typeof media];
  const bin = agent.bin || builtin?.bin;
  if (!['custom', 'default'].includes(agent.profile) && !builtin) throw new Error('Unknown Pi profile');
  const binary = bin && findExecutable(bin);
  if (bin && !binary) throw new Error('Missing configured executable: ' + bin);
  const skillPaths = agent.skill ? [agent.skill] : [];
  return {
    id: agent.profile,
    name: agent.name,
    allowedBins: binary ? [binary] : [],
    skillPaths,
    defaultTimeoutMs: agent.timeoutMs ?? (builtin ? 25 * 60_000 : undefined),
    systemPrompt: [
      builtin ? 'Create media with ' + builtin.bin + '. Inspect its help for the supported commands.' : '',
      ...skillPaths.map((file) => fs.readFileSync(file, 'utf8')),
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
