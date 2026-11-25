/**
 * Ported from references/buzz-app/src/features/messages/reply-tree.ts
 * Thinly adapted for ChatMessage (`replyToId`), keeping backward compatibility
 * with historical replies that only have `threadId` (no `replyToId` -> top-level reply).
 */
import type { ChatMessage } from './types';

/**
 * A forest of the available history, never a claim that all parents were loaded.
 * Branches are one level deep: a reply to a nested reply joins its branch, in
 * order, so continuing a conversation never drifts further in.
 */
export function replyTree(rows: readonly ChatMessage[], rootId?: string) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parentOf = (row: ChatMessage | undefined) => row?.replyToId;
  const parents = new Map<string, string>();
  const children = new Map<string | undefined, ChatMessage[]>();

  for (const row of rows) {
    let parent = parentOf(row);
    if (parent === rootId || !parent || !byId.has(parent)) parent = undefined;

    // Malformed ancestry must not hide rows or recurse forever.
    const seen = new Set([row.id]);
    let cursor = parent;
    while (cursor) {
      if (seen.has(cursor)) {
        parent = undefined;
        break;
      }
      seen.add(cursor);
      cursor = parentOf(byId.get(cursor));
    }

    // Lift deeper replies to their 1st-level branch (matching Buzz's exact rule).
    while (parent) {
      const next = parentOf(byId.get(parent));
      if (!next || next === rootId || !byId.has(next)) break;
      parent = next;
    }

    if (parent) parents.set(row.id, parent);
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }

  return {
    children,
    parents,
    ancestors(id: string) {
      const result: string[] = [];
      let parent = parents.get(id);
      while (parent) {
        result.push(parent);
        parent = parents.get(parent);
      }
      return result;
    },
  };
}
