/**
 * Message hover action bar aligned with Buzz's Messages.module.css
 * (.messageActionsSlot / .messageActions), design-system IconButton, and
 * BuzzEmojiPicker (reaction mode).
 */
import { useState } from 'react';
import { IconButton } from '../../design-system/ui/IconButton';
import {
  CheckIcon,
  CopyIcon,
  PencilSimpleIcon,
  PinIcon,
  PinOffIcon,
  TerminalWindowIcon,
  ThreadIcon,
  TrashIcon,
} from '../../design-system/icons/index';
import { writeClipboardText } from '../../shared/clipboard';
import { BuzzEmojiPicker } from './BuzzEmojiPicker';
import styles from './Messages.module.css';

export function MessageActionBar({
  content,
  canEdit,
  pinned = false,
  replyLabel = 'Reply in thread',
  onReply,
  onTogglePin,
  onOpenTerminal,
  onReact,
  onEdit,
  onDelete,
}: {
  content: string;
  canEdit: boolean;
  pinned?: boolean;
  replyLabel?: string;
  onReply?: () => void;
  onTogglePin?: () => void;
  onOpenTerminal?: () => void;
  onReact: (emoji: string) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={styles.messageActionsSlot}>
      <div
        className={styles.messageActions}
        data-message-actions=""
        role="group"
        aria-label="Message actions"
      >
        <BuzzEmojiPicker reaction onSelect={onReact} />
        {onReply && (
          <IconButton
            hint="familiar"
            size="sm"
            aria-label={replyLabel}
            title={replyLabel}
            icon={<ThreadIcon size={16} />}
            onClick={onReply}
          />
        )}
        {onTogglePin && (
          <IconButton
            hint="familiar"
            size="sm"
            aria-label={pinned ? 'Unpin message' : 'Pin message'}
            title={pinned ? '取消置顶' : '置顶消息'}
            icon={pinned ? <PinOffIcon size={16} /> : <PinIcon size={16} />}
            onClick={onTogglePin}
          />
        )}
        {onOpenTerminal && (
          <IconButton
            hint="familiar"
            size="sm"
            aria-label="Open terminal"
            title="Open terminal"
            icon={<TerminalWindowIcon size={16} />}
            onClick={onOpenTerminal}
          />
        )}
        <IconButton
          hint="familiar"
          size="sm"
          aria-label="Copy message"
          title={copied ? 'Copied' : 'Copy message'}
          icon={copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          onClick={() => {
            void writeClipboardText(content).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        />
        {canEdit && onEdit && (
          <IconButton
            hint="familiar"
            size="sm"
            aria-label="Edit message"
            title="Edit message"
            icon={<PencilSimpleIcon size={16} />}
            onClick={onEdit}
          />
        )}
        {canEdit && onDelete && (
          <IconButton
            hint="familiar"
            size="sm"
            aria-label="Delete message"
            title="Delete message"
            icon={<TrashIcon size={16} />}
            onClick={onDelete}
          />
        )}
      </div>
    </div>
  );
}
