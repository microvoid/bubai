import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BotTurnRequestedEvent } from '@buzz-botmux/chat-client';
import { createPiProvider } from './bridge-pi';
import { resolvePiModel } from './config';

function turn(botId: string, messageId: string): BotTurnRequestedEvent {
  return {
    type: 'turn.requested',
    botId,
    threadId: 'thread',
    channel: { id: 'channel' },
    triggerMessage: { content: messageId, attachments: [] },
    replyTarget: { messageId },
    history: [],
  } as unknown as BotTurnRequestedEvent;
}

function reply(text: string) {
  const chunk = {
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
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
  const config = { provider: 'openai', model: 'fixture', baseUrl: model.url.href, apiKey: 'dummy' };
  const profile = [{ externalId: 'bot', name: 'Test', profile: 'default' }];
  const provider = createPiProvider('scope', profile, config, 2, 3000);
  const invoke = (p: typeof provider, id: string) => {
    const event = turn('bot', id);
    return p.executeTurn({ event, initial: p.prepareTurn(event), progress: async () => {} });
  };
  try {
    const results = await Promise.all([invoke(provider, 'first'), invoke(provider, 'second')]);
    expect(results.map((r) => r.content)).toEqual(['hello', 'hello']);
    expect(seen[1]).toBe(seen[0]! + 2);
    const broken = createPiProvider('scope', profile, config, 1, 1000, {
      streamFn() {
        throw new Error('fixture failure');
      },
    });
    expect((await invoke(broken, 'error')).status).toBe('failed');
    model.reload({ fetch: () => new Promise<Response>(() => {}) });
    const slow = createPiProvider('scope', profile, config, 1, 80);
    expect((await invoke(slow, 'timeout')).status).toBe('timeout');
    const pending = invoke(provider, 'cancel');
    provider.stop();
    expect((await pending).status).toBe('failed');
  } finally {
    model.stop(true);
    provider.stop();
  }
});

test('Pi streams tool start and finish through the bridge progress callback', async () => {
  const { registerFauxProvider, fauxAssistantMessage, fauxToolCall, streamSimple } =
    await import('@mariozechner/pi-ai');
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('fixture', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('finished'),
  ]);
  const provider = createPiProvider(
    'scope',
    [{ externalId: 'bot', name: 'Test', profile: 'default' }],
    { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test' },
    1,
    3000,
    { streamFn: (_model, context, options) => streamSimple(faux.getModel(), context, options) },
  );
  try {
    const event = turn('bot', 'tool test');
    const states: string[] = [];
    const result = await provider.executeTurn({
      initial: provider.prepareTurn(event),
      event,
      progress: async (snapshot) => {
        states.push(snapshot.steps[0]!.status);
      },
    });
    expect(states).toEqual(['running', 'failed']);
    expect(result.content).toBe('finished');
  } finally {
    provider.stop();
    faux.unregister();
  }
});

test('model credentials stay scoped to the endpoint', () => {
  const config = { piModel: { model: 'test', provider: 'openai', apiKey: 'private' } };
  expect(() => resolvePiModel(config, { BUBAI_LLM_BASE_URL: 'http://other' })).toThrow('BUBAI_LLM_API_KEY');
});

test.each([false, true])(
  'packaged bub start auto handles an empty PATH (wrap=%s)',
  async (wrap) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bub-pi-e2e-'));
  const entry = path.join(dir, 'bub.mjs');
  const build = Bun.spawn(['npm','run','build','--','--outfile=' + entry], {
    cwd:path.resolve(import.meta.dir, '..'),stdout:'ignore',stderr:'inherit',
  });
  expect(await build.exited).toBe(0);
    const done = Promise.withResolvers<{ status: string; content: string }>();
    const node = Bun.which('node')!;
    const binary = path.join(dir, 'fixture-cli');
    const skill = path.join(dir, 'SKILL.md');
    writeFileSync(skill, 'Fixture media generator instructions');
    writeFileSync(
      binary,
      '#!' +
        node +
        '\n' +
        `const fs=require('fs');if(process.env.BUBAI_LLM_API_KEY)process.exit(2);
    const text=fs.readFileSync(JSON.parse(process.env.BUBAI_INPUT_FILES)[0],'utf8');
    fs.writeFileSync(process.env.BUBAI_OUTPUT_DIR+'/art.txt',text+process.argv[2]);`,
      { mode: 0o700 },
    );
    const commands = [
      ['cli_exec', { bin: 'fixture-cli', args: ['; echo untouched'] }],
      ['artifact_emit', { path: 'art.txt', mimeType: 'text/plain' }],
      ['send_notice', { text: 'working' }],
      ['ask_user', { question: 'Continue?', options: ['yes', 'no'] }],
    ] as const;
    let modelCalls = 0;
    let artifact = '';
    let noticeThread: string | undefined;
    let sendAnswer: (id: string) => void;
    let outputDir = '';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/ws/bot' && srv.upgrade(req)) return;
        if (url.pathname.endsWith('/chat/completions')) {
          if (!wrap) return reply('default bot online');
          const modelRequest = await req.text();
          if (!modelRequest.includes('Fixture media generator instructions'))
            return new Response(null, { status: 400 });
          const input = JSON.parse(modelRequest).messages.find((m: { role: string }) => m.role === 'user');
          outputDir = (Array.isArray(input.content) ? input.content[0].text : input.content).split(
            'Output directory: ',
          )[1];
          const command = commands[modelCalls++];
          if (!command) return reply('default bot online');
          const [name, args] = command;
          const delta = {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_' + modelCalls,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          };
          return new Response(
            'data: ' +
              JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] }) +
              '\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        if (url.pathname === '/api/bot/asks') {
          sendAnswer((await req.json()).askId);
          return Response.json({ ok: true });
        }
        if (url.pathname === '/api/bot/messages') {
          noticeThread = (await req.json()).threadId;
          return Response.json({});
        }
        if (url.pathname.endsWith('/progress')) return Response.json({ ok: true });
        if (url.pathname === '/api/uploads' && req.method === 'POST') {
          const file = (await req.formData()).get('file') as File;
          artifact = await file.text();
          return Response.json({
            attachment: {
              id: 'out',
              name: file.name,
              mimeType: file.type,
              size: file.size,
              url: '/api/uploads/out',
            },
          });
        }
        if (
          url.pathname === '/api/uploads/input-reference.txt' &&
          req.headers.get('Authorization') === 'Bearer bot_fixture'
        )
          return new Response('reference');

        if (url.pathname.endsWith('/complete')) {
          done.resolve(await req.json());
          return Response.json({ ok: true });
        }
        return new Response(null, { status: 404 });
      },
      websocket: {
        message(ws, frame) {
          const msg = JSON.parse(String(frame));
          if (msg.type !== 'bot.hello') return;
          const bot = msg.payload.agents[0].id;
          ws.send(
            JSON.stringify({ type: 'bot.welcome', payload: { connectionId: 'test', agentIds: [bot] } }),
          );
          sendAnswer = (id) =>
            ws.send(
              JSON.stringify({
                type: 'ask.answered',
                payload: { askId: id, larkAppId: bot, selections: [['yes']] },
              }),
            );
          const event = turn(bot, 'hello');
          event.triggerMessage.id = 'source';
          if (wrap)
            event.triggerMessage.attachments = [
              {
                id: 'input',
                name: 'reference.txt',
                url: '/api/uploads/input-reference.txt',
                mimeType: 'text/plain',
                size: 9,
              },
            ];
          ws.send(JSON.stringify(event));
        },
      },
    });
    const env = {
      ...process.env,
      PATH: dir,
      BUBAI_CONFIG_DIR: dir,
      BUBAI_LLM_API_KEY: 'fixture',
      BUBAI_LLM_BASE_URL: server.url.href,
      BUBAI_LLM_PROVIDER: 'openai',
      BUBAI_LLM_MODEL: 'fixture',
    };
    const invoke = async (...args: string[]) => {
      const output = path.join(dir, args[0] + '.stdout');
      const errors = path.join(dir, args[0] + '.stderr');
      const p = Bun.spawn([node, entry, ...args], {
        env,
        stdout: Bun.file(output),
        stderr: Bun.file(errors),
      });
      const code = await p.exited;
      const stdout = await Bun.file(output).text();
      const stderr = await Bun.file(errors).text();
      if (code) throw new Error(stdout + stderr);
      return stdout;
    };
    try {
      if (wrap) await invoke('agent', 'wrap', '--bin', binary, '--skill', skill, '--name', 'Fixture');
      expect(
        await invoke(
          'start',
          '--mode',
          'auto',
          '--bot-token',
          'bot_fixture',
          '--server',
          server.url.href,
          '--botmux',
          server.url.href,
        ),
      ).toContain('Bridge online');
      const completion = await done.promise;
      expect(completion).toMatchObject({ status: 'completed', content: 'default bot online' });
      if (wrap) {
        expect(completion).toMatchObject({ attachments: [{ name: 'art.txt' }] });
        expect(artifact).toBe('reference; echo untouched');
        expect(noticeThread).toBe('thread');
        expect(existsSync(outputDir)).toBe(false);
      }
    } finally {
      await invoke('stop');
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);

test('tools deny other executables and escaped artifacts, and cancel an unanswered ask', async () => {
  const { piTools, askRegistry } = await import('./pi-tools');
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const root = mkdtempSync(path.join(tmpdir(), 'pi-tool-deny-'));
  const output = path.join(root, 'output');
  mkdirSync(output);
  writeFileSync(path.join(root, 'private'), 'private');
  symlinkSync(path.join(root, 'private'), path.join(output, 'linked'));
  const event = turn('bot', 'msg');
  const controller = new AbortController();
  const asks = askRegistry();
  const ctx = {
    event,
    initial: { agentId: 'bot', messageId: 'msg' },
    files: { root, output, inputs: [], artifacts: [] },
    sdk: { createBotAsk: async () => ({}) },
  } as unknown as import('./bridge-provider').TurnContext;
  const tools = piTools(
    { id: 'test', name: 'test', allowedBins: [], systemPrompt: '', skillPaths: [], defaultTimeoutMs: 100 },
    ctx,
    root,
    controller.signal,
    asks,
  );
  const call = (name: string, args: unknown) => tools.find((t) => t.name === name)!.execute('call', args);
  try {
    await expect(call('cli_exec', { bin: 'sh', args: [] })).rejects.toThrow('not allowed');
    await expect(call('artifact_emit', { path: 'linked' })).rejects.toThrow('output directory');
    const answer = call('ask_user', { question: 'continue?', options: ['yes', 'no'] });
    controller.abort(new Error('cancelled'));
    await expect(answer).rejects.toThrow('cancelled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('input limits use streamed size and temporary files are removed on failure', async () => {
  const { withTurnFiles } = await import('./bridge-attachments');
  const event = turn('agent', 'reference');
  event.triggerMessage.attachments = [
    { id: 'test', name: '../../unsafe.txt', mimeType: 'text/plain', size: 0, url: '/api/uploads/test' },
  ];
  const block = new Uint8Array(1024 * 1024);
  let remaining = 65;
  const sdk = {
    downloadTurnAttachment: async () =>
      new ReadableStream<typeof block>({
        pull(controller) {
          if (remaining-- > 0) controller.enqueue(block);
          else controller.close();
        },
      }),
  };
  const signal = AbortSignal.timeout(5000);
  await expect(withTurnFiles(event, sdk, signal, async () => {})).rejects.toThrow('64 MiB');
  remaining = 1;
  let dir = '';
  await expect(
    withTurnFiles(event, sdk, signal, async (files) => {
      dir = files.root;
      expect(path.dirname(files.inputs[0]!)).toBe(dir);
      throw new Error('fixture abort');
    }),
  ).rejects.toThrow('fixture abort');
  expect(existsSync(dir)).toBe(false);
});
