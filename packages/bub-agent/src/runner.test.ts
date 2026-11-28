import { expect, test } from 'bun:test';
import { createBubAgentRunner } from './runner.js';
import { resolveModel } from './config.js';
function reply(text: string) {
  const chunk = {
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
  };
  return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('Pi serializes conversation history, settles errors and aborts pending model requests', async () => {
  const seen: number[] = [];
  const model = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as { messages: unknown[] };
      seen.push(body.messages.length);
      return reply('hello');
    },
  });
  const config = {
    provider: 'openai',
    model: 'fixture',
    baseUrl: model.url.href,
    apiKey: 'dummy',
  };
  const provider = createBubAgentRunner(config, { concurrency: 2 });
  const invoke = (p: typeof provider, content: string, timeout = 3000) =>
    p.run({
      bindingKey: 'thread',
      content,
      signal: AbortSignal.timeout(timeout),
    });
  try {
    const results = await Promise.all([invoke(provider, 'first'), invoke(provider, 'second')]);
    expect(results.map((r) => r.content)).toEqual(['hello', 'hello']);
    expect(seen[1]).toBe(seen[0]! + 2);
    const broken = createBubAgentRunner(config, {
      streamFn() {
        throw new Error('fixture failure for ' + config.apiKey);
      },
    });
    expect(await invoke(broken, 'error')).toMatchObject({
      status: 'failed',
      content: expect.stringContaining('[redacted]'),
    });
    model.reload({ fetch: () => new Promise<Response>(() => {}) });
    const slow = createBubAgentRunner(config);
    expect((await invoke(slow, 'timeout', 80)).status).toBe('timeout');
    const pending = invoke(provider, 'cancel');
    provider.stop();
    expect((await pending).status).toBe('failed');
  } finally {
    model.stop(true);
    provider.stop();
  }
});

test('in-memory host receives tool progress and a notice', async () => {
  const { registerFauxProvider, fauxAssistantMessage, fauxToolCall, streamSimple } =
    await import('@mariozechner/pi-ai');
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('send_notice', { text: 'working' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('finished'),
  ]);
  const provider = createBubAgentRunner(
    { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test' },
    {
      streamFn: (_model, context, options) => streamSimple(faux.getModel(), context, options),
    },
  );
  try {
    const states: string[] = [];
    const notices: string[] = [];
    const result = await provider.run(
      {
        bindingKey: 'test',
        content: 'tool test',
        profile: {
          id: 'custom',
          name: 'fixture',
          allowedBins: [process.execPath],
          skillPaths: [],
          systemPrompt: '',
        },
        files: { inputs: [], output: process.cwd() },
      },
      {
        sendNotice: async (text) => {
          notices.push(text);
        },
        onProgress: async (snapshot) => {
          states.push(snapshot.steps[0]!.status);
        },
      },
    );
    expect(states).toEqual(['running', 'done']);
    expect(notices).toEqual(['working']);
    expect(result.content).toBe('finished');
  } finally {
    provider.stop();
    faux.unregister();
  }
});

test('model credentials stay scoped to the endpoint', () => {
  const config = {
    piModel: { model: 'test', provider: 'openai', apiKey: 'private' },
  };
  expect(() => resolveModel(config, { BUBAI_LLM_BASE_URL: 'http://other' })).toThrow('BUBAI_LLM_API_KEY');
});
