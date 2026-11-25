/**
 * Message reaction pills aligned with references/buzz-app/src/features/messages/MessageReactions.tsx
 * and Messages.module.css (.reactions, .reactionItem, .reactionGlyph, .reactionNativeEmoji, .reactionCount).
 */
import { Button } from '../../design-system/ui/Button';
import styles from './Messages.module.css';

export interface ReactionGroup {
  emoji: string;
  userIds: string[];
}

export function MessageReactions({
  reactions,
  currentUserId,
  onToggle,
}: {
  reactions?: ReactionGroup[];
  currentUserId: string;
  onToggle: (emoji: string) => void;
}) {
  if (!reactions || reactions.length === 0) return null;

  return (
    <div
      className={styles.reactions}
      data-message-reactions=""
      data-populated=""
      role="group"
      aria-label="Reactions"
    >
      {reactions.map((r) => {
        const mine = r.userIds.includes(currentUserId);
        const grouped = r.userIds.length > 1;
        return (
          <span
            key={r.emoji}
            className={styles.reactionItem}
            data-mine={mine || undefined}
          >
            <Button
              variant="plain"
              size={grouped ? 'caption' : 'sm'}
              shape={grouped ? 'capsule' : 'icon'}
              data-reaction={r.emoji}
              aria-label={`${r.emoji}: ${r.userIds.length}`}
              aria-pressed={mine}
              onClick={() => onToggle(r.emoji)}
            >
              <span
                className={styles.reactionGlyph}
                data-reaction-glyph=""
                data-grouped={grouped || undefined}
              >
                <span
                  className={styles.reactionNativeEmoji}
                  data-reaction-artwork=""
                  aria-hidden="true"
                >
                  {r.emoji}
                </span>
                {grouped && (
                  <span className={styles.reactionCount}>{r.userIds.length}</span>
                )}
              </span>
            </Button>
          </span>
        );
      })}
    </div>
  );
}
