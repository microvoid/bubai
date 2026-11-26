import { describe, expect, test } from 'bun:test';
import {
  buildProxiedTerminalUrl,
  parseTerminalProxyPath,
  proxyTerminalHttpRequest,
  resolveTerminalUpstreamUrl,
} from './terminal-proxy';

describe('terminal-proxy', () => {
  test('rewrites local Botmux write-link onto public server origin and resolves back', () => {
    const proxied = buildProxiedTerminalUrl(
      'https://bubai.example.com/',
      'sess-123',
      'http://127.0.0.1:7891/term/sess-123?t=tok_abc',
    );
    expect(proxied).toBe(
      'https://bubai.example.com/api/terminal-proxy/sess-123/term/sess-123?t=tok_abc',
    );

    const parsed = parseTerminalProxyPath('/api/terminal-proxy/sess-123/term/sess-123');
    expect(parsed).toEqual({ sessionId: 'sess-123', restPath: '/term/sess-123' });

    const upstream = resolveTerminalUpstreamUrl(
      '/api/terminal-proxy/sess-123/term/sess-123',
      '?t=tok_abc',
      'http://127.0.0.1:7891',
    );
    expect(upstream).toBe('http://127.0.0.1:7891/term/sess-123?t=tok_abc');
  });

  test('forwards cached session token to sub-resources that omit query token', () => {
    buildProxiedTerminalUrl(
      'http://127.0.0.1:4000',
      'sess-tok',
      'http://10.0.0.2:8800/s/sess-tok?token=secret_123',
    );
    const subUpstream = resolveTerminalUpstreamUrl(
      '/api/terminal-proxy/sess-tok/s/sess-tok/xterm-5.5.0/xterm.css',
      '',
      'http://127.0.0.1:7891',
    );
    expect(subUpstream).toBe(
      'http://10.0.0.2:8800/s/sess-tok/xterm-5.5.0/xterm.css?token=secret_123',
    );
  });

  test('falls back to configured botmux endpoint for unregistered sessions', () => {
    const upstream = resolveTerminalUpstreamUrl(
      '/api/terminal-proxy/unknown-sess/ws',
      '?foo=1',
      'http://127.0.0.1:7891',
    );
    expect(upstream).toBe('http://127.0.0.1:7891/ws?foo=1');
  });

  test('strips frame-blocking headers on proxied HTTP responses', async () => {
    const fakeFetch = (async () =>
      new Response('<html>terminal</html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'",
        },
      })) as unknown as typeof fetch;

    const req = new Request('https://bubai.example.com/api/terminal-proxy/s1/');
    const res = await proxyTerminalHttpRequest(req, 'http://127.0.0.1:7891/', fakeFetch);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(await res.text()).toBe('<html>terminal</html>');
  });
});
