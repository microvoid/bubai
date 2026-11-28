import type { AgentMessage } from '@mariozechner/pi-agent-core';

// Keep complete user turns so a tool result is never separated from its call.
export class PiHistory {
  private readonly sessions = new Map<string, AgentMessage[]>();
  constructor(
    private readonly capacity = 128,
    private readonly bytes = 256 * 1024,
    private readonly count = 64,
  ) {}

  get(key: string) {
    const value = this.sessions.get(key);
    if (value) {
      this.sessions.delete(key);
      this.sessions.set(key, value);
    }
    return value;
  }

  set(key: string, messages: AgentMessage[]) {
    const kept: AgentMessage[][] = [];
    let remaining = this.bytes;
    let end = messages.length;
    for (let i = end - 1; i >= 0 && messages.length - i <= this.count; i--) {
      if (messages[i]!.role !== 'user') continue;
      let turn = messages.slice(i, end);
      let size = Buffer.byteLength(JSON.stringify(turn));
      if (!kept.length && size > remaining) {
        // Compact only the stored copy. Keep the tool IDs paired with their calls.
        const limit = Math.min(1024, Math.floor(remaining / (turn.length * 8)));
        turn = turn.map((message) => {
          if (message.role !== 'toolResult' || Buffer.byteLength(JSON.stringify(message)) <= limit)
            return message;
          const first = message.content.find((block) => block.type === 'text');
          const text = (first?.text.slice(0, limit) ?? '') + '… [truncated]';
          return { ...message, details: undefined, content: [{ type: 'text', text }] };
        });
        size = Buffer.byteLength(JSON.stringify(turn));
      }
      if (size > remaining) break;
      kept.push(turn);
      remaining -= size;
      end = i;
    }
    // A single uncacheable turn must not evict the previous usable conversation.
    if (!kept.length) return;
    this.sessions.delete(key);
    this.sessions.set(key, kept.reverse().flat());
    if (this.sessions.size > this.capacity) this.sessions.delete(this.sessions.keys().next().value!);
  }
}
