import { test, expect } from 'bun:test';
import { TurnLimiter } from './local-process.js';
import { PiHistory } from './pi-history.js';
import { isMediaQuery } from './media-queries.js';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

test('queued turns cancel immediately while another turn holds capacity', async () => {
  const limiter = new TurnLimiter(1);
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const active = limiter.run('one', new AbortController().signal, () => gate.promise);
  const stop = new AbortController();
  const same = limiter.run('one', stop.signal, async () => calls.push('cancelled'));
  const other = limiter.run('two', AbortSignal.timeout(20), async () => calls.push('expired'));
  const survivors = ['one', 'two'].map((key) =>
    limiter.run(key, new AbortController().signal, async () => calls.push(key)),
  );
  stop.abort();
  await expect(same).rejects.toHaveProperty('name', 'AbortError');
  await expect(other).rejects.toHaveProperty('name', 'TimeoutError');
  expect(calls).toEqual([]);
  gate.resolve();
  await active;
  await Promise.all(survivors);
  expect(calls).toEqual(['one', 'two']);
});

test('history evicts least recently used sessions and trims whole user turns', () => {
  const history = new PiHistory(2, 1024, 3);
  const user = (content: string): AgentMessage => ({
    role: 'user',
    content,
    timestamp: 1,
  });
  const result = {
    role: 'toolResult',
    content: [{ type: 'text', text: 'x' }],
  } as AgentMessage;
  const messages = [user('one'), result, user('two'), result];
  history.set('a', messages);
  history.set('b', [user('b')]);
  expect(history.get('a')).toEqual(messages.slice(2));
  history.set('c', [user('c')]);
  expect(history.get('b')).toBeUndefined();
  history.set('a', [
    user('a'),
    {
      ...result,
      content: [{ type: 'text', text: 'x'.repeat(1500) }],
    } as AgentMessage,
  ]);
  const compacted = history.get('a')!;
  expect(compacted[0]).toEqual(user('a'));
  expect(JSON.stringify(compacted)).toContain('[truncated]');
  expect(Buffer.byteLength(JSON.stringify(compacted))).toBeLessThan(1024);
  history.set('a', [...compacted, user('x'.repeat(2048))]);
  expect(history.get('a')).toEqual(compacted);
});

test('a turn over 256 KiB keeps each tool result paired with its call', () => {
  const history = new PiHistory();
  const messages: AgentMessage[] = [{ role: 'user', content: 'render', timestamp: 1 }];
  for (let i = 0; i < 12; i++) {
    const id = String(i);
    messages.push(
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id, name: 'cli_exec', arguments: {} }],
      } as AgentMessage,
      {
        role: 'toolResult',
        toolCallId: id,
        toolName: 'cli_exec',
        content: [{ type: 'text', text: 'x'.repeat(32768) }],
        isError: false,
        timestamp: 1,
      },
    );
  }
  history.set('a', messages);
  const saved = history.get('a')!;
  expect(saved.map((m) => (m.role === 'toolResult' ? m.toolCallId : m))).toEqual(
    messages.map((m) => (m.role === 'toolResult' ? m.toolCallId : m)),
  );
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(256 * 1024);
});

test('media queries recognize full argv only', () => {
  expect(isMediaQuery('dreamina', ['operation', 'status', 'op-123', '--project-id', 'proj-1'])).toBe(true);
  expect(isMediaQuery('dreamina', ['model', 'list', '--type', 'image', '--format', 'json'])).toBe(true);
  for (const args of [
    ['schema'],
    ['schema', '--format', 'json'],
    ['auth', 'account'],
    ['model', 'find', '图像', 'v2', '--type', 'image'],
  ]) {
    expect(isMediaQuery('dreamina', args)).toBe(true);
  }
  expect(isMediaQuery('libtv', ['project', 'list', '-p', '1'])).toBe(true);
  for (const args of [
    ['model', 'list', '--yes'],
    ['schema', 'show'],
    ['auth', 'account', '--yes'],
    ['model', 'find', '--type', 'image'],
    ['model', 'find', 'v2', '--write'],
    ['operation', 'status', '--unknown'],
    ['node', 'run', '--help'],
    ['canvas', 'create'],
  ]) {
    expect(isMediaQuery('dreamina', args)).toBe(false);
  }
  expect(isMediaQuery('libtv', ['project', 'list', '--unknown'])).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'termination gives a tool a chance to release resources before force killing it',
  async () => {
    const { spawn } = await import('node:child_process');
    const { stopProcessGroup } = await import('./local-process.js');
    const child = spawn(
      Bun.which('node')!,
      [
        '-e',
        `
    process.on('SIGTERM', () => process.stdout.write('cleanup'));
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const exit = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (_, signal) => resolve(signal));
    });
    let output = '';
    child.stdout.on('data', (part) => {
      output += part;
    });
    try {
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      await stopProcessGroup(child.pid!);
      expect(await exit).toBe('SIGKILL');
      expect(output).toBe('readycleanup');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  },
);
