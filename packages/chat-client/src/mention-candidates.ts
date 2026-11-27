export interface MentionCandidate {
  id: string;
  name: string;
  role: 'human' | 'agent';
  avatarUrl?: string;
  cliId?: string;
  status: 'online' | 'offline';
  archived?: boolean;
  /** Whether this candidate belongs to the active channel (defaults to true). */
  inChannel?: boolean;
  /** Latest activity timestamp (ms) in the current thread; boosted above channel activity. */
  threadActiveAt?: number;
  /** Latest activity timestamp (ms) in the current channel. */
  lastActiveAt?: number;
}

export interface MentionSourceParticipant {
  id: string;
  name: string;
  role: 'human' | 'agent';
  avatarUrl?: string;
  cliId?: string;
  status: 'online' | 'offline';
  archived?: boolean;
}

export interface MentionActivityMessage {
  senderId: string;
  createdAt: number;
  content?: string;
  mentionedIds?: readonly string[];
}

export type ChannelMembersState = 'ready' | 'loading' | 'error';

export interface BuildMentionCandidatesInput {
  participants: readonly MentionSourceParticipant[];
  currentUserId: string;
  channelKind?: 'channel' | 'dm';
  dmKey?: string;
  channelMemberIds?: ReadonlySet<string>;
  channelMembersState?: ChannelMembersState;
  channelMessages?: readonly MentionActivityMessage[];
  threadMessages?: readonly MentionActivityMessage[];
}

function parseDmPeerIds(dmKey: string | undefined, currentUserId: string): Set<string> {
  const peers = new Set<string>();
  if (!dmKey) return peers;
  for (const part of dmKey.split('|')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    const id = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
    if (id && id !== currentUserId) {
      peers.add(id);
    }
  }
  return peers;
}

const ASCII_WORD_CHAR = /[A-Za-z0-9_]/;
const EMAIL_LOCAL_CHAR = /[A-Za-z0-9._+-]/;

interface MentionMatcherEntry {
  id: string;
  tokens: string[];
}

function buildMentionMatchers(
  participants: readonly MentionSourceParticipant[],
): MentionMatcherEntry[] {
  return participants.map((p) => {
    const raw = [p.name, p.cliId, p.id];
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const value of raw) {
      const normalized = value?.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      tokens.push(normalized);
    }
    return { id: p.id, tokens };
  });
}

function findMentionedParticipantIds(
  content: string,
  matchers: readonly MentionMatcherEntry[],
): string[] {
  if (!content || !content.includes('@')) return [];
  const lower = content.toLowerCase();
  const atPositions: number[] = [];
  let idx = lower.indexOf('@');
  while (idx !== -1) {
    if (idx === 0 || !EMAIL_LOCAL_CHAR.test(lower[idx - 1])) {
      atPositions.push(idx);
    }
    idx = lower.indexOf('@', idx + 1);
  }
  if (atPositions.length === 0) return [];

  const matched: string[] = [];
  for (const entry of matchers) {
    let hit = false;
    for (const atPos of atPositions) {
      const start = atPos + 1;
      for (const token of entry.tokens) {
        if (!lower.startsWith(token, start)) continue;
        const end = start + token.length;
        const lastChar = token[token.length - 1];
        if (
          end === lower.length ||
          !ASCII_WORD_CHAR.test(lastChar) ||
          !ASCII_WORD_CHAR.test(lower[end])
        ) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) matched.push(entry.id);
  }
  return matched;
}

function recordActivity(map: Map<string, number>, participantId: string, createdAt: number) {
  if (!participantId) return;
  const prev = map.get(participantId);
  if (prev === undefined || createdAt > prev) {
    map.set(participantId, createdAt);
  }
}

function buildLatestActivityMap(
  messages: readonly MentionActivityMessage[] | undefined,
  matchers: readonly MentionMatcherEntry[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (!messages) return map;
  for (const msg of messages) {
    recordActivity(map, msg.senderId, msg.createdAt);
    if (msg.mentionedIds) {
      for (const id of msg.mentionedIds) {
        recordActivity(map, id, msg.createdAt);
      }
    }
    if (msg.content && msg.content.includes('@')) {
      for (const id of findMentionedParticipantIds(msg.content, matchers)) {
        recordActivity(map, id, msg.createdAt);
      }
    }
  }
  return map;
}

/**
 * Build channel/thread-aware @ mention candidates:
 * - Excludes currentUserId and archived agents.
 * - For DMs, restricts strictly to DM peer(s) with no outside-channel section.
 * - For channels, withholds candidates while roster is loading, never misclassifies
 *   workspace members as in-channel when roster loading fails or is empty, and marks
 *   explicit channel members as `inChannel: true` and others as `inChannel: false`.
 * - Attaches latest thread and channel activity timestamps (both speaking and being @-mentioned)
 *   for recency sorting.
 */
export function buildMentionCandidates({
  participants,
  currentUserId,
  channelKind = 'channel',
  dmKey,
  channelMemberIds,
  channelMembersState,
  channelMessages,
  threadMessages,
}: BuildMentionCandidatesInput): MentionCandidate[] {
  const eligible = participants.filter(
    (p) => p.id !== currentUserId && !(p.role === 'agent' && p.archived === true),
  );

  const matchers = buildMentionMatchers(eligible);
  const channelActivity = buildLatestActivityMap(channelMessages, matchers);
  const threadActivity = buildLatestActivityMap(threadMessages, matchers);

  if (channelKind === 'dm') {
    const peerIds = parseDmPeerIds(dmKey, currentUserId);
    if (channelMemberIds) {
      for (const id of channelMemberIds) {
        if (id && id !== currentUserId) peerIds.add(id);
      }
    }
    const scoped =
      peerIds.size > 0 ? eligible.filter((p) => peerIds.has(p.id)) : eligible;

    return scoped.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      avatarUrl: p.avatarUrl,
      cliId: p.cliId,
      status: p.status,
      archived: p.archived,
      inChannel: true,
      threadActiveAt: threadActivity.get(p.id),
      lastActiveAt: channelActivity.get(p.id),
    }));
  }

  const effectiveState: ChannelMembersState =
    channelMembersState ?? (channelMemberIds ? 'ready' : 'error');

  if (effectiveState === 'loading') {
    return [];
  }

  return eligible.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    avatarUrl: p.avatarUrl,
    cliId: p.cliId,
    status: p.status,
    archived: p.archived,
    inChannel:
      effectiveState === 'ready' && channelMemberIds ? channelMemberIds.has(p.id) : false,
    threadActiveAt: threadActivity.get(p.id),
    lastActiveAt: channelActivity.get(p.id),
  }));
}

function fieldMatchRank(value: string | undefined, query: string): number | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith(query)) return 0;
  const tokens = lower.split(/[\s\-_./]+/);
  if (tokens.some((token) => token.length > 0 && token.startsWith(query))) return 1;
  if (lower.includes(query)) return 2;
  return null;
}

function candidateMatchRank(candidate: MentionCandidate, query: string): number | null {
  const nameRank = fieldMatchRank(candidate.name, query);
  const cliRank = fieldMatchRank(candidate.cliId, query);
  if (nameRank === null) return cliRank;
  if (cliRank === null) return nameRank;
  return Math.min(nameRank, cliRank);
}

/**
 * Filter and deterministically sort @ mention candidates:
 * - Always keeps `inChannel` candidates ahead of outside-channel candidates.
 * - When `query` is non-empty, ranks prefix > word-start > substring matches.
 * - Then orders by: thread recency -> channel recency -> online > offline -> agent > human -> name.
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();

  const entries: Array<{ candidate: MentionCandidate; matchRank: number }> = [];
  for (const c of candidates) {
    if (c.role === 'agent' && c.archived === true) continue;
    if (!q) {
      entries.push({ candidate: c, matchRank: 0 });
      continue;
    }
    const rank = candidateMatchRank(c, q);
    if (rank !== null) {
      entries.push({ candidate: c, matchRank: rank });
    }
  }

  entries.sort((a, b) => {
    const ca = a.candidate;
    const cb = b.candidate;

    // 1. In-channel before outside-channel
    const aIn = ca.inChannel !== false ? 0 : 1;
    const bIn = cb.inChannel !== false ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;

    // 2. Search match quality (prefix > word-start > substring)
    if (q && a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;

    // 3. Thread recency (descending)
    const aThread = ca.threadActiveAt ?? -1;
    const bThread = cb.threadActiveAt ?? -1;
    if (aThread !== bThread) return bThread - aThread;

    // 4. Channel recency (descending)
    const aActive = ca.lastActiveAt ?? -1;
    const bActive = cb.lastActiveAt ?? -1;
    if (aActive !== bActive) return bActive - aActive;

    // 5. Online before offline
    const aOnline = ca.status === 'online' ? 0 : 1;
    const bOnline = cb.status === 'online' ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;

    // 6. Agent before human
    const aRole = ca.role === 'agent' ? 0 : 1;
    const bRole = cb.role === 'agent' ? 0 : 1;
    if (aRole !== bRole) return aRole - bRole;

    // 7. Stable alphabetical tie-breaker
    return ca.name.localeCompare(cb.name, 'zh-Hans-CN', { sensitivity: 'base' });
  });

  return entries.map((entry) => entry.candidate);
}

/**
 * Find non-archived agents explicitly @-mentioned in `content` that are not yet
 * members of the active channel. Used before send to offer an explicit
 * "Invite & Send" vs "Send without inviting" confirmation (matching Buzz UX).
 */
export function findMentionedNonMemberAgents<T extends MentionSourceParticipant>(
  content: string,
  participants: readonly T[],
  channelMemberIds: ReadonlySet<string>,
): T[] {
  if (!content || !content.includes('@')) return [];
  const candidateAgents = participants.filter(
    (p) => p.role === 'agent' && p.archived !== true && !channelMemberIds.has(p.id),
  );
  if (candidateAgents.length === 0) return [];
  const matchers = buildMentionMatchers(candidateAgents);
  const mentionedIds = new Set(findMentionedParticipantIds(content, matchers));
  if (mentionedIds.size === 0) return [];
  return candidateAgents.filter((a) => mentionedIds.has(a.id));
}
