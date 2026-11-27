import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { BotmuxClient, type TriggerRequest } from './index.js';

test('Antigravity gets reply instructions only when its runtime has a direct reply URL', async () => {
  const requests: TriggerRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/trigger') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    response.writeHead(200, { 'Set-Cookie': 'botmux-session=test' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new BotmuxClient('http://127.0.0.1:' + address.port, 'test-token');
    const turn = { botId: 'local_gemini', cliId: 'antigravity', prompt: 'reply', senderName: 'User' };
    const context = {
      channel: { id: 'test-channel', name: 'test', kind: 'public', topic: '' },
      outboundApi: { botId: 'bubai-gemini', channelId: 'test-channel', placeholderMessageId: 'reply-1' },
      messages: [],
    };
    const endpoint = 'http://example.invalid/api/bot/messages';

    await client.triggerTurn({ ...turn, context });
    await client.triggerTurn({ ...turn, context: { ...context, outboundApi: { ...context.outboundApi, endpoint } } });

    assert.doesNotMatch(requests[0]?.instruction ?? '', /\/api\/bot\/messages/);
    assert.deepEqual(requests[0]?.envelope?.payload, { message: 'reply', conversation: context });
    assert.ok(requests[1]?.instruction?.includes('POST ' + endpoint));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
