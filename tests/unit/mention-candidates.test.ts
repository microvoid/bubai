import { describe, expect, it } from 'bun:test';
import {
  buildMentionCandidates,
  filterMentionCandidates,
  findMentionedNonMemberAgents,
  type MentionSourceParticipant,
} from '../../apps/web/src/features/conversation/mention-candidates';

const PARTICIPANTS: MentionSourceParticipant[] = [
  { id: 'u-owner', name: '许星', role: 'human', status: 'online' },
  { id: 'u-lin', name: '林小雨', role: 'human', status: 'online' },
  { id: 'u-chen', name: '陈默', role: 'human', status: 'offline' },
  { id: 'u-out', name: '张明', role: 'human', status: 'online' },
  {
    id: 'agent-gemini',
    name: 'Local Gemini 4 Neon',
    role: 'agent',
    status: 'online',
    cliId: 'antigravity',
    archived: false,
  },
  {
    id: 'agent-codex',
    name: 'Local Codex 6.2 Sol',
    role: 'agent',
    status: 'online',
    cliId: 'codex-app',
    archived: false,
  },
  {
    id: 'agent-out',
    name: 'Local Claude Code',
    role: 'agent',
    status: 'online',
    cliId: 'claude-code',
    archived: false,
  },
  {
    id: 'agent-archived',
    name: 'Old Bot',
    role: 'agent',
    status: 'offline',
    cliId: 'old',
    archived: true,
  },
];

describe('buildMentionCandidates + filterMentionCandidates', () => {
  it('excludes currentUserId and archived agents, groups in-channel before outside-channel, and puts agents before humans', () => {
    const built = buildMentionCandidates({
      participants: PARTICIPANTS,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMemberIds: new Set(['u-owner', 'u-lin', 'u-chen', 'agent-gemini', 'agent-codex']),
    });

    const sorted = filterMentionCandidates(built, '');
    expect(sorted.map((c) => c.id)).toEqual([
      'agent-codex',
      'agent-gemini',
      'u-lin',
      'u-chen',
      'agent-out',
      'u-out',
    ]);
    expect(sorted.slice(0, 4).every((c) => c.inChannel === true)).toBe(true);
    expect(sorted.slice(4).every((c) => c.inChannel === false)).toBe(true);
  });

  it('boosts recently active channel and thread participants ahead of static order within the same group', () => {
    const built = buildMentionCandidates({
      participants: PARTICIPANTS,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMemberIds: new Set(['u-owner', 'u-lin', 'agent-gemini', 'agent-codex']),
      channelMessages: [
        { senderId: 'agent-gemini', createdAt: 1000 },
        { senderId: 'u-lin', createdAt: 2000 },
      ],
      threadMessages: [{ senderId: 'agent-codex', createdAt: 1500 }],
    });

    const sorted = filterMentionCandidates(built, '');
    expect(sorted.slice(0, 3).map((c) => c.id)).toEqual([
      'agent-codex',
      'u-lin',
      'agent-gemini',
    ]);
  });

  it('ranks search matches by prefix > word-start > substring while keeping in-channel before outside-channel', () => {
    const extra: MentionSourceParticipant[] = [
      ...PARTICIPANTS,
      {
        id: 'agent-gem-out',
        name: 'Gemini Reviewer',
        role: 'agent',
        status: 'online',
        cliId: 'antigravity',
      },
      {
        id: 'agent-sub-in',
        name: 'MyBigGemBot',
        role: 'agent',
        status: 'online',
        cliId: 'custom',
      },
    ];

    const built = buildMentionCandidates({
      participants: extra,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMemberIds: new Set(['u-owner', 'agent-gemini', 'agent-sub-in']),
    });

    const sorted = filterMentionCandidates(built, 'gem');
    expect(sorted.map((c) => c.id)).toEqual([
      'agent-gemini',
      'agent-sub-in',
      'agent-gem-out',
    ]);
  });

  it('restricts DM candidates strictly to DM peer with no outside-channel entries', () => {
    const built = buildMentionCandidates({
      participants: PARTICIPANTS,
      currentUserId: 'u-owner',
      channelKind: 'dm',
      dmKey: 'u:u-owner|a:agent-codex',
    });

    const sorted = filterMentionCandidates(built, '');
    expect(sorted.map((c) => c.id)).toEqual(['agent-codex']);
    expect(sorted[0]?.inChannel).toBe(true);
  });

  it('withholds candidates while channel members are loading and never misclassifies on error or empty roster', () => {
    const loading = buildMentionCandidates({
      participants: PARTICIPANTS,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMembersState: 'loading',
    });
    expect(loading).toEqual([]);

    const errored = buildMentionCandidates({
      participants: PARTICIPANTS,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMembersState: 'error',
    });
    expect(errored.length).toBeGreaterThan(0);
    expect(errored.every((c) => c.inChannel === false)).toBe(true);
    expect(errored.some((c) => c.id === 'u-owner')).toBe(false);
    expect(errored.some((c) => c.id === 'agent-archived')).toBe(false);

    const emptyLoaded = buildMentionCandidates({
      participants: PARTICIPANTS,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMemberIds: new Set(),
      channelMembersState: 'ready',
    });
    expect(emptyLoaded.every((c) => c.inChannel === false)).toBe(true);
  });

  it('counts recently @-mentioned participants toward channel and thread recency with boundary safety', () => {
    const extra: MentionSourceParticipant[] = [
      { id: 'u-owner', name: '许星', role: 'human', status: 'online' },
      { id: 'u-online', name: 'Zzz Online Human', role: 'human', status: 'online' },
      { id: 'u-offline', name: 'Bbb Outside Human', role: 'human', status: 'offline' },
      { id: 'u-al', name: 'Al', role: 'human', status: 'offline' },
      { id: 'u-alice', name: 'Alice', role: 'human', status: 'offline' },
    ];

    const built = buildMentionCandidates({
      participants: extra,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMemberIds: new Set(['u-owner', 'u-online', 'u-offline', 'u-al', 'u-alice']),
      channelMessages: [
        {
          senderId: 'u-owner',
          createdAt: 3000,
          content: 'fixture message mentioning @Bbb Outside Human and email test@al.com and @Alice',
        },
      ],
    });

    const humanMatches = filterMentionCandidates(built, 'human');
    expect(humanMatches.map((c) => c.id)).toEqual(['u-offline', 'u-online']);

    // @Alice should be active, while @Al must NOT falsely match @Alice or test@al.com
    const alEntry = built.find((c) => c.id === 'u-al');
    const aliceEntry = built.find((c) => c.id === 'u-alice');
    expect(alEntry?.lastActiveAt).toBeUndefined();
    expect(aliceEntry?.lastActiveAt).toBe(3000);

    // Thread @mention boosts above channel activity
    const threadBuilt = buildMentionCandidates({
      participants: extra,
      currentUserId: 'u-owner',
      channelKind: 'channel',
      channelMemberIds: new Set(['u-owner', 'u-online', 'u-offline']),
      channelMessages: [
        { senderId: 'u-online', createdAt: 4000, content: 'channel speaker' },
      ],
      threadMessages: [
        { senderId: 'u-owner', createdAt: 3500, content: 'ping @Bbb Outside Human in thread' },
      ],
    });
    const threadMatches = filterMentionCandidates(threadBuilt, 'human');
    expect(threadMatches.map((c) => c.id)).toEqual(['u-offline', 'u-online']);
  });
});

describe('findMentionedNonMemberAgents', () => {
  it('returns only non-archived agents @-mentioned outside channelMemberIds', () => {
    const mentioned = findMentionedNonMemberAgents(
      '@Local Codex 6.2 Sol @Local Gemini 4 Neon @Archived Bot @林小雨 帮忙看看',
      PARTICIPANTS,
      new Set(['u-owner', 'agent-gemini']),
    );
    expect(mentioned.map((a) => a.id)).toEqual(['agent-codex']);
  });

  it('ignores email addresses and already-joined agents', () => {
    const mentioned = findMentionedNonMemberAgents(
      'contact test@agent-codex.com and @Local Gemini 4 Neon',
      PARTICIPANTS,
      new Set(['u-owner', 'agent-gemini']),
    );
    expect(mentioned).toEqual([]);
  });
});
