/**
 * @ mention completion popover aligned with references/buzz-app/src/features/conversation/ComposerCompletions.tsx
 * and Completions.module.css (.popup, .list, .option, .preview, .label, .nameRow, .name, .agentMark).
 */
import { Fragment, useEffect, useId, useRef } from 'react';
import { Avatar } from '../../design-system/ui/Avatar';
import { RobotIcon } from '../../design-system/icons/index';
import styles from './Completions.module.css';
import {
  filterMentionCandidates,
  type MentionCandidate,
} from './mention-candidates';

export {
  buildMentionCandidates,
  findMentionedNonMemberAgents,
  filterMentionCandidates,
  type BuildMentionCandidatesInput,
  type ChannelMembersState,
  type MentionActivityMessage,
  type MentionCandidate,
  type MentionSourceParticipant,
} from './mention-candidates';

export function extractMentionQuery(draft: string): { query: string; startIndex: number } | null {
  const match = draft.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const query = match[1] ?? '';
  const startIndex = draft.length - query.length - 1;
  return { query, startIndex };
}

export function MentionCompletions({
  candidates,
  query,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  candidates: readonly MentionCandidate[];
  query: string;
  activeIndex: number;
  onActiveIndexChange?: (index: number) => void;
  onSelect: (candidate: MentionCandidate) => void;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const filtered = filterMentionCandidates(candidates, query);
  const clampedIndex = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex, filtered.length]);

  if (filtered.length === 0) return null;

  const showGroups = filtered.some((item) => item.inChannel === false);

  return (
    <section
      className={styles.popup}
      data-mention=""
      aria-label="Mention suggestions"
      style={{
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + var(--space-2))',
        width: 'min(20rem, 100%)',
        zIndex: 40,
      }}
    >
      <div
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label="Mention suggestions"
        className={styles.list}
      >
        {filtered.map((item, idx) => {
          const selected = idx === clampedIndex;
          const isOutside = item.inChannel === false;
          const prevOutside = idx > 0 ? filtered[idx - 1].inChannel === false : null;
          const showGroupHeader = showGroups && (idx === 0 || isOutside !== prevOutside);
          return (
            <Fragment key={item.id}>
              {showGroupHeader && (
                <div
                  className={styles.group}
                  role="presentation"
                  data-mention-group={isOutside ? 'outside' : 'in-channel'}
                >
                  {isOutside ? '不在本频道' : '本频道'}
                </div>
              )}
              <div
                id={`${listId}-${idx}`}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                data-completion-id={item.id}
                data-outside-channel={isOutside ? '' : undefined}
                className={styles.option}
                onPointerDown={(e) => {
                  if (e.button === 0) e.preventDefault();
                }}
                onPointerMove={() => {
                  if (idx !== clampedIndex) onActiveIndexChange?.(idx);
                }}
                onClick={() => onSelect(item)}
              >
                <span aria-hidden="true" className={styles.preview}>
                  <Avatar
                    src={item.avatarUrl}
                    alt=""
                    fallback={item.name}
                    size="small"
                    shape={item.role === 'agent' ? 'squircle' : 'circle'}
                    statusBadge={item.status === 'online' ? 'online' : 'offline'}
                  />
                </span>
                <span className={styles.label} data-completion-label="">
                  <span className={styles.nameRow}>
                    <span className={styles.name}>{item.name}</span>
                    {item.role === 'agent' && (
                      <>
                        <span aria-hidden="true" className={styles.agentMark}>
                          <RobotIcon />
                        </span>
                        <span className="sr-only"> Agent</span>
                      </>
                    )}
                  </span>
                  {item.cliId && <small>{item.cliId}</small>}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
