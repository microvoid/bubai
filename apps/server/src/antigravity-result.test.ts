import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAntigravityResult } from './antigravity-result.js';

const conversationId = '706093e6-0317-4b9f-9905-7dccf5b73141';
const triggerId = 'trg_test';
const botId = 'gemini';
const channelId = 'channel-1';
const createdAt = new Date(Date.now() - 20_000);
const inputTime = new Date(createdAt.getTime() + 1_000).toISOString();
const answerTime = new Date(createdAt.getTime() + 5_000).toISOString();
let brainDir: string;

beforeEach(async () => {
  brainDir = await mkdtemp(join(tmpdir(), 'buzz-antigravity-result-'));
});

afterEach(async () => {
  await rm(brainDir, { recursive: true, force: true });
});

function userInput(overrides: {
  triggerId?: string;
  botId?: string;
  channelId?: string;
  connectorId?: string;
  afterBotmuxBlock?: string;
} = {}) {
  const request = {
    triggerId: overrides.triggerId ?? triggerId,
    source: { type: 'headless', connectorId: overrides.connectorId ?? 'buzz-botmux' },
    envelope: {
      format: 'json',
      trusted: false,
      payload: { conversation: {
        channel: { id: channelId },
        outboundApi: { channelId: overrides.channelId ?? channelId, botId: overrides.botId ?? botId },
      } },
    },
    options: { asyncReturnSessionId: true },
  };
  return {
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    created_at: inputTime,
    content: [
      '<USER_REQUEST>',
      '<user_message>',
      '<botmux_headless_request>',
      '```json',
      JSON.stringify(request, null, 2),
      '```',
      '</botmux_headless_request>',
      ...(overrides.afterBotmuxBlock ? [overrides.afterBotmuxBlock] : []),
      '</user_message>',
      '</USER_REQUEST>',
      '<ADDITIONAL_METADATA>',
      'metadata',
      '</ADDITIONAL_METADATA>',
    ].join('\n'),
  };
}

function reply(content: string) {
  return {
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    created_at: answerTime,
    content,
  };
}

async function writeTranscript(
  steps: unknown[],
  { compact = false, partial = false } = {}
) {
  const dir = join(brainDir, conversationId, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  const path = join(dir, compact ? 'transcript.jsonl' : 'transcript_full.jsonl');
  const data = steps.map((step) => JSON.stringify(step)).join('\n');
  await writeFile(path, partial ? data : `${data}\n`);
  await utimes(path, new Date(answerTime), new Date(answerTime));
}

function readResult() {
  return readAntigravityResult({ triggerId, botId, channelId, createdAt, brainDir });
}

test('finds the exact turn and prefers the complete transcript', async () => {
  await writeTranscript([userInput(), reply('compact record')], { compact: true });
  await writeTranscript([
    userInput(),
    { ...reply('progress'), tool_calls: [{ name: 'run_command' }] },
    { type: 'GENERIC', status: 'DONE', content: 'tool result' },
    reply('Complete answer'),
    { type: 'CHECKPOINT' },
    userInput({ triggerId: 'trg_follow_up' }),
    reply('Answer to a different trigger'),
  ]);
  expect(await readResult()).toBe('Complete answer');
});

test('requires the matching final request block, connector, bot, and channel', async () => {
  await writeTranscript([
    userInput({ afterBotmuxBlock: 'outside the request block' }), reply('embedded request'),
    userInput({ connectorId: 'another-connector' }), reply('different connector'),
    userInput({ botId: 'another-bot' }), reply('different bot'),
    userInput({ channelId: 'another-channel' }), reply('different channel'),
  ]);
  expect(await readResult()).toBeUndefined();
});

test('waits for the real final after a background task and its continuation', async () => {
  const unfinished = [
    userInput(),
    { type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task' },
    reply('Provisional text'),
  ];
  await writeTranscript(unfinished);
  expect(await readResult()).toBeUndefined();

  await writeTranscript([...unfinished, { type: 'SYSTEM_MESSAGE', status: 'DONE' }]);
  expect(await readResult()).toBeUndefined();

  await writeTranscript([...unfinished, { type: 'SYSTEM_MESSAGE', status: 'DONE' }, reply('Finished')]);
  expect(await readResult()).toBe('Finished');
});

test('refuses interrupted, partial, and truncated finals', async () => {
  await writeTranscript([userInput(), reply('partial write')], { partial: true });
  await writeTranscript([userInput(), reply('outdated compact record')], { compact: true });
  expect(await readResult()).toBeUndefined();

  await writeTranscript([userInput(), reply('provisional'), { type: 'SYSTEM_MESSAGE', status: 'INTERRUPTED' }]);
  expect(await readResult()).toBeUndefined();

  await writeTranscript([userInput(), { ...reply('truncated'), truncated_fields: ['content'] }]);
  expect(await readResult()).toBeUndefined();
});

test('accepts a complete compact transcript when there is no full transcript', async () => {
  await writeTranscript([userInput(), reply('Compact final')], { compact: true });
  expect(await readResult()).toBe('Compact final');
});
