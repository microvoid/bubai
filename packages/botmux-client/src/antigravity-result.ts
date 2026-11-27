import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotmuxSession } from './index.js';

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CLOCK_SKEW_MS = 2_000;
const QUIET_MS = 1_000;
const NO_REPLY_QUIET_MS = 60_000;
const MAX_RECENT_LOGS = 32;
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const TASK_TOOLS = new Set(['manage_task', 'schedule']);
const INTERRUPTED = /^(?:USER_)?(?:INTERRUPTED|CANCELLED|CANCELED|ABORTED)$/;
const REQUEST_OPEN = '<USER_REQUEST>';
const REQUEST_CLOSE = '\n</USER_REQUEST>';
const HEADLESS_OPEN = '\n<botmux_headless_request>\n```json\n';
const HEADLESS_CLOSE = '\n```\n</botmux_headless_request>\n</user_message>';
const LOCAL_BOTMUX_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_BOTMUX_BACKENDS = new Set(['pty', 'tmux', 'herdr', 'zellij', 'zmx']);

interface ResultLookup {
  triggerId: string;
  botId: string;
  channelId: string;
  createdAt: Date;
  placeholderMessageId?: string;
  brainDir?: string;
}

interface TranscriptStep {
  type?: string;
  status?: string;
  source?: string;
  created_at?: string;
  content?: string;
  tool_calls?: Array<{ name?: string; function?: { name?: string } } | null>;
  truncated_fields?: string[];
}

type TurnOutcome = { status: 'completed'; content: string } | { status: 'no_reply' };

export function isLocalBotmuxEndpoint(endpoint: string): boolean {
  return URL.canParse(endpoint) && LOCAL_BOTMUX_HOSTS.has(new URL(endpoint).hostname);
}

export function isIdleLocalAntigravitySession(
  session: BotmuxSession | undefined,
  botId: string,
): session is BotmuxSession {
  return session?.larkAppId === botId && session.cliId === 'antigravity' &&
    session.state === 'idle' && !session.queued && !session.tuiPromptActive &&
    LOCAL_BOTMUX_BACKENDS.has(session.backendType ?? '');
}

function requestTimestamp(step: TranscriptStep, lookup: ResultLookup, earliest: number): number | undefined {
  const timestamp = Date.parse(step.created_at ?? '');
  const content = step.content;
  if (
    step.status !== 'DONE' ||
    !Number.isFinite(timestamp) ||
    timestamp < earliest ||
    timestamp > Date.now() + CLOCK_SKEW_MS ||
    typeof content !== 'string' ||
    !content.startsWith(REQUEST_OPEN) ||
    step.truncated_fields?.includes('content')
  ) {
    return undefined;
  }

  const closeAt = content.lastIndexOf(REQUEST_CLOSE);
  if (closeAt < 0) return undefined;
  const requestText = content.slice(REQUEST_OPEN.length, closeAt);
  const openAt = requestText.lastIndexOf(HEADLESS_OPEN);
  if (openAt < 0 || !requestText.endsWith(HEADLESS_CLOSE)) return undefined;

  try {
    const request = JSON.parse(requestText.slice(openAt + HEADLESS_OPEN.length, -HEADLESS_CLOSE.length));
    const conversation = request?.envelope?.payload?.conversation;
    if (
      request?.triggerId === lookup.triggerId &&
      request.source?.type === 'headless' &&
      request.source?.connectorId === 'buzz-botmux' &&
      request.envelope?.format === 'json' &&
      request.envelope.trusted === false &&
      request.options?.asyncReturnSessionId === true &&
      conversation?.channel?.id === lookup.channelId &&
      conversation.outboundApi?.channelId === lookup.channelId &&
      conversation.outboundApi?.botId === lookup.botId &&
      (lookup.placeholderMessageId === undefined ||
        conversation.outboundApi?.placeholderMessageId === lookup.placeholderMessageId)
    ) return timestamp;
  } catch {
    // Only a well-formed Botmux headless request can bind a result.
  }
}

function readOutcome(
  log: string,
  lookup: ResultLookup,
  earliest: number,
  noReplyBefore?: number,
): TurnOutcome | undefined {
  if (!log.endsWith('\n')) return undefined;

  let matchedAt: number | undefined;
  let found = false;
  let pendingTask = false;
  let interrupted = false;
  let sawActivity = false;
  let candidate: string | undefined;
  let result: string | undefined;

  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    const step = JSON.parse(line) as TranscriptStep | null;
    if (typeof step?.type !== 'string') return undefined;

    if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
      if (matchedAt !== undefined && !pendingTask && !interrupted) result = candidate;
      matchedAt = requestTimestamp(step, lookup, earliest);
      if (matchedAt !== undefined && found) return undefined;
      found ||= matchedAt !== undefined;
      pendingTask = false;
      interrupted = false;
      sawActivity = false;
      candidate = undefined;
      continue;
    }
    if (matchedAt === undefined || interrupted) continue;
    sawActivity = true;

    if (INTERRUPTED.test(step.type) || INTERRUPTED.test(step.status ?? '')) {
      interrupted = true;
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      candidate = undefined;
      if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
        // A foreground tool is evidence that the planner moved on from a background wait.
        if (step.tool_calls.some((call) => {
          const name = call?.name ?? call?.function?.name;
          return typeof name === 'string' && !TASK_TOOLS.has(name);
        })) pendingTask = false;
      } else if (
        (step.tool_calls === undefined || Array.isArray(step.tool_calls)) &&
        step.source === 'MODEL' &&
        step.status === 'DONE' &&
        Date.parse(step.created_at ?? '') >= matchedAt &&
        typeof step.content === 'string' &&
        !step.truncated_fields?.includes('content')
      ) {
        candidate = step.content.trim() || undefined;
      }
    } else if (step.type === 'GENERIC') {
      candidate = undefined;
      pendingTask ||= step.status === 'RUNNING' ||
        (typeof step.content === 'string' && /running as a background task/i.test(step.content));
    } else if (step.type === 'SYSTEM_MESSAGE' || step.type === 'ERROR_MESSAGE' || step.type === 'ERROR') {
      candidate = undefined;
      pendingTask = false;
    } else if (step.type !== 'CHECKPOINT' && step.type !== 'TASK_NOTIFICATION') {
      candidate = undefined;
    }
  }

  const answer = matchedAt === undefined ? result : candidate;
  if (answer !== undefined && !pendingTask && !interrupted) {
    return { status: 'completed', content: answer };
  }
  // Require the matching input to be the final entry in a quiet, full transcript.
  if (noReplyBefore !== undefined && matchedAt !== undefined && matchedAt <= noReplyBefore && !sawActivity) {
    return { status: 'no_reply' };
  }
}

async function locateTranscript(root: string, name: string) {
  const logDir = join(root, name, '.system_generated', 'logs');
  for (const filename of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const path = join(logDir, filename);
    try {
      const info = await stat(path);
      return info.isFile() ? { path, info, full: filename === 'transcript_full.jsonl' } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    }
  }
}

/** Only call after verifying the local Botmux session is idle. */
export async function readAntigravityTurnOutcome(lookup: ResultLookup): Promise<TurnOutcome | undefined> {
  const root = lookup.brainDir ?? join(homedir(), '.gemini', 'antigravity-cli', 'brain');
  const earliest = lookup.createdAt.getTime() - CLOCK_SKEW_MS;
  if (!Number.isFinite(earliest)) return undefined;

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const logs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && CONVERSATION_ID.test(entry.name))
    .map((entry) => locateTranscript(root, entry.name)));
  const now = Date.now();
  const quietBefore = now - QUIET_MS;
  const noReplyBefore = now - NO_REPLY_QUIET_MS;
  const recent = logs
    .filter((log) => log !== undefined)
    .filter((log) => log.info.mtimeMs >= earliest &&
      log.info.mtimeMs <= quietBefore && log.info.size <= MAX_LOG_BYTES)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, MAX_RECENT_LOGS);

  let result: TurnOutcome | undefined;
  for (const log of recent) {
    try {
      const content = await readFile(log.path, 'utf8');
      const latest = await stat(log.path);
      if (latest.ino !== log.info.ino || latest.mtimeMs !== log.info.mtimeMs || latest.size !== log.info.size) {
        continue;
      }
      const outcome = readOutcome(
        content,
        lookup,
        earliest,
        log.full && latest.mtimeMs <= noReplyBefore ? noReplyBefore : undefined,
      );
      if (!outcome) continue;
      if (result !== undefined) return undefined;
      result = outcome;
    } catch {
      // An incomplete or concurrently removed transcript can be retried on the next poll.
    }
  }
  return result;
}
