import type { ChatMessage } from '@buzz-botmux/chat-client';

export type LocalMessage = ChatMessage & { delivery?: 'sending' | 'queued' | 'failed' };

// A history request and its WebSocket run concurrently. Only replace rows that
// were unchanged while the request was in flight.
export function reconcileTimeline(canonical: ChatMessage[], atRequest: LocalMessage[], current: LocalMessage[]) {
  const before = new Map(atRequest.map(row => [row.id, row]));
  const live = new Map(current.map(row => [row.id, row]));
  const received = new Set(canonical.map(row => row.id));
  const rows: LocalMessage[] = [];
  for (const serverRow of canonical) {
    const now = live.get(serverRow.id);
    if (!now && before.has(serverRow.id)) continue;
    const changed = now && before.get(now.id) !== now && !now.delivery;
    rows.push(changed ? now : serverRow);
  }
  for (const row of current) {
    if (!received.has(row.id) && (row.delivery || before.get(row.id) !== row)) rows.push(row);
  }
  return rows;
}
