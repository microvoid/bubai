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

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function mapCodexTool(name: string, rawArgs: unknown): { kind: AgentProgressStepKind; label: string } {
  const args = parseArgs(rawArgs);
  const cmd =
    typeof args.cmd === 'string'
      ? args.cmd
      : typeof args.command === 'string'
        ? args.command
        : Array.isArray(args.command)
          ? args.command.join(' ')
          : undefined;
  const path =
    typeof args.path === 'string'
      ? args.path
      : typeof args.file_path === 'string'
        ? args.file_path
        : undefined;

  if (name === 'exec_command' || name === 'shell_command' || name === 'shell') {
    return { kind: 'shell', label: cmd ? truncateLabel(cmd, 64) : '执行命令' };
  }
  if (name === 'apply_patch' || name === 'write_file' || name === 'edit_file') {
    return { kind: 'edit', label: path ? `编辑 ${basenameOf(path)}` : '修改代码补丁' };
  }
  if (name === 'read_file' || name === 'open') {
    return { kind: 'read', label: path ? `读取 ${basenameOf(path)}` : '读取文件' };
  }
  if (name === 'search' || name === 'grep' || name === 'find_files') {
    const q = typeof args.query === 'string' ? args.query : typeof args.pattern === 'string' ? args.pattern : '';
    return { kind: 'search', label: q ? `搜索 ${truncateLabel(q, 48)}` : '检索代码' };
  }
  if (name === 'spawn_agent' || name === 'wait' || name === 'update_plan') {
    return {
      kind: 'task',
      label: name === 'wait' ? 'Async tasks running' : name === 'update_plan' ? '更新执行计划' : '运行子任务',
    };
  }
  if (name.includes('web') || name.includes('search_query')) {
    return { kind: 'web', label: '检索网页信息' };
  }
  return { kind: 'tool', label: name ? `调用 ${name}` : '执行工具' };
}

export function parseCodexProgress(
  log: string,
  query: TurnProgressQuery,
): AgentProgressSnapshot | undefined {
  let matched = false;
  let totalTools = 0;
  const steps: AgentProgressStep[] = [];
  const stepByCallId = new Map<string, AgentProgressStep>();

  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const payload = (entry.payload && typeof entry.payload === 'object'
      ? entry.payload
      : entry) as Record<string, unknown>;
    const pType = typeof payload.type === 'string' ? payload.type : '';

    if (pType === 'message' && payload.role === 'user') {
      const text = JSON.stringify(payload.content ?? '');
      if (text.includes(query.triggerId)) {
        matched = true;
        totalTools = 0;
        steps.length = 0;
        stepByCallId.clear();
      } else if (matched) {
        break;
      }
      continue;
    }

    if (!matched) continue;

    if (pType === 'function_call' || pType === 'custom_tool_call') {
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      const callId = typeof payload.call_id === 'string' ? payload.call_id : `codex-${totalTools + 1}`;
      totalTools += 1;
      const mapped = mapCodexTool(name, payload.arguments ?? payload.input);
      const step: AgentProgressStep = {
        id: callId,
        kind: mapped.kind,
        label: mapped.label,
        status: 'running',
      };
      steps.push(step);
      stepByCallId.set(callId, step);
    } else if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const step = stepByCallId.get(callId);
      if (step) step.status = 'done';
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

async function collectRecentRollouts(dir: string, earliest: number, depth = 0): Promise<Array<{ path: string; mtimeMs: number }>> {
  if (depth > 4) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const results: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectRecentRollouts(full, earliest, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs >= earliest && info.size <= MAX_FILE_BYTES) {
        results.push({ path: full, mtimeMs: info.mtimeMs });
      }
    }
  }
  return results;
}

export const codexProgressAdapter: TurnProgressAdapter = {
  id: 'codex',
  supports(cliId?: string) {
    return cliId === 'codex' || cliId === 'codex-app';
  },
  async readProgress(query: TurnProgressQuery) {
    const root = query.roots?.codex ?? join(homedir(), '.codex', 'sessions');
    const earliest = query.createdAt.getTime() - CLOCK_SKEW_MS;
    if (!Number.isFinite(earliest)) return undefined;

    const files = (await collectRecentRollouts(root, earliest))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_RECENT_FILES);

    for (const file of files) {
      try {
        const content = await readFile(file.path, 'utf8');
        if (!content.includes(query.triggerId)) continue;
        const progress = parseCodexProgress(content, query);
        if (progress) return progress;
      } catch {
        // Ignore transient read errors while CLI is appending.
      }
    }
    return undefined;
  },
};
