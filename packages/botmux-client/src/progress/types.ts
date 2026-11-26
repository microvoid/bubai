export type AgentProgressStepKind =
  | 'read'
  | 'shell'
  | 'task'
  | 'search'
  | 'edit'
  | 'web'
  | 'tool';

export type AgentProgressStepStatus = 'running' | 'done' | 'failed';

export interface AgentProgressStep {
  id: string;
  kind: AgentProgressStepKind;
  label: string;
  status: AgentProgressStepStatus;
  detail?: string;
}

export interface AgentProgressSnapshot {
  activeLabel?: string;
  toolCount: number;
  steps: AgentProgressStep[];
  updatedAt?: number;
}

export interface TurnProgressQuery {
  cliId?: string;
  triggerId: string;
  botId: string;
  channelId: string;
  sessionId?: string;
  createdAt: Date;
  roots?: {
    antigravity?: string;
    codex?: string;
    claude?: string;
  };
}

export interface TurnProgressAdapter {
  readonly id: string;
  supports(cliId?: string): boolean;
  readProgress(query: TurnProgressQuery): Promise<AgentProgressSnapshot | undefined>;
}

const VALID_KINDS = new Set<AgentProgressStepKind>([
  'read',
  'shell',
  'task',
  'search',
  'edit',
  'web',
  'tool',
]);

const VALID_STATUSES = new Set<AgentProgressStepStatus>(['running', 'done', 'failed']);

const MAX_STEPS = 40;
const MAX_LABEL_LEN = 140;
const MAX_DETAIL_LEN = 240;

export function truncateLabel(input: string, maxLen = MAX_LABEL_LEN): string {
  const cleaned = input.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function basenameOf(pathLike: string): string {
  const normalized = pathLike.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/**
 * Validates and normalizes an external or adapter-produced progress payload
 * into the fixed server contract.
 */
export function normalizeProgressSnapshot(input: unknown): AgentProgressSnapshot | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];

  const windowedSteps = rawSteps.length > MAX_STEPS ? rawSteps.slice(-MAX_STEPS) : rawSteps;
  const steps: AgentProgressStep[] = [];
  for (let i = 0; i < windowedSteps.length; i += 1) {
    const item = windowedSteps[i];
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === 'string' ? truncateLabel(rec.label) : '';
    if (!label) continue;

    const kind: AgentProgressStepKind =
      typeof rec.kind === 'string' && VALID_KINDS.has(rec.kind as AgentProgressStepKind)
        ? (rec.kind as AgentProgressStepKind)
        : 'tool';
    const status: AgentProgressStepStatus =
      typeof rec.status === 'string' && VALID_STATUSES.has(rec.status as AgentProgressStepStatus)
        ? (rec.status as AgentProgressStepStatus)
        : 'done';
    const id =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id.trim().slice(0, 80)
        : `step-${i + 1}`;
    const detail =
      typeof rec.detail === 'string' && rec.detail.trim()
        ? truncateLabel(rec.detail, MAX_DETAIL_LEN)
        : undefined;

    steps.push(detail ? { id, kind, label, status, detail } : { id, kind, label, status });
  }

  const rawCount = typeof raw.toolCount === 'number' && Number.isFinite(raw.toolCount)
    ? Math.max(0, Math.floor(raw.toolCount))
    : steps.length;
  const toolCount = Math.max(rawCount, steps.length);

  const activeLabel =
    typeof raw.activeLabel === 'string' && raw.activeLabel.trim()
      ? truncateLabel(raw.activeLabel, 96)
      : undefined;

  if (!activeLabel && toolCount === 0 && steps.length === 0) {
    return undefined;
  }

  return {
    ...(activeLabel ? { activeLabel } : {}),
    toolCount,
    steps,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : Date.now(),
  };
}

/**
 * Transitions a live progress snapshot into a settled state while keeping
 * its collapsible tool-call trace intact on the completed/failed message.
 */
export function finalizeProgressSnapshot(
  progress: AgentProgressSnapshot | undefined,
  outcome: 'completed' | 'failed',
): AgentProgressSnapshot | undefined {
  if (!progress) return undefined;
  const settledStatus: AgentProgressStepStatus = outcome === 'completed' ? 'done' : 'failed';
  return {
    toolCount: Math.max(progress.toolCount, progress.steps.length),
    steps: progress.steps.map((step) =>
      step.status === 'running' ? { ...step, status: settledStatus } : step,
    ),
    updatedAt: Date.now(),
  };
}

/**
 * Structural equality ignoring `updatedAt` so callers skip redundant DB writes
 * and WebSocket broadcasts.
 */
export function progressSnapshotEquals(
  a: AgentProgressSnapshot | undefined,
  b: AgentProgressSnapshot | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.activeLabel !== b.activeLabel || a.toolCount !== b.toolCount) return false;
  if (a.steps.length !== b.steps.length) return false;
  for (let i = 0; i < a.steps.length; i += 1) {
    const sa = a.steps[i]!;
    const sb = b.steps[i]!;
    if (
      sa.id !== sb.id ||
      sa.kind !== sb.kind ||
      sa.label !== sb.label ||
      sa.status !== sb.status ||
      sa.detail !== sb.detail
    ) {
      return false;
    }
  }
  return true;
}
