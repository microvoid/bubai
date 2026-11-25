/**
 * @ mention completion popover aligned with references/buzz-app/src/features/conversation/ComposerCompletions.tsx
 * and Completions.module.css (.popup, .list, .option, .preview, .label, .nameRow, .name, .agentMark).
 */
import { useEffect, useId, useRef } from 'react';
import { Avatar } from '../../design-system/ui/Avatar';
import { RobotIcon } from '../../design-system/icons/index';
import styles from './Completions.module.css';

export interface MentionCandidate {
  id: string;
  name: string;
  role: 'human' | 'agent';
  avatarUrl?: string;
  cliId?: string;
  status: 'online' | 'offline';
}

export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...candidates];
  return candidates.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.cliId && c.cliId.toLowerCase().includes(q)),
  );
}

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
          return (
            <div
              key={item.id}
              id={`${listId}-${idx}`}
              role="option"
              tabIndex={-1}
              aria-selected={selected}
              data-completion-id={item.id}
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
          );
        })}
      </div>
    </section>
  );
}
