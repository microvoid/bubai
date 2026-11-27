import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TriggerRequest } from '@buzz-botmux/botmux-client';
import type { BubaiClient } from '@buzz-botmux/chat-client';
import { getConfigPath } from './config';

export type TurnCompletion = Parameters<BubaiClient['completeBotTurn']>[1];

export type PendingTurn = {
  messageId: string;
  agentId: string;
  bindingKey: string;
  deadline: number;
  createdAt?: number;
} & (
  | { stage: 'dispatch'; request: TriggerRequest }
  | { stage: 'poll'; sessionId: string; triggerId: string; acceptedAt: number }
  | { stage: 'direct' }
  | { stage: 'deliver'; completion: TurnCompletion }
);

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPendingTurn(value: unknown): value is PendingTurn {
  if (!value || typeof value !== 'object') return false;
  const turn = value as PendingTurn;
  if (typeof turn.messageId !== 'string' || typeof turn.agentId !== 'string' ||
      typeof turn.bindingKey !== 'string' || !Number.isFinite(turn.deadline) ||
      (turn.createdAt !== undefined && !Number.isFinite(turn.createdAt))) return false;
  switch (turn.stage) {
    case 'direct': return true;
    case 'dispatch':
      return turn.request?.target?.kind === 'turn' && turn.request.source?.type === 'headless' &&
        typeof turn.request.target.botId === 'string' && turn.request.envelope?.trusted === false;
    case 'poll':
      return typeof turn.sessionId === 'string' && typeof turn.triggerId === 'string' &&
        Number.isFinite(turn.acceptedAt);
    case 'deliver':
      return typeof turn.completion?.content === 'string' &&
        ['completed', 'failed', 'interrupted', 'timeout', 'dispatch_failed'].includes(turn.completion.status);
    default:
      return false;
  }
}

export function openTurnJournal(serverUrl: string, botmuxEndpoint: string) {
  const scope = hash(JSON.stringify([serverUrl, botmuxEndpoint]));
  const dir = path.join(path.dirname(getConfigPath()), 'bridge-turns', scope);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = (messageId: string) => path.join(dir, `${hash(messageId)}.json`);

  function read(file: string): PendingTurn | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isPendingTurn(value) && file === filename(value.messageId)) return value;
      console.error(`Invalid pending bridge turn ${path.basename(file)}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.error(`Could not read pending bridge turn ${path.basename(file)} (${code || 'invalid JSON'})`);
    }
  }

  return {
    get(messageId: string) {
      return read(filename(messageId));
    },
    list() {
      return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => read(path.join(dir, name)))
        .filter((turn): turn is PendingTurn => turn != null);
    },
    save(turn: PendingTurn) {
      const file = filename(turn.messageId);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(turn), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
    remove(messageId: string) {
      rmSync(filename(messageId), { force: true });
    },
  };
}
