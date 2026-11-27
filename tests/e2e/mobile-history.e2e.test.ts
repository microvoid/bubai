import { test, expect } from 'bun:test';
import { BubaiClient } from '../../packages/chat-client/src';

test('mobile sends both history cursors when two messages share a timestamp', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const params = new URL(request.url).searchParams;
      const complete = params.get('before') === '42' && params.get('beforeId') === 'second';
      return Response.json({ messages: complete ? [{ id: 'first' }] : [], hasMore: false });
    },
  });
  try {
    const client = new BubaiClient({ baseUrl: server.url.href });
    const page = await client.getChannelMessages('room', { before: 42, beforeId: 'second' });
    expect(page.messages.map((m) => m.id)).toEqual(['first']);
  } finally {
    await server.stop(true);
  }
});
