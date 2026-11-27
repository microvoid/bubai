/**
 * Thread reply drawer built with shadcn/ui Base UI Drawer (@base-ui/react/drawer),
 * supporting Non-Modal interaction (modal={false}) and Snap Points (peek / default / expanded)
 * while preserving the current thread sheet width and default height.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { XIcon } from '../../design-system/icons/index';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  shadcnDrawerStyles,
  type DrawerSnapPoint,
} from '../../design-system/ui/ShadcnDrawer';
import { calendarDay, toUnixSeconds } from '../../shared/datetime';
import { BuzzMessageRow } from './BuzzMessageRow';
import { useComposerScope } from './composer-overlay';
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

const THREAD_SNAP_POINTS: DrawerSnapPoint[] = [0.45, 0.8, 1];
const DEFAULT_THREAD_SNAP_POINT: DrawerSnapPoint = 0.8;

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
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [snapPoint, setSnapPoint] = useState<DrawerSnapPoint | null>(DEFAULT_THREAD_SNAP_POINT);
  const [viewportBounds, setViewportBounds] = useState<{ left: number; width: number } | null>(null);
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const composerScope = useComposerScope();
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

  // Align the drawer viewport horizontally with the channel stage so it centers over the
  // timeline & composer without overlapping the sidebar.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const dock = composerScope?.handle.dock();
      const stage = dock?.parentElement;
      if (!stage) {
        setViewportBounds(null);
        return;
      }
      const rect = stage.getBoundingClientRect();
      if (rect.width > 0) {
        setViewportBounds((prev) =>
          prev && Math.abs(prev.left - rect.left) < 1 && Math.abs(prev.width - rect.width) < 1
            ? prev
            : { left: Math.round(rect.left), width: Math.round(rect.width) },
        );
      }
    };
    measure();
    const dock = composerScope?.handle.dock();
    const stage = dock?.parentElement;
    const ro = typeof ResizeObserver !== 'undefined' && stage ? new ResizeObserver(measure) : null;
    if (ro && stage) ro.observe(stage);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [composerScope, open]);

  // Reset reply target & highlight state when switching threads
  useEffect(() => {
    setReplyTarget(null);
    if (open) {
      setSnapPoint(DEFAULT_THREAD_SNAP_POINT);
    }
    clearJumpHighlight();
    prevReplyCount.current = 0;
    initialScrolledRootRef.current = null;
    followBottomRef.current = !messageFocus;
    userScrolledRef.current = Boolean(messageFocus);
    lastScrollTopRef.current = 0;
  }, [root?.id, open]);

  // Default scroll to latest reply when opening a thread without an explicit messageFocus
  useEffect(() => {
    if (!open || !root?.id || messageFocus || replies.length === 0) return;
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
  }, [messageFocus, open, replies.length, root?.id]);

  // Stick-to-bottom observer for in-place reply expansion (e.g. Agent card -> full reply)
  useEffect(() => {
    if (!open) return;
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
  }, [messageFocus, open, root?.id, replies.length]);

  useEffect(() => {
    if (!open || !messageFocus || messageFocus.sequence === placedFocus.current ||
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
  }, [messageFocus, open, replies]);

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

  const viewportStyle: CSSProperties | undefined = viewportBounds
    ? { left: viewportBounds.left, width: viewportBounds.width, right: 'auto' }
    : undefined;

  return (
    <Drawer
      open={open}
      modal={false}
      disablePointerDismissal
      swipeDirection="down"
      snapPoints={THREAD_SNAP_POINTS}
      snapPoint={snapPoint}
      onSnapPointChange={setSnapPoint}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DrawerContent
        className={shadcnDrawerStyles.threadPopup}
        viewportStyle={viewportStyle}
        data-details-sheet-surface=""
        initialFocus={false}
        onHandleDoubleClick={() => {
          setSnapPoint((current) => (current === 1 ? DEFAULT_THREAD_SNAP_POINT : 1));
        }}
      >
        <DrawerHeader>
          <div className={shadcnDrawerStyles.headerMeta}>
            <DrawerTitle>Thread</DrawerTitle>
            {description ? (
              <DrawerDescription>{description}</DrawerDescription>
            ) : (
              <DrawerDescription className="sr-only">
                Thread replies
              </DrawerDescription>
            )}
          </div>
          <div className={shadcnDrawerStyles.headerActions}>
            <DrawerClose
              className={shadcnDrawerStyles.closeButton}
              aria-label="Close thread"
            >
              <XIcon size={16} aria-hidden="true" />
            </DrawerClose>
          </div>
        </DrawerHeader>

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
          </div>

          <div className={shadcnDrawerStyles.threadComposerFooter}>
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
          </div>
        </aside>
      </DrawerContent>
    </Drawer>
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
