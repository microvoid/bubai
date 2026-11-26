import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  basenameOf,
  normalizeProgressSnapshot,
  truncateLabel,
  type AgentProgressSnapshot,
  type AgentProgressStep,
  type AgentProgressStepKind,
  type TurnProgressAdapter,
  type TurnProgressQuery,
} from './types.js';

const CLOCK_SKEW_MS = 2_000;
const MAX_RECENT_FILES = 20;
const MAX_FILE_BYTES = 24 * 1024 * 1024;

function mapClaudeTool(name: string, input: Record<string, unknown>): { kind: AgentProgressStepKind; label: string } {
  const desc = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined;
  const filePath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : undefined;

  if (name === 'Read') {
    return { kind: 'read', label: desc || (filePath ? `读取 ${basenameOf(filePath)}` : '读取文件') };
  }
  if (name === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : undefined;
    return { kind: 'shell', label: desc || (cmd ? truncateLabel(cmd, 64) : '执行终端命令') };
  }
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const verb = name === 'Write' ? '写入' : '编辑';
    return { kind: 'edit', label: desc || (filePath ? `${verb} ${basenameOf(filePath)}` : `${verb}文件`) };
  }
  if (name === 'Grep' || name === 'Glob') {
    const pat = typeof input.pattern === 'string' ? input.pattern : undefined;
    return { kind: 'search', label: desc || (pat ? `搜索 ${truncateLabel(pat, 48)}` : '搜索代码') };
  }
  if (name === 'WebSearch' || name === 'WebFetch') {
    const q = typeof input.query === 'string' ? input.query : undefined;
    return { kind: 'web', label: desc || (q ? `网页搜索 ${truncateLabel(q, 48)}` : '访问网页') };
  }
  if (name === 'Agent' || name === 'Task' || name === 'TodoWrite' || name === 'TaskCreate') {
    const subject = typeof input.subject === 'string' ? input.subject : undefined;
    return { kind: 'task', label: desc || subject || 'Async tasks running' };
  }
  return { kind: 'tool', label: desc || (name ? `调用 ${name}` : '执行工具') };
}

export function parseClaudeProgress(
  log: string,
  query: TurnProgressQuery,
): AgentProgressSnapshot | undefined {
  let matched = false;
  let totalTools = 0;
  const steps: AgentProgressStep[] = [];
  const stepById = new Map<string, AgentProgressStep>();

  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const msg = (entry.message && typeof entry.message === 'object'
      ? entry.message
      : entry) as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role : typeof entry.type === 'string' ? entry.type : '';
    const content = msg.content;

    if (role === 'user') {
      if (Array.isArray(content)) {
        let sawToolResult = false;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            sawToolResult = true;
            const target = stepById.get(b.tool_use_id);
            if (target) target.status = b.is_error ? 'failed' : 'done';
          }
        }
        if (sawToolResult) continue;
      }

      const rawText = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      if (rawText.includes(query.triggerId)) {
        matched = true;
        totalTools = 0;
        steps.length = 0;
        stepById.clear();
      } else if (matched) {
        break;
      }
      continue;
    }

    if (!matched) continue;

    if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_use') continue;
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const id = typeof b.id === 'string' ? b.id : `claude-${totalTools + 1}`;
        const input = (b.input && typeof b.input === 'object' && !Array.isArray(b.input)
          ? b.input
          : {}) as Record<string, unknown>;
        totalTools += 1;
        const mapped = mapClaudeTool(name, input);
        const step: AgentProgressStep = {
          id,
          kind: mapped.kind,
          label: mapped.label,
          status: 'running',
        };
        steps.push(step);
        stepById.set(id, step);
      }
    }
  }

  if (!matched || steps.length === 0) return undefined;

  const runningStep = [...steps].reverse().find((s) => s.status === 'running');
  return normalizeProgressSnapshot({
    activeLabel: runningStep?.label || steps[steps.length - 1]!.label,
    toolCount: totalTools,
    steps,
    updatedAt: Date.now(),
  });
}

async function collectRecentClaudeLogs(dir: string, earliest: number, depth = 0): Promise<Array<{ path: string; mtimeMs: number }>> {
  if (depth > 3) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const results: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectRecentClaudeLogs(full, earliest, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs >= earliest && info.size <= MAX_FILE_BYTES) {
        results.push({ path: full, mtimeMs: info.mtimeMs });
      }
    }
  }
  return results;
}

export const claudeProgressAdapter: TurnProgressAdapter = {
  id: 'claude',
  supports(cliId?: string) {
    return cliId === 'claude' || cliId === 'claude-code';
  },
  async readProgress(query: TurnProgressQuery) {
    const root = query.roots?.claude ?? join(homedir(), '.claude', 'projects');
    const earliest = query.createdAt.getTime() - CLOCK_SKEW_MS;
    if (!Number.isFinite(earliest)) return undefined;

    const files = (await collectRecentClaudeLogs(root, earliest))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_RECENT_FILES);

    for (const file of files) {
      try {
        const content = await readFile(file.path, 'utf8');
        if (!content.includes(query.triggerId)) continue;
        const progress = parseClaudeProgress(content, query);
        if (progress) return progress;
      } catch {
        // Ignore transient read errors while CLI is appending.
      }
    }
    return undefined;
  },
};
