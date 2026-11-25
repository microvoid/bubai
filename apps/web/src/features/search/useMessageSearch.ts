import { useEffect, useState } from "react";
import type { ChatMessage } from "../messages/types";

type SearchResult = {
  messages: ChatMessage[];
  pending: boolean;
  failed: boolean;
};
const emptyResult: SearchResult = {
  messages: [],
  pending: false,
  failed: false,
};
const pendingResult: SearchResult = {
  messages: [],
  pending: true,
  failed: false,
};

export function useMessageSearch({
  serverHttp,
  query,
  channelId,
  currentUserId,
  open,
  attempt,
}: {
  serverHttp: string;
  query: string;
  channelId: string | undefined;
  currentUserId: string | undefined;
  open: boolean;
  attempt: number;
}): SearchResult {
  const params = new URLSearchParams({ q: query });
  if (channelId) params.set("channelId", channelId);
  if (currentUserId) params.set("userId", currentUserId);
  const url = open && query ? `${serverHttp}/api/search?${params}` : "";
  const [settled, setSettled] = useState<{
    url: string;
    attempt: number;
    result: SearchResult;
  }>();

  useEffect(() => {
    if (!url) {
      setSettled(undefined);
      return;
    }
    const abort = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) throw new Error("Message search failed");
        const data: { results: ChatMessage[] } = await response.json();
        if (!Array.isArray(data.results))
          throw new Error("Invalid search results");
        if (!abort.signal.aborted) {
          setSettled({
            url,
            attempt,
            result: { ...emptyResult, messages: data.results },
          });
        }
      } catch {
        if (!abort.signal.aborted) {
          setSettled({
            url,
            attempt,
            result: { ...emptyResult, failed: true },
          });
        }
      }
    }, 220);
    return () => {
      window.clearTimeout(timeout);
      abort.abort();
    };
  }, [url, attempt]);

  if (!url) return emptyResult;
  return settled?.url === url && settled.attempt === attempt
    ? settled.result
    : pendingResult;
}
