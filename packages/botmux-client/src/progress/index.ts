import { antigravityProgressAdapter } from './antigravity.js';
import { claudeProgressAdapter } from './claude.js';
import { codexProgressAdapter } from './codex.js';
import type {
  AgentProgressSnapshot,
  TurnProgressAdapter,
  TurnProgressQuery,
} from './types.js';

export * from './types.js';
export { antigravityProgressAdapter, parseAntigravityProgress } from './antigravity.js';
export { codexProgressAdapter, parseCodexProgress } from './codex.js';
export { claudeProgressAdapter, parseClaudeProgress } from './claude.js';

export const DEFAULT_PROGRESS_ADAPTERS: readonly TurnProgressAdapter[] = [
  antigravityProgressAdapter,
  codexProgressAdapter,
  claudeProgressAdapter,
];

/**
 * Adapter registry entry point: delegates CLI-specific step extraction to the
 * matching adapter and returns only the fixed AgentProgressSnapshot contract.
 */
export async function readTurnProgress(
  query: TurnProgressQuery,
  adapters: readonly TurnProgressAdapter[] = DEFAULT_PROGRESS_ADAPTERS,
): Promise<AgentProgressSnapshot | undefined> {
  const candidates = adapters.filter((adapter) => adapter.supports(query.cliId));
  for (const adapter of candidates) {
    const progress = await adapter.readProgress(query).catch(() => undefined);
    if (progress) return progress;
  }
  return undefined;
}
