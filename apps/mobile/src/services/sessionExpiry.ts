type Handler = (url: string, token: string) => void;
const handlers = new Set<Handler>();

export function onSessionExpired(handler: Handler) {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function checkSessionResponse(status: number, url: string, token?: string | null) {
  if (status === 401 && token) for (const handler of handlers) handler(url, token);
}
