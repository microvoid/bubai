import { BubaiClient } from '../../packages/chat-client/src';

// A loopback-only transport for exercising an actual interruption while a screen is mounted.
export function networkFixture(upstream: string, channelId: string, rootId: string) {
  const client = new BubaiClient({ baseUrl: upstream });
  const sockets = new Set<Bun.ServerWebSocket<{ upstream: WebSocket; queued: string[] }>>();
  let reconnectAt = 0;
  let mode = 'normal';
  let unexpectedCreates = 0;
  let receivedBearer = false;
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/test/session-mode' && request.method === 'POST') {
        const next = (await request.json()) as { mode: string };
        if (
          !['normal', 'session-outage', 'list-outage', 'expired', 'observe', 'offline'].includes(next.mode)
        ) {
          return new Response(null, { status: 400 });
        }
        mode = next.mode;
        if (mode === 'offline') for (const socket of sockets) socket.close();
        if (mode === 'observe') receivedBearer = false;
        return Response.json({ ok: true });
      }
      if (mode === 'offline') return new Response(null, { status: 503 });
      if (url.pathname === '/test/observations')
        return Response.json({ unexpectedCreates, receivedBearer });
      if (
        mode === 'observe' &&
        (request.headers.has('Authorization') || url.searchParams.has('token'))
      )
        receivedBearer = true;
      if (mode === 'session-outage' && url.pathname === '/api/auth/get-session')
        return Response.json({}, { status: 503 });
      if (mode === 'list-outage' && url.pathname === '/api/auth/organization/list')
        return Response.json({}, { status: 503 });
      if (mode === 'list-outage' && url.pathname === '/api/auth/organization/create')
        unexpectedCreates++;
      if (
        mode === 'expired' &&
        url.pathname.startsWith('/api/') &&
        url.pathname !== '/api/instance'
      ) {
        return Response.json({ error: 'Expired session fixture' }, { status: 401 });
      }
      if (url.pathname === '/test/interrupt' && request.method === 'POST') {
        const { thread } = (await request.json()) as { thread?: boolean };
        reconnectAt = Date.now() + 2500;
        for (const ws of sockets) ws.close(1012, 'Fixture network change');
        const content = 'Offline delivery ' + crypto.randomUUID().slice(0, 8);
        await client.sendBotMessage({
          botId: 'local-e2e',
          channelId,
          threadId: thread ? rootId : undefined,
          content,
        });
        return Response.json({ content });
      }
      if (url.pathname === '/ws' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (Date.now() < reconnectAt) return new Response(null, { status: 503 });
        const remote = new WebSocket(upstream.replace(/^http/, 'ws') + '/ws' + url.search);
        if (server.upgrade(request, { data: { upstream: remote, queued: [] as string[] } })) return;
        remote.close();
        return new Response(null, { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.delete('host');
      return fetch(upstream + url.pathname + url.search, {
        method: request.method,
        headers,
        body: ['HEAD', 'GET'].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: 'manual',
      });
    },
    websocket: {
      data: {} as { upstream: WebSocket; queued: string[] },
      open(ws) {
        sockets.add(ws);
        const remote = ws.data.upstream;
        remote.onmessage = (event) => {
          if (ws.readyState === 1) ws.send(String(event.data));
        };
        remote.onopen = () => {
          for (const frame of ws.data.queued.splice(0)) remote.send(frame);
        };
        remote.onclose = () => ws.close();
        remote.onerror = () => ws.close();
      },
      message(ws, raw) {
        const frame = raw.toString();
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(frame);
        else ws.data.queued.push(frame);
      },
      close(ws) {
        sockets.delete(ws);
        ws.data.upstream.close();
      },
    },
  });
}
