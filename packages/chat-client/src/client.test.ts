import { describe, expect, test } from 'bun:test';
import { BubaiClient, normalizeServerUrl, toWebSocketUrl } from './client';
import type { ServerWsEvent, WsConnectionState } from './types';

describe('URL normalization', () => {
  test('normalizes bare host, trailing slash, and converts to ws/wss', () => {
    expect(normalizeServerUrl('localhost:4000/')).toBe('http://localhost:4000');
    expect(normalizeServerUrl('https://bubai.example.com///')).toBe('https://bubai.example.com');
    expect(toWebSocketUrl('http://127.0.0.1:4000')).toBe('ws://127.0.0.1:4000/ws');
    expect(toWebSocketUrl('https://bubai.example.com/')).toBe('wss://bubai.example.com/ws');
  });

  test('rejects empty server URL', () => {
    expect(() => normalizeServerUrl('   ')).toThrow();
  });
});

describe('BubaiClient REST', () => {
  test('fetches instance and bootstrap with optional bearer token', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get('authorization') });
      if (url.endsWith('/api/instance')) {
        return new Response(
          JSON.stringify({
            name: 'Bubai',
            version: '0.1.0',
            authRequired: false,
            botmux: { connected: true, authenticated: true, detail: 'ok' },
            capabilities: { terminalProxy: true, ws: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          channels: [],
          participants: [],
          sessions: [],
          asks: [],
          botmuxStatus: { endpoint: '', connected: true, authenticated: true, detail: 'ok' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = new BubaiClient({
      baseUrl: 'https://chat.bubai.dev/',
      token: 'secret-token',
      fetchImpl: fakeFetch,
    });

    const instance = await client.getInstance();
    expect(instance.name).toBe('Bubai');
    expect(instance.capabilities.terminalProxy).toBe(true);

    await client.bootstrap('u-owner');
    expect(calls[0]).toEqual({
      url: 'https://chat.bubai.dev/api/instance',
      auth: 'Bearer secret-token',
    });
    expect(calls[1]).toEqual({
      url: 'https://chat.bubai.dev/api/bootstrap?userId=u-owner',
      auth: 'Bearer secret-token',
    });
  });

  test('surfaces server error message on non-2xx responses', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const client = new BubaiClient({ baseUrl: 'http://localhost:4000', fetchImpl: fakeFetch });
    await expect(client.getAgentDetail('missing', 'u-owner')).rejects.toThrow('Agent not found');
  });
});

describe('BubaiClient WebSocket', () => {
  test('identifies on open, dispatches parsed events, and supports reconnectNow', () => {
    const instances: FakeWs[] = [];
    class FakeWs {
      readyState = 0;
      sent: string[] = [];
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      constructor(public url: string) {
        instances.push(this);
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
      }
      emitOpen() {
        this.readyState = 1;
        this.onopen?.({});
      }
      emitMessage(data: unknown) {
        this.onmessage?.({ data: JSON.stringify(data) });
      }
    }

    const events: ServerWsEvent[] = [];
    const states: WsConnectionState[] = [];
    const client = new BubaiClient({ baseUrl: 'http://localhost:4000' });
    const handle = client.connectWebSocket({
      userId: 'u-owner',
      onEvent: (e) => events.push(e),
      onStateChange: (s) => states.push(s),
      WebSocketImpl: FakeWs,
    });

    expect(instances.length).toBe(1);
    expect(instances[0].url).toBe('ws://localhost:4000/ws');
    instances[0].emitOpen();
    expect(JSON.parse(instances[0].sent[0])).toEqual({
      type: 'presence.identify',
      payload: { userId: 'u-owner' },
    });

    instances[0].emitMessage({ type: 'asks.updated', payload: { asks: [] } });
    expect(events).toEqual([{ type: 'asks.updated', payload: { asks: [] } }]);

    handle.reconnectNow();
    expect(instances.length).toBe(2);
    handle.close();
    expect(states[states.length - 1]).toBe('closed');
  });

  test('toggleReaction and searchMessages match server payload contracts', async () => {
    const calls: string[] = [];
    const client = new BubaiClient({
      baseUrl: 'http://localhost:4000',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/reactions')) {
          return new Response(
            JSON.stringify({
              messageId: 'm-1',
              reactions: [{ emoji: '👍', userIds: ['u-owner'] }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/api/search')) {
          return new Response(
            JSON.stringify({
              results: [{ id: 'm-1', channelId: 'c-1', senderId: 'u-owner', content: 'hello', createdAt: 1 }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });

    const reactionRes = await client.toggleReaction('m-1', '👍', 'u-owner');
    expect(reactionRes.messageId).toBe('m-1');
    expect(reactionRes.reactions?.[0]?.emoji).toBe('👍');

    const searchRes = await client.searchMessages('hello', 'u-owner');
    expect(searchRes.results.length).toBe(1);
    expect(searchRes.results[0].content).toBe('hello');
    expect(calls.length).toBe(2);
  });
});
