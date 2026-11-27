/**
 * Inline in-conversation thread sheet ported from Buzz's ComposerSheet + ThreadPanel.
 *
 * Opens docked inside the conversation's .composerDock, renders all thread replies
 * in flat chronological order so new messages always append at the bottom, and
 * displays a clickable inline quote bar whenever a reply references a specific
 * earlier message (replyToId) to jump and highlight that message.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import type { MentionCandidate } from '../conversation/MentionCompletions';
import type { ChatMessage, MessageFocus, Participant } from './types';

export interface BuzzInlineThreadSheetProps {
  open: boolean;
  root: ChatMessage | null;
  replies: readonly ChatMessage[];
  messageFocus?: MessageFocus;
  participants: readonly Participant[];
  mentionCandidates?: readonly MentionCandidate[];
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
  mentionCandidates,
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

  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const placedFocus = useRef<number | undefined>(undefined);
  const initialScrolledRootRef = useRef<string | null>(null);
  const followBottomRef = useRef(true);
  const userScrolledRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const threadComposerRef = useRef<ProseMirrorComposerHandle | null>(null);

  const participantMap = useMemo(
    () => new Map(participants.map((p) => [p.id, p])),
    [participants],
  );

  const replyLookup = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    if (root) map.set(root.id, root);
    for (const reply of replies) map.set(reply.id, reply);
    return map;
  }, [replies, root]);

  const clearJumpHighlight = () => {
    if (jumpHighlightTimerRef.current !== null) {
      window.clearTimeout(jumpHighlightTimerRef.current);
      jumpHighlightTimerRef.current = null;
    }
    setJumpHighlightId(null);
  };

  useEffect(() => () => {
    if (jumpHighlightTimerRef.current !== null) {
      window.clearTimeout(jumpHighlightTimerRef.current);
      jumpHighlightTimerRef.current = null;
    }
  }, []);

  // Reset reply target & highlight state when switching threads
  useEffect(() => {
    setReplyTarget(null);
    clearJumpHighlight();
    prevReplyCount.current = 0;
    initialScrolledRootRef.current = null;
    followBottomRef.current = !messageFocus;
    userScrolledRef.current = Boolean(messageFocus);
    lastScrollTopRef.current = 0;
  }, [root?.id, open]);

  // Default scroll to latest reply when opening a thread without an explicit messageFocus
  useEffect(() => {
    if (!open || !dock || !root?.id || messageFocus || replies.length === 0) return;
    if (initialScrolledRootRef.current === root.id) return;

    let frame = 0;
    let attempts = 0;
    const settleToBottom = () => {
      const el = scrollerRef.current;
      const rows = el?.querySelector<HTMLElement>('[data-thread-rows]');
      if ((!el || !rows || rows.getBoundingClientRect().height === 0) && attempts++ < 30) {
        frame = requestAnimationFrame(settleToBottom);
        return;
      }
      if (!el) return;
      followBottomRef.current = true;
      userScrolledRef.current = false;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      initialScrolledRootRef.current = root.id;
      frame = requestAnimationFrame(() => {
        if (scrollerRef.current && followBottomRef.current && !userScrolledRef.current) {
          scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
          lastScrollTopRef.current = scrollerRef.current.scrollTop;
        }
      });
    };
    frame = requestAnimationFrame(settleToBottom);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [dock, messageFocus, open, replies.length, root?.id]);

  // Stick-to-bottom observer for in-place reply expansion (e.g. Agent card -> full reply)
  useEffect(() => {
    if (!open || !dock) return;
    if (typeof ResizeObserver === 'undefined') return;
    const el = scrollerRef.current;
    const rows = el?.querySelector<HTMLElement>('[data-thread-rows]');
    if (!el || !rows) return;

    const observer = new ResizeObserver(() => {
      const current = scrollerRef.current;
      if (!current) return;
      if (followBottomRef.current && !userScrolledRef.current && !messageFocus) {
        const dist = current.scrollHeight - current.clientHeight - current.scrollTop;
        if (dist > 1) {
          current.scrollTop = current.scrollHeight;
          lastScrollTopRef.current = current.scrollTop;
        }
      }
    });
    observer.observe(rows);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dock, messageFocus, open, root?.id, replies.length]);

  useEffect(() => {
    if (!open || !dock || !messageFocus || messageFocus.sequence === placedFocus.current ||
        !replies.some((reply) => reply.id === messageFocus.id)) return;

    followBottomRef.current = false;
    userScrolledRef.current = true;
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
      if (scrollerRef.current) {
        lastScrollTopRef.current = scrollerRef.current.scrollTop;
      }
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [dock, messageFocus, open, replies]);

  // Keep viewport at the bottom when new replies arrive (including own replies)
  const prevReplyCount = useRef(0);
  useEffect(() => {
    if (prevReplyCount.current > 0 && replies.length > prevReplyCount.current) {
      const newest = replies[replies.length - 1];
      if (newest) {
        const isOwnReply = newest.senderRole === 'human' && newest.senderId === currentUserId;
        const el = scrollerRef.current;
        if (el && (followBottomRef.current || isOwnReply)) {
          followBottomRef.current = true;
          userScrolledRef.current = false;
          requestAnimationFrame(() => {
            if (scrollerRef.current && followBottomRef.current && !userScrolledRef.current) {
              scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
              lastScrollTopRef.current = scrollerRef.current.scrollTop;
            }
          });
        }
      }
    }
    prevReplyCount.current = replies.length;
  }, [currentUserId, replies]);

  if ((!open && !mounted) || !host) return null;

  const replyCount = replies.length;
  const description =
    replyCount > 0
      ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
      : undefined;

  const jumpToMessage = (targetId: string) => {
    const el = scrollerRef.current;
    const row = el?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(targetId)}"]`,
    );
    if (!row) return;
    followBottomRef.current = false;
    userScrolledRef.current = true;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearJumpHighlight();
    requestAnimationFrame(() => {
      setJumpHighlightId(targetId);
      jumpHighlightTimerRef.current = window.setTimeout(() => {
        setJumpHighlightId(null);
        jumpHighlightTimerRef.current = null;
      }, 2200);
    });
  };

  const hasQuoteFor = (msg: ChatMessage | undefined) =>
    Boolean(msg?.replyToId && msg.replyToId !== root?.id);

  const renderReplies = (): ReactNode =>
    replies.map((row, index) => {
      const prev = replies[index - 1];
      const next = replies[index + 1];
      const hasQuote = hasQuoteFor(row);
      const nextHasQuote = hasQuoteFor(next);

      const stackPrevious = !hasQuote && continuesMessageGroup(prev, row);
      const stackNext = next
        ? !nextHasQuote && continuesMessageGroup(row, next)
        : false;
      const day =
        index > 0 &&
        calendarDay(toUnixSeconds(prev!.createdAt)) !==
          calendarDay(toUnixSeconds(row.createdAt));

      const sender = participantMap.get(row.senderId);
      const layout = stackPrevious ? 'continuation' : 'thread';

      let replyQuote: ReactNode = null;
      if (hasQuote && row.replyToId) {
        const quoted = replyLookup.get(row.replyToId);
        if (quoted) {
          const quotedAuthor =
            participantMap.get(quoted.senderId)?.name || quoted.senderId;
          const quotedExcerpt = replyTargetExcerpt(quoted);
          replyQuote = (
            <button
              type="button"
              className={styles.replyQuote}
              data-reply-quote=""
              data-reply-target-id={quoted.id}
              onClick={() => jumpToMessage(quoted.id)}
              title={quotedExcerpt ? `${quotedAuthor}: ${quotedExcerpt}` : quotedAuthor}
            >
              <span className={styles.replyQuoteAuthor}>{quotedAuthor}</span>
              {quotedExcerpt && (
                <span className={styles.replyQuoteText}>{quotedExcerpt}</span>
              )}
            </button>
          );
        } else {
          replyQuote = (
            <div
              className={styles.replyQuote}
              data-reply-quote=""
              data-reply-quote-missing=""
            >
              <span className={styles.replyQuoteText}>Original message unavailable</span>
            </div>
          );
        }
      }

      return (
        <li key={row.id} className={styles.replyItem}>
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
            highlighted={row.id === messageFocus?.id || row.id === jumpHighlightId}
            replyQuote={replyQuote}
            isEditing={editingMessageId === row.id}
            editingDraft={editingDraft}
            onEditingDraftChange={onEditingDraftChange}
            onStartEdit={onStartEdit}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
            onDelete={onDelete}
            onTogglePin={onTogglePin}
            onToggleReaction={onToggleReaction}
            onReply={() => setReplyTarget(row)}
            onOpenTerminal={onOpenTerminal}
            onOpenMedia={onOpenMedia}
            onOpenAgentProfile={onOpenAgentProfile}
            onMentionParticipant={(p) => threadComposerRef.current?.insertMention(p)}
          />
        </li>
      );
    });

  const targetAuthor = replyTarget
    ? participantMap.get(replyTarget.senderId)?.name || replyTarget.senderId
    : '';

  return (
    <ComposerSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onClosed={() => setMounted(false)}
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
            onWheel={(event) => {
              if (event.deltaY < 0) userScrolledRef.current = true;
            }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                const rect = event.currentTarget.getBoundingClientRect();
                if (event.clientX >= rect.left + event.currentTarget.clientWidth) {
                  userScrolledRef.current = true;
                }
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
                userScrolledRef.current = true;
              }
            }}
            onScroll={(event) => {
              const el = event.currentTarget;
              if (el.scrollTop < lastScrollTopRef.current - 2) {
                userScrolledRef.current = true;
              }
              const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
              if (atBottom) {
                followBottomRef.current = true;
                userScrolledRef.current = false;
              } else if (followBottomRef.current && !userScrolledRef.current && !messageFocus) {
                el.scrollTop = el.scrollHeight;
              } else {
                followBottomRef.current = false;
              }
              lastScrollTopRef.current = el.scrollTop;
            }}
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
                  highlighted={root.id === jumpHighlightId}
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

              <ol className={styles.threadList}>{renderReplies()}</ol>

              <div className={styles.timelineEnd} data-thread-end="" aria-hidden="true" />
            </div>
          </section>
          <DialogBarMaterial />
        </div>

        <ProseMirrorComposer
          composerRef={threadComposerRef}
          candidates={mentionCandidates ?? participants}
          draftScope={JSON.stringify([currentUserId, root?.id, replyTarget?.id])}
          serverHttp={serverHttp}
          onUploadFile={onUploadFile}
          autoFocus
          replyContext={
            replyTarget
              ? {
                  author: targetAuthor,
                  excerpt: replyTargetExcerpt(replyTarget),
                  onCancel: () => setReplyTarget(null),
                }
              : null
          }
          onSend={async (text, attachments, messageId) => {
            const targetId = replyTarget?.id;
            followBottomRef.current = true;
            userScrolledRef.current = false;
            await onSendReply(text, attachments, messageId, targetId);
            setReplyTarget((current) => (current?.id === targetId ? null : current));
          }}
          placeholder={
            replyTarget ? `Reply to ${targetAuthor}...` : 'Reply in thread...'
          }
        />
      </aside>
    </ComposerSheet>
  );
}

export function replyTargetExcerpt(target: Pick<ChatMessage, 'content' | 'card' | 'attachments'>): string {
  const text = target.content.trim();
  if (text) return text;
  const cardText = target.card?.title?.trim() || target.card?.summary?.trim();
  if (cardText) return cardText;
  if (target.attachments && target.attachments.length > 0) return '[attachment]';
  return '';
}
