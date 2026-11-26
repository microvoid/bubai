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

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CLOCK_SKEW_MS = 2_000;
const MAX_RECENT_LOGS = 24;
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const REQUEST_OPEN = '<USER_REQUEST>';
const REQUEST_CLOSE = '\n</USER_REQUEST>';
const HEADLESS_OPEN = '\n<botmux_headless_request>\n```json\n';
const HEADLESS_CLOSE = '\n```\n</botmux_headless_request>\n</user_message>';

interface RawToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  args?: unknown;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface TranscriptStep {
  type?: string;
  status?: string;
  source?: string;
  created_at?: string;
  content?: string;
  tool_calls?: Array<RawToolCall | null>;
  truncated_fields?: string[];
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Partial or non-JSON arguments are fine; fall back to empty args.
    }
  }
  return {};
}

function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function mapAntigravityTool(call: RawToolCall): { kind: AgentProgressStepKind; label: string } {
  const rawName = (call.name ?? call.function?.name ?? '').trim();
  const name = rawName.replace(/^default_api:/, '');
  const args = parseArgs(call.arguments ?? call.args ?? call.function?.arguments);

  const summary = pickString(args, ['toolSummary', 'Description', 'description', 'Summary']);
  const filePath = pickString(args, ['Path', 'AbsolutePath', 'TargetFile', 'path', 'file_path']);
  const command = pickString(args, ['CommandLine', 'command', 'cmd']);
  const query = pickString(args, ['Query', 'query', 'Pattern', 'pattern']);
  const role = pickString(args, ['Role', 'role']);

  if (
    name === 'read_file' ||
    name === 'view_file' ||
    name === 'view_file_outline' ||
    name === 'view_code_item'
  ) {
    const fileLabel = filePath ? basenameOf(filePath) : '文件';
    return { kind: 'read', label: summary || `读取 ${fileLabel}` };
  }

  if (name === 'run_command' || name === 'command_status') {
    return {
      kind: 'shell',
      label: summary || (command ? truncateLabel(command, 64) : '执行终端命令'),
    };
  }

  if (
    name === 'edit_file' ||
    name === 'write_file' ||
    name === 'replace_file_content' ||
    name === 'multi_replace_file_content' ||
    name === 'write_to_file'
  ) {
    const fileLabel = filePath ? basenameOf(filePath) : '文件';
    const verb = name.startsWith('write') ? '写入' : '编辑';
    return { kind: 'edit', label: summary || `${verb} ${fileLabel}` };
  }

  if (name === 'grep_search' || name === 'find_by_name' || name === 'list_dir') {
    if (summary) return { kind: 'search', label: summary };
    if (query) return { kind: 'search', label: `搜索 ${truncateLabel(query, 48)}` };
    if (filePath) return { kind: 'search', label: `浏览 ${basenameOf(filePath)}` };
    return { kind: 'search', label: '检索代码库' };
  }

  if (name === 'search_web' || name === 'read_url_content') {
    if (summary) return { kind: 'web', label: summary };
    if (query) return { kind: 'web', label: `网页搜索 ${truncateLabel(query, 48)}` };
    return { kind: 'web', label: '读取网页内容' };
  }

  if (
    name === 'invoke_subagent' ||
    name === 'manage_task' ||
    name === 'manage_subagents' ||
    name === 'schedule' ||
    name === 'update_steps' ||
    name === 'run_workflow'
  ) {
    if (name === 'manage_task' || name === 'schedule') {
      return { kind: 'task', label: summary || 'Async tasks running' };
    }
    return {
      kind: 'task',
      label: summary || role || (name === 'update_steps' ? '更新任务进度' : '执行子任务'),
    };
  }

  return {
    kind: 'tool',
    label: summary || (name ? `调用 ${name}` : '执行工具'),
  };
}

function matchesTriggerRequest(
  step: TranscriptStep,
  query: TurnProgressQuery,
  earliest: number,
): boolean {
  const timestamp = Date.parse(step.created_at ?? '');
  const content = step.content;
  if (
    !Number.isFinite(timestamp) ||
    timestamp < earliest ||
    timestamp > Date.now() + CLOCK_SKEW_MS ||
    typeof content !== 'string' ||
    !content.startsWith(REQUEST_OPEN)
  ) {
    return false;
  }

  const closeAt = content.lastIndexOf(REQUEST_CLOSE);
  if (closeAt < 0) return false;
  const requestText = content.slice(REQUEST_OPEN.length, closeAt);
  const openAt = requestText.lastIndexOf(HEADLESS_OPEN);
  if (openAt < 0 || !requestText.endsWith(HEADLESS_CLOSE)) return false;

  try {
    const request = JSON.parse(
      requestText.slice(openAt + HEADLESS_OPEN.length, -HEADLESS_CLOSE.length),
    );
    const conversation = request?.envelope?.payload?.conversation;
    return (
      request?.triggerId === query.triggerId &&
      request.source?.type === 'headless' &&
      request.source?.connectorId === 'buzz-botmux' &&
      conversation?.channel?.id === query.channelId &&
      conversation?.outboundApi?.botId === query.botId
    );
  } catch {
    return false;
  }
}

export function parseAntigravityProgress(
  log: string,
  query: TurnProgressQuery,
): AgentProgressSnapshot | undefined {
  const earliest = query.createdAt.getTime() - CLOCK_SKEW_MS;
  let matched = false;
  let totalTools = 0;
  let hasBackgroundTask = false;
  const steps: AgentProgressStep[] = [];

  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step: TranscriptStep;
    try {
      step = JSON.parse(trimmed) as TranscriptStep;
    } catch {
      // Tail line might still be flushing to disk; ignore partial line.
      continue;
    }
    if (typeof step?.type !== 'string') continue;

    if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
      if (matchesTriggerRequest(step, query, earliest)) {
        matched = true;
        totalTools = 0;
        hasBackgroundTask = false;
        steps.length = 0;
      } else if (matched) {
        // Next turn started in the same conversation; stop at this boundary.
        break;
      }
      continue;
    }

    if (!matched) continue;

    if (step.type === 'PLANNER_RESPONSE' && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      // Previous batch finished once the planner emits a new tool batch.
      for (const prev of steps) {
        if (prev.status === 'running') prev.status = 'done';
      }
      hasBackgroundTask = false;

      for (const rawCall of step.tool_calls) {
        if (!rawCall) continue;
        totalTools += 1;
        const mapped = mapAntigravityTool(rawCall);
        steps.push({
          id: rawCall.id || `agy-${totalTools}`,
          kind: mapped.kind,
          label: mapped.label,
          status: step.status === 'DONE' ? 'done' : 'running',
        });
      }
    } else if (step.type === 'GENERIC') {
      const runningBg =
        step.status === 'RUNNING' ||
        (typeof step.content === 'string' && /running as a background task/i.test(step.content));
      if (runningBg) {
        hasBackgroundTask = true;
        const last = steps[steps.length - 1];
        if (!last || last.label !== 'Async tasks running') {
          steps.push({
            id: `agy-async-${steps.length + 1}`,
            kind: 'task',
            label: 'Async tasks running',
            status: 'running',
          });
        } else {
          last.status = 'running';
        }
      }
    } else if (step.type === 'PLANNER_RESPONSE' && step.source === 'MODEL' && step.status === 'DONE') {
      for (const prev of steps) {
        if (prev.status === 'running') prev.status = 'done';
      }
      hasBackgroundTask = false;
    }
  }

  if (!matched) return undefined;
  if (steps.length === 0 && totalTools === 0) return undefined;

  const runningStep = [...steps].reverse().find((s) => s.status === 'running');
  const activeLabel = hasBackgroundTask
    ? 'Async tasks running'
    : runningStep?.label || (steps.length > 0 ? steps[steps.length - 1]!.label : undefined);

  return normalizeProgressSnapshot({
    activeLabel,
    toolCount: totalTools || steps.length,
    steps,
    updatedAt: Date.now(),
  });
}

async function locateTranscript(root: string, name: string) {
  const logDir = join(root, name, '.system_generated', 'logs');
  // Prefer transcript_full.jsonl: compact transcript.jsonl truncates long USER_INPUT
  // prompts, which can chop the <botmux_headless_request> JSON block in half.
  for (const filename of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const path = join(logDir, filename);
    try {
      const info = await stat(path);
      if (info.isFile()) return { path, info };
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

export const antigravityProgressAdapter: TurnProgressAdapter = {
  id: 'antigravity',
  supports(cliId?: string) {
    return !cliId || cliId === 'antigravity' || cliId === 'agy';
  },
  async readProgress(query: TurnProgressQuery) {
    const root = query.roots?.antigravity ?? join(homedir(), '.gemini', 'antigravity-cli', 'brain');
    const earliest = query.createdAt.getTime() - CLOCK_SKEW_MS;
    if (!Number.isFinite(earliest)) return undefined;

    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const logs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && CONVERSATION_ID.test(entry.name))
        .map((entry) => locateTranscript(root, entry.name)),
    );

    const recent = logs
      .filter((log): log is NonNullable<typeof log> => Boolean(log))
      .filter((log) => log.info.mtimeMs >= earliest && log.info.size <= MAX_LOG_BYTES)
      .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
      .slice(0, MAX_RECENT_LOGS);

    for (const log of recent) {
      try {
        const content = await readFile(log.path, 'utf8');
        const progress = parseAntigravityProgress(content, query);
        if (progress) return progress;
      } catch {
        // Ignore transient read errors while CLI is appending.
      }
    }
    return undefined;
  },
};
