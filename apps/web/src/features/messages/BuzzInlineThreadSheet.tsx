/**
 * Inline in-conversation thread sheet ported from Buzz's ComposerSheet + ThreadPanel
 * (references/buzz-app/src/features/messages/ComposerSheet.tsx, ThreadPanel.tsx,
 *  ReplyBranch.tsx, reply-tree.ts).
 *
 * Opens docked inside the conversation's .composerDock (replacing the old fixed
 * right-hand Thread drawer), renders nested reply branches via replyTree + ReplyBranch,
 * keeps historical threadId-only replies under root, and supports replying to a
 * specific reply with Buzz's .composerReplySlot / .replyContext banner.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AvatarStack } from '../../design-system/ui/AvatarStack';
import { DialogBarMaterial } from '../../design-system/ui/DialogBarMaterial';
import { calendarDay, toUnixSeconds } from '../../shared/datetime';
import { BuzzMessageRow } from './BuzzMessageRow';
import { ComposerSheet } from './ComposerSheet';
import {
  composerHost,
  useComposerDock,
  useComposerScope,
} from './composer-overlay';
import { continuesMessageGroup } from './message-grouping';
import styles from './Messages.module.css';
import {
  ProseMirrorComposer,
  type ProseMirrorComposerHandle,
  type UploadedAttachment,
} from './ProseMirrorComposer';
import { replyTree } from './reply-tree';
import { ReplyBranch } from './ReplyBranch';
import type { ChatMessage, MessageFocus, Participant } from './types';

export interface BuzzInlineThreadSheetProps {
  open: boolean;
  root: ChatMessage | null;
  replies: readonly ChatMessage[];
  messageFocus?: MessageFocus;
  participants: readonly Participant[];
  currentUserId: string;
  serverHttp: string;
  editingMessageId: string | null;
  editingDraft: string;
  onEditingDraftChange: (value: string) => void;
  onStartEdit: (msg: ChatMessage) => void;
  onSaveEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onDelete: (messageId: string) => void;
  onTogglePin: (msg: ChatMessage) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenTerminal: (sessionId: string) => void;
  onOpenMedia: (attachments: readonly UploadedAttachment[], selectedId: string) => void;
  onOpenAgentProfile?: (agentId: string) => void;
  onUploadFile: (file: File) => Promise<UploadedAttachment | null>;
  onSendReply: (
    text: string,
    attachments: UploadedAttachment[],
    messageId: string,
    replyToId?: string,
  ) => Promise<void>;
  onClose: () => void;
}

export function BuzzInlineThreadSheet({
  open,
  root,
  replies,
  messageFocus,
  participants,
  currentUserId,
  serverHttp,
  editingMessageId,
  editingDraft,
  onEditingDraftChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  onToggleReaction,
  onOpenTerminal,
  onOpenMedia,
  onOpenAgentProfile,
  onUploadFile,
  onSendReply,
  onClose,
}: BuzzInlineThreadSheetProps) {
  const scope = useComposerScope();
  // Subscribe to dock mount/unmount so composerHost resolves reactively
  useComposerDock(scope?.handle);
  const host = composerHost(scope?.handle);
  const dock = host?.dock;

  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(() => new Set());
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const placedFocus = useRef<number | undefined>(undefined);

  const participantMap = useMemo(
    () => new Map(participants.map((p) => [p.id, p])),
    [participants],
  );

  const tree = useMemo(
    () => replyTree(replies, root?.id),
    [replies, root?.id],
  );

  // Reset branch state & reply target when switching threads
  useEffect(() => {
    setExpandedBranches(new Set());
    setReplyTarget(null);
    prevReplyCount.current = 0;
  }, [root?.id]);

  useEffect(() => {
    if (!open || !dock || !messageFocus || messageFocus.sequence === placedFocus.current ||
        !replies.some((reply) => reply.id === messageFocus.id)) return;

    const ancestors = tree.ancestors(messageFocus.id);
    if (ancestors.length) {
      setExpandedBranches((previous) => ancestors.every((id) => previous.has(id))
        ? previous
        : new Set([...previous, ...ancestors]));
    }
    let frame = 0;
    let attempts = 0;
    const reveal = () => {
      const row = scrollerRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageFocus.id)}"]`,
      );
      if ((!row || row.getBoundingClientRect().height === 0) && attempts++ < 30) {
        frame = requestAnimationFrame(reveal);
        return;
      }
      placedFocus.current = messageFocus.sequence;
      row?.scrollIntoView({ block: 'center' });
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [dock, messageFocus, open, replies, tree]);

  // Auto-expand branch only when a live nested reply arrives after initial thread load
  const prevReplyCount = useRef(0);
  useEffect(() => {
    if (prevReplyCount.current > 0 && replies.length > prevReplyCount.current) {
      const newest = replies[replies.length - 1];
      if (newest) {
        const ancestors = tree.ancestors(newest.id);
        if (ancestors.length > 0) {
          setExpandedBranches((prev) => {
            const next = new Set(prev);
            for (const id of ancestors) next.add(id);
            return next;
          });
        }
        const el = scrollerRef.current;
        if (el) {
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
          });
        }
      }
    }
    prevReplyCount.current = replies.length;
  }, [replies, tree]);

  if (!open || !host) return null;

  const replyCount = replies.length;
  const description =
    replyCount > 0
      ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
      : undefined;

  const expandBranch = (id: string) => {
    setExpandedBranches((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const collapseBranch = (id: string) => {
    setExpandedBranches((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const renderReplies = (parent: string | undefined, depth = 0): ReactNode => {
    const siblings = tree.children.get(parent) ?? [];
    return siblings.map((row, index) => {
      const prev = siblings[index - 1];
      const next = siblings[index + 1];
      const nested = tree.children.get(row.id) ?? [];
      const hasNested = nested.length > 0;
      const isExpanded = expandedBranches.has(row.id);

      const stackPrevious = continuesMessageGroup(prev, row);
      const stackNext =
        !hasNested && next ? continuesMessageGroup(row, next) : false;
      const day =
        depth === 0 &&
        index > 0 &&
        calendarDay(toUnixSeconds(prev!.createdAt)) !==
          calendarDay(toUnixSeconds(row.createdAt));

      const sender = participantMap.get(row.senderId);
      const branchAvatars = Array.from(
        new Map(
          nested.map((child) => {
            const p = participantMap.get(child.senderId);
            return [
              child.senderId,
              {
                id: child.senderId,
                name: p?.name || child.senderId,
                src: p?.avatarUrl,
                shape: (child.senderRole === 'agent' ? 'squircle' : 'circle') as
                  | 'squircle'
                  | 'circle',
              },
            ];
          }),
        ).values(),
      );

      const layout = stackPrevious ? 'continuation' : 'thread';
      const replyLabel = `${nested.length} ${nested.length === 1 ? 'reply' : 'replies'}`;

      return (
        <li key={row.id} className={styles.replyItem}>
          <ReplyBranch
            layout={layout}
            depth={depth}
            hasReplies={hasNested}
            open={isExpanded}
            label={`Expand ${replyLabel} to ${sender?.name || row.senderId}`}
            collapseLabel={`Collapse ${replyLabel} to ${sender?.name || row.senderId}`}
            onExpand={() => expandBranch(row.id)}
            onCollapse={() => collapseBranch(row.id)}
            summary={
              <>
                <AvatarStack items={branchAvatars} size="mini" max={3} />
                <span>{replyLabel}</span>
              </>
            }
            message={
              <BuzzMessageRow
                msg={row}
                sender={sender}
                currentUserId={currentUserId}
                serverHttp={serverHttp}
                layout={layout}
                stackPrevious={stackPrevious}
                stackNext={stackNext}
                day={day}
                inThread
                highlighted={row.id === messageFocus?.id}
                isEditing={editingMessageId === row.id}
                editingDraft={editingDraft}
                onEditingDraftChange={onEditingDraftChange}
                onStartEdit={onStartEdit}
                onSaveEdit={onSaveEdit}
                onCancelEdit={onCancelEdit}
                onDelete={onDelete}
                onTogglePin={onTogglePin}
                onToggleReaction={onToggleReaction}
                onReply={() => {
                  setReplyTarget(row);
                  if (hasNested) expandBranch(row.id);
                }}
                onOpenTerminal={onOpenTerminal}
                onOpenMedia={onOpenMedia}
                onOpenAgentProfile={onOpenAgentProfile}
                onMentionParticipant={(p) => threadComposerRef.current?.insertMention(p)}
              />
            }
          >
            {hasNested && (
              <ol className={styles.threadList}>
                {renderReplies(row.id, depth + 1)}
              </ol>
            )}
          </ReplyBranch>
        </li>
      );
    });
  };

  const threadComposerRef = useRef<ProseMirrorComposerHandle | null>(null);
  const targetAuthor = replyTarget
    ? participantMap.get(replyTarget.senderId)?.name || replyTarget.senderId
    : '';

  return (
    <ComposerSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      host={host}
      title="Thread"
      description={description}
      closeLabel="Close thread"
      containsComposer
    >
      <aside
        className={`${styles.thread} ${styles.embeddedThread}`}
        data-reading-surface=""
        aria-label="Thread"
      >
        <div className={styles.threadHistoryFrame} data-thread-history-frame="">
          <section
            ref={scrollerRef}
            data-message-scroller=""
            className={styles.threadHistory}
            aria-label="Thread messages"
            tabIndex={0}
          >
            <div data-thread-rows="">
              {root && (
                <BuzzMessageRow
                  msg={root}
                  sender={participantMap.get(root.senderId)}
                  currentUserId={currentUserId}
                  serverHttp={serverHttp}
                  layout="thread"
                  inThread
                  isEditing={editingMessageId === root.id}
                  editingDraft={editingDraft}
                  onEditingDraftChange={onEditingDraftChange}
                  onStartEdit={onStartEdit}
                  onSaveEdit={onSaveEdit}
                  onCancelEdit={onCancelEdit}
                  onDelete={onDelete}
                  onTogglePin={onTogglePin}
                  onToggleReaction={onToggleReaction}
                  onReply={() => setReplyTarget(null)}
                  onOpenTerminal={onOpenTerminal}
                  onOpenMedia={onOpenMedia}
                  onOpenAgentProfile={onOpenAgentProfile}
                  onMentionParticipant={(p) => threadComposerRef.current?.insertMention(p)}
                />
              )}

              <ol className={styles.threadList}>{renderReplies(undefined, 0)}</ol>

              <div className={styles.timelineEnd} data-thread-end="" aria-hidden="true" />
            </div>
          </section>
          <DialogBarMaterial />
        </div>

        <ProseMirrorComposer
          composerRef={threadComposerRef}
          candidates={participants}
          draftScope={JSON.stringify([currentUserId, root?.id, replyTarget?.id])}
          serverHttp={serverHttp}
          onUploadFile={onUploadFile}
          autoFocus
          replyContext={
            replyTarget
              ? {
                  author: targetAuthor,
                  excerpt: replyTarget.content || '[attachment]',
                  onCancel: () => setReplyTarget(null),
                }
              : null
          }
          onSend={async (text, attachments, messageId) => {
            const targetId = replyTarget?.id;
            await onSendReply(text, attachments, messageId, targetId);
            if (targetId) {
              const liftedParent = tree.parents.get(targetId) ?? targetId;
              expandBranch(liftedParent);
            }
            setReplyTarget((current) => current?.id === targetId ? null : current);
          }}
          placeholder={
            replyTarget ? `Reply to ${targetAuthor}...` : 'Reply in thread...'
          }
        />
      </aside>
    </ComposerSheet>
  );
}
