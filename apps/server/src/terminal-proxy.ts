/**
 * Reverse proxy helpers for exposing local Botmux Web Terminal (HTTP + WS)
 * through Bubai's single public-facing server origin.
 */

const sessionUpstreamOrigins = new Map<string, string>();
const sessionUpstreamTokens = new Map<string, string>();

export function registerSessionUpstream(sessionId: string, upstreamUrl: string): URL {
  const parsed = new URL(upstreamUrl);
  sessionUpstreamOrigins.set(sessionId, parsed.origin);
  if (parsed.searchParams.has('token') || parsed.searchParams.has('viewToken')) {
    const authParams = new URLSearchParams();
    const token = parsed.searchParams.get('token');
    const viewToken = parsed.searchParams.get('viewToken');
    if (token) authParams.set('token', token);
    if (viewToken) authParams.set('viewToken', viewToken);
    sessionUpstreamTokens.set(sessionId, authParams.toString());
  }
  return parsed;
}

export function buildProxiedTerminalUrl(
  publicOrigin: string,
  sessionId: string,
  upstreamUrl: string,
): string {
  const parsed = registerSessionUpstream(sessionId, upstreamUrl);
  const cleanOrigin = publicOrigin.replace(/\/+$/, '');
  const cleanPath = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
  return `${cleanOrigin}/api/terminal-proxy/${encodeURIComponent(sessionId)}${cleanPath}${parsed.search}`;
}

export function parseTerminalProxyPath(pathname: string): {
  sessionId: string;
  restPath: string;
} | null {
  const prefix = '/api/terminal-proxy/';
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  const slashIdx = remainder.indexOf('/');
  const rawSessionId = slashIdx === -1 ? remainder : remainder.slice(0, slashIdx);
  if (!rawSessionId) return null;
  const sessionId = decodeURIComponent(rawSessionId);
  const restPath = slashIdx === -1 ? '/' : remainder.slice(slashIdx);
  return { sessionId, restPath };
}

export function resolveTerminalUpstreamUrl(
  pathname: string,
  search: string,
  fallbackBotmuxEndpoint: string,
): string | null {
  const parsed = parseTerminalProxyPath(pathname);
  if (!parsed) return null;
  const origin =
    sessionUpstreamOrigins.get(parsed.sessionId) ||
    new URL(fallbackBotmuxEndpoint).origin;
  let finalSearch = search;
  const cachedToken = sessionUpstreamTokens.get(parsed.sessionId);
  if (cachedToken) {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    if (!params.has('token') && !params.has('viewToken')) {
      const authParams = new URLSearchParams(cachedToken);
      for (const [k, v] of authParams.entries()) {
        params.set(k, v);
      }
      const next = params.toString();
      finalSearch = next ? `?${next}` : '';
    }
  }
  return `${origin}${parsed.restPath}${finalSearch}`;
}

export async function proxyTerminalHttpRequest(
  req: Request,
  upstreamUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('upgrade');
  headers.delete('accept-encoding');

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: 'manual',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.arrayBuffer();
  }

  const upstream = await fetchImpl(upstreamUrl, init);
  const outHeaders = new Headers(upstream.headers);
  // Allow embedding inside Bubai Web iframe and Mobile WebView.
  outHeaders.delete('x-frame-options');
  outHeaders.delete('content-security-policy');
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}
