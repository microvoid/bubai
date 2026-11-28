/**
 * Virtualized channel timeline with Buzz's Virtua Virtualizer, stick-to-bottom
 * locking across async height changes, prepend anchor preservation,
 * bottom-follow-only-at-bottom, and JumpToLatestButton.
 *
 * Adapted from references/buzz-app/src/features/messages/ChannelTimeline.tsx.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { Button } from '../../design-system/ui/Button';
import { calendarDay, toUnixSeconds } from '../../shared/datetime';
import { BuzzMessageRow } from './BuzzMessageRow';
import { JumpToLatestButton } from './JumpToLatestButton';
import { continuesMessageGroup } from './message-grouping';
import styles from './Messages.module.css';
import type { UploadedAttachment } from './ProseMirrorComposer';
import type { ChatMessage, MessageFocus, Participant } from './types';

type ReadingAnchor = {
  id: string;
  y: number;
};

type ReadingPosition = {
  bottom: boolean;
  anchor?: ReadingAnchor;
};

const BOTTOM_THRESHOLD_PX = 80;

export interface FormattedReplyPreview {
  text: string;
  status?: 'running' | 'failed';
}

export function formatReplyPreview(reply: ChatMessage): FormattedReplyPreview {
  const card = reply.card;
  if (card?.status === 'running') {
    const activeLabel = card.progress?.activeLabel?.trim();
    if (activeLabel) {
      return { text: `思考中 · ${activeLabel}`, status: 'running' };
    }
    if (card.phase === 'connecting') {
      return { text: '连接中…', status: 'running' };
    }
    return { text: '思考中…', status: 'running' };
  }

  const trimmedContent = reply.content.trim().replace(/\s+/g, ' ');
  if (
    !trimmedContent &&
    (card?.status === 'failed' ||
      card?.status === 'timeout' ||
      card?.status === 'dispatch_failed' ||
      card?.status === 'interrupted')
  ) {
    const summary = card.summary?.trim();
    const label = card.status === 'interrupted' ? '已中断' : '执行失败';
    return {
      text: summary && !summary.startsWith('botmux:') ? `${label} · ${summary}` : label,
      status: 'failed',
    };
  }

  const text =
    trimmedContent ||
    reply.attachments?.map((attachment) => attachment.name).join(', ') ||
    'Message';
  return { text };
}

function positionAt(scroller: HTMLElement): ReadingPosition {
  const bottom =
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <
    BOTTOM_THRESHOLD_PX;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const rows = scroller.querySelectorAll<HTMLElement>('[data-message-id]');
  let anchor: ReadingAnchor | undefined;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > scrollerTop) {
      const id = row.dataset.messageId;
      if (id) {
        anchor = { id, y: Math.round(rect.top - scrollerTop) };
      }
      break;
    }
  }
  return anchor ? { bottom, anchor } : { bottom };
}

export interface BuzzChannelTimelineProps {
  channelId: string;
  messages: readonly ChatMessage[];
  participants: readonly Participant[];
  currentUserId: string;
  serverHttp: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  activeThreadRootId: string | null;
  messageFocus?: MessageFocus;
  unreadSince?: number | null;
  editingMessageId: string | null;
  editingDraft: string;
  onEditingDraftChange: (value: string) => void;
  onStartEdit: (msg: ChatMessage) => void;
  onSaveEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onDelete: (messageId: string) => void;
  onTogglePin: (msg: ChatMessage) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread: (messageId: string) => void;
  onOpenReply: (message: ChatMessage) => void;
  onOpenTerminal: (sessionId: string) => void;
  onOpenMedia?: (attachments: readonly UploadedAttachment[], selectedId: string) => void;
  onOpenAgentProfile?: (agentId: string) => void;
  onMentionParticipant?: (participant: { id: string; name: string; role: 'human' | 'agent' }) => void;
  emptyState: ReactNode;
}

const EMPTY_MESSAGES: readonly ChatMessage[] = [];

/** Keyed by channelId (matching Buzz's ChannelTimeline) so switching channels
 * cleanly persists the outgoing position and restores the incoming channel's. */
export function BuzzChannelTimeline(props: BuzzChannelTimelineProps) {
  // History changes asynchronously after channel selection. Only position the
  // new timeline once its own rows arrive.
  const messages = props.messages[0]?.channelId === props.channelId ? props.messages : EMPTY_MESSAGES;
  return <Timeline key={props.channelId || '__empty__'} {...props} messages={messages} />;
}

function Timeline({
  messages,
  participants,
  currentUserId,
  serverHttp,
  hasMore,
  loadingMore,
  onLoadOlder,
  activeThreadRootId,
  messageFocus,
  unreadSince,
  editingMessageId,
  editingDraft,
  onEditingDraftChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  onToggleReaction,
  onOpenThread,
  onOpenReply,
  onOpenTerminal,
  onOpenMedia,
  onOpenAgentProfile,
  onMentionParticipant,
  emptyState,
}: BuzzChannelTimelineProps) {
  const scroller = useRef<HTMLElement | null>(null);
  const edge = useRef<HTMLDivElement | null>(null);
  const handle = useRef<VirtualizerHandle | null>(null);

  const [size, setSize] = useState({ width: 0, edgeHeight: 0 });
  const [jumpVisible, setJumpVisible] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const savedPosition = useRef<ReadingPosition | null>({ bottom: true });
  const settled = useRef(false);
  const follow = useRef(true);
  const userScrolled = useRef(false);
  const jumpingToLatest = useRef(false);
  const jumpTimer = useRef<number | undefined>(undefined);
  const lastScrollTop = useRef(0);
  const touchStartY = useRef<number | undefined>(undefined);
  const pendingPrependAnchor = useRef<ReadingAnchor | null>(null);
  const placedFocus = useRef<number | undefined>(undefined);
  const focusPending = !!messageFocus && messageFocus.sequence !== placedFocus.current;

  // Track previous head/tail to detect prepends vs appends accurately during render
  const prevIdsRef = useRef<{ firstId?: string; lastId?: string; count: number }>({
    firstId: messages[0]?.id,
    lastId: messages[messages.length - 1]?.id,
    count: messages.length,
  });

  const isPrepending = useMemo(() => {
    const prev = prevIdsRef.current;
    if (
      prev.count > 0 &&
      messages.length > prev.count &&
      prev.firstId &&
      messages[0]?.id !== prev.firstId &&
      messages.some((m) => m.id === prev.firstId)
    ) {
      return true;
    }
    return false;
  }, [messages]);

  const participantMap = useMemo(
    () => new Map(participants.map((p) => [p.id, p])),
    [participants],
  );

  const pinToBottom = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  }, []);

  // Measure scroller width and edge header height so Virtua can mount immediately
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const nextWidth = el.clientWidth;
      const nextEdge = edge.current?.offsetHeight ?? 0;
      setSize((prev) =>
        prev.width === nextWidth && prev.edgeHeight === nextEdge
          ? prev
          : { width: nextWidth, edgeHeight: nextEdge },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (edge.current) observer.observe(edge.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
    };
  }, []);

  // Initial scroll placement: always start at bottom unless an explicit messageFocus takes priority
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || size.width === 0 || messages.length === 0 || settled.current || focusPending) return;

    follow.current = true;
    userScrolled.current = false;
    pinToBottom(el);
    settled.current = true;
    savedPosition.current = { bottom: true };
    setJumpVisible(false);
    const frame = requestAnimationFrame(() => {
      const current = scroller.current;
      if (!current) return;
      if (follow.current && !userScrolled.current && !focusPending) {
        pinToBottom(current);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, size.width, focusPending, pinToBottom]);

  // Stick-to-bottom observer: keep pinned when Virtua finishes measuring tall items,
  // images finish loading, or the latest message expands in place (e.g. Agent reply).
  useEffect(() => {
    const el = scroller.current;
    if (!el || size.width === 0 || messages.length === 0) return;
    if (typeof ResizeObserver === 'undefined') return;

    const listEl = el.querySelector<HTMLElement>(':scope > ol');
    if (!listEl) return;

    const observer = new ResizeObserver(() => {
      const current = scroller.current;
      if (!current) return;
      if (follow.current && !userScrolled.current && !focusPending && !jumpingToLatest.current) {
        const distanceFromBottom =
          current.scrollHeight - current.clientHeight - current.scrollTop;
        if (distanceFromBottom > 1) {
          pinToBottom(current);
        }
        setJumpVisible(false);
      }
    });
    observer.observe(listEl);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size.width, messages.length, focusPending, pinToBottom]);

  // Handle list mutations after initial settle: prepends, appends, and in-place tail updates
  useLayoutEffect(() => {
    const prev = prevIdsRef.current;
    const nextFirstId = messages[0]?.id;
    const nextLastId = messages[messages.length - 1]?.id;

    if (!focusPending && settled.current && messages.length > 0 && scroller.current) {
      const el = scroller.current;

      // Case A: Older messages prepended at top -> verify/preserve anchor
      if (isPrepending) {
        const anchor = pendingPrependAnchor.current ?? savedPosition.current?.anchor;
        pendingPrependAnchor.current = null;
        if (anchor) {
          const anchorIdx = messages.findIndex((m) => m.id === anchor.id);
          if (anchorIdx >= 0) {
            requestAnimationFrame(() => {
              const current = scroller.current;
              if (!current) return;
              const row = current.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(anchor.id)}"]`,
              );
              if (row) {
                const currentY =
                  row.getBoundingClientRect().top - current.getBoundingClientRect().top;
                const drift = currentY - anchor.y;
                if (Math.abs(drift) > 1) {
                  current.scrollTop += drift;
                }
              } else {
                handle.current?.scrollToIndex(anchorIdx, { align: 'start' });
              }
              lastScrollTop.current = current.scrollTop;
              const nextPos = positionAt(current);
              savedPosition.current = { ...nextPos, bottom: false };
              setJumpVisible(true);
            });
          }
        }
      }
      // Case B: New message(s) appended at bottom
      else if (
        prev.count > 0 &&
        messages.length > prev.count &&
        nextLastId &&
        nextLastId !== prev.lastId
      ) {
        const addedCount = messages.length - prev.count;
        const latest = messages[messages.length - 1];
        const isOwnNewMessage =
          latest.senderRole === 'human' && latest.senderId === currentUserId;

        if (follow.current || isOwnNewMessage) {
          follow.current = true;
          userScrolled.current = false;
          pinToBottom(el);
          requestAnimationFrame(() => {
            if (scroller.current && follow.current && !userScrolled.current) {
              pinToBottom(scroller.current);
            }
          });
          setJumpVisible(false);
          setNewMessageCount(0);
          savedPosition.current = { bottom: true };
        } else {
          setNewMessageCount((n) => n + addedCount);
          setJumpVisible(true);
        }
      }
      // Case C: In-place update (e.g. Agent card expanding into full Markdown reply)
      else if (follow.current && !userScrolled.current) {
        requestAnimationFrame(() => {
          if (scroller.current && follow.current && !userScrolled.current && !focusPending) {
            const distanceFromBottom =
              scroller.current.scrollHeight -
              scroller.current.clientHeight -
              scroller.current.scrollTop;
            if (distanceFromBottom > 1) {
              pinToBottom(scroller.current);
            }
          }
        });
      }
    }

    prevIdsRef.current = {
      firstId: nextFirstId,
      lastId: nextLastId,
      count: messages.length,
    };
  }, [messages, isPrepending, currentUserId, focusPending, pinToBottom]);

  useLayoutEffect(() => {
    if (!messageFocus || !focusPending || !size.width) return;
    const index = messages.findIndex((message) => message.id === messageFocus.id);
    if (index === -1 || !handle.current) return;

    follow.current = false;
    userScrolled.current = true;
    jumpingToLatest.current = false;
    if (jumpTimer.current !== undefined) {
      clearTimeout(jumpTimer.current);
      jumpTimer.current = undefined;
    }
    pendingPrependAnchor.current = null;
    settled.current = true;
    handle.current.scrollToIndex(index, { align: 'center' });

    let frame = 0;
    let attempts = 0;
    const settle = () => {
      const element = scroller.current;
      if (!element) return;
      const row = element.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageFocus.id)}"]`,
      );
      if (!row && attempts++ < 12) {
        frame = requestAnimationFrame(settle);
        return;
      }
      placedFocus.current = messageFocus.sequence;
      if (row) {
        const bounds = row.getBoundingClientRect();
        const viewport = element.getBoundingClientRect();
        element.scrollTop += bounds.top - viewport.top + (bounds.height - element.clientHeight) / 2;
        if (!activeThreadRootId) row.focus({ preventScroll: true });
      }
      lastScrollTop.current = element.scrollTop;
      const position = positionAt(element);
      savedPosition.current = position;
      setJumpVisible(!position.bottom);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [activeThreadRootId, focusPending, messageFocus, messages, size.width]);

  const triggerLoadOlder = useCallback(() => {
    if (!hasMore || loadingMore) return;
    if (scroller.current) {
      const pos = positionAt(scroller.current);
      if (pos.anchor) {
        pendingPrependAnchor.current = pos.anchor;
      }
      follow.current = false;
      userScrolled.current = true;
    }
    onLoadOlder();
  }, [hasMore, loadingMore, onLoadOlder]);

  const jumpToLatest = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    follow.current = true;
    userScrolled.current = false;
    jumpingToLatest.current = true;
    setJumpVisible(false);
    setNewMessageCount(0);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    savedPosition.current = { bottom: true };
    if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
    jumpTimer.current = window.setTimeout(() => {
      jumpTimer.current = undefined;
      if (scroller.current && jumpingToLatest.current) {
        pinToBottom(scroller.current);
      }
      jumpingToLatest.current = false;
    }, 350);
  }, [pinToBottom]);

  return (
    <section
      ref={scroller}
      className={styles.feed}
      data-message-scroller=""
      data-jump-visible={jumpVisible || undefined}
      tabIndex={0}
      aria-label="Channel message history"
      onWheel={(event) => {
        if (event.deltaY < 0) {
          userScrolled.current = true;
          jumpingToLatest.current = false;
        }
      }}
      onPointerDown={(event) => {
        jumpingToLatest.current = false;
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX >= rect.left + event.currentTarget.clientWidth) {
            userScrolled.current = true;
          }
        }
      }}
      onTouchStart={(event) => {
        jumpingToLatest.current = false;
        touchStartY.current = event.currentTarget.scrollTop > 0 ? event.touches[0]?.clientY : undefined;
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY;
        if (touchStartY.current !== undefined && y !== undefined && y > touchStartY.current + 2) {
          userScrolled.current = true;
          follow.current = false;
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
          userScrolled.current = true;
          jumpingToLatest.current = false;
        }
      }}
      onLoadCapture={() => {
        if (
          scroller.current &&
          follow.current &&
          !userScrolled.current &&
          !focusPending &&
          !jumpingToLatest.current
        ) {
          pinToBottom(scroller.current);
        }
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (!settled.current || jumpingToLatest.current) {
          lastScrollTop.current = element.scrollTop;
          return;
        }
        if (element.scrollTop < lastScrollTop.current - 2) {
          userScrolled.current = true;
        }
        const pos = positionAt(element);
        const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
        if (pos.bottom && (!userScrolled.current || distance <= 1)) {
          follow.current = true;
          userScrolled.current = false;
          savedPosition.current = { bottom: true };
          setJumpVisible(false);
          setNewMessageCount(0);
        } else if (follow.current && !userScrolled.current && !focusPending) {
          pinToBottom(element);
          setJumpVisible(false);
        } else {
          follow.current = false;
          savedPosition.current = pos;
          setJumpVisible(!pos.bottom);
        }
        lastScrollTop.current = element.scrollTop;
      }}
    >
      <div
        ref={edge}
        className={styles.edge}
        data-history-space={hasMore || undefined}
      >
        {hasMore && (
          <Button
            variant="outline"
            size="sm"
            loading={loadingMore}
            disabled={loadingMore}
            onClick={triggerLoadOlder}
          >
            {loadingMore ? 'Loading older…' : 'Load older messages'}
          </Button>
        )}
      </div>

      <JumpToLatestButton
        visible={jumpVisible}
        newMessageCount={newMessageCount}
        onClick={jumpToLatest}
      />

      {messages.length === 0 ? (
        <div className={styles.emptyConversation}>{emptyState}</div>
      ) : (
        size.width > 0 && (
          <Virtualizer
            ref={handle}
            scrollRef={scroller}
            shift={isPrepending && !!handle.current?.viewportSize}
            bufferSize={1600}
            as="ol"
            item="li"
            startMargin={size.edgeHeight}
          >
            {messages.map((msg, index) => {
              const previous = messages[index - 1];
              const next = messages[index + 1];
              const replies = msg.replyPreviews;
              const isFirstUnread =
                unreadSince != null &&
                msg.createdAt > unreadSince &&
                msg.senderId !== currentUserId &&
                (!previous || previous.createdAt <= unreadSince || previous.senderId === currentUserId) &&
                !messages.slice(0, index).some(
                  (m) => m.createdAt > unreadSince && m.senderId !== currentUserId,
                );
              const stackPrevious =
                !isFirstUnread &&
                !previous?.replyPreviews?.length &&
                continuesMessageGroup(previous, msg);
              const stackNext = !!next && !replies?.length && continuesMessageGroup(msg, next);
              const day =
                index === 0 ||
                calendarDay(toUnixSeconds(previous!.createdAt)) !==
                  calendarDay(toUnixSeconds(msg.createdAt));

              return (
                <div key={msg.id}>
                  {isFirstUnread && (
                    <div
                      data-unread-divider="true"
                      role="separator"
                      aria-label="New messages"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        margin: '12px 24px 6px',
                        color: 'var(--accent-standard, #e5484d)',
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: '0.02em',
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          height: 1,
                          background: 'var(--accent-standard, #e5484d)',
                          opacity: 0.45,
                        }}
                      />
                      <span>New messages</span>
                      <span
                        style={{
                          flex: 1,
                          height: 1,
                          background: 'var(--accent-standard, #e5484d)',
                          opacity: 0.45,
                        }}
                      />
                    </div>
                  )}
                  <BuzzMessageRow
                    msg={msg}
                  sender={participantMap.get(msg.senderId)}
                  currentUserId={currentUserId}
                  serverHttp={serverHttp}
                  layout={stackPrevious ? 'continuation' : 'timeline'}
                  stackPrevious={stackPrevious}
                  stackNext={stackNext}
                  day={day}
                  threadOpen={msg.id === activeThreadRootId}
                  highlighted={msg.id === messageFocus?.id}
                  isEditing={editingMessageId === msg.id}
                  editingDraft={editingDraft}
                  onEditingDraftChange={onEditingDraftChange}
                  onStartEdit={onStartEdit}
                  onSaveEdit={onSaveEdit}
                  onCancelEdit={onCancelEdit}
                  onDelete={onDelete}
                  onTogglePin={onTogglePin}
                  onToggleReaction={onToggleReaction}
                  onOpenThread={onOpenThread}
                  hasRunningReply={Boolean(replies?.some((reply) => reply.card?.status === 'running'))}
                  replyPreview={replies?.length ? (
                    <ol className={styles.threadPreviews} aria-label="Recent replies">
                      {replies.map((reply) => {
                        const sender = participantMap.get(reply.senderId)?.name || reply.senderId;
                        const preview = formatReplyPreview(reply);
                        return (
                          <li key={reply.id}>
                            <Button
                              variant="ghost"
                              size="caption"
                              shape="control"
                              data-preview-status={preview.status}
                              onClick={() => onOpenReply(reply)}
                            >
                              <strong className={styles.threadPreviewSender}>{sender}</strong>
                              {preview.status === 'running' && (
                                <span className={styles.threadPreviewPulse} aria-hidden="true" />
                              )}
                              <span
                                className={styles.threadPreviewText}
                                data-preview-status={preview.status}
                              >
                                {preview.text}
                              </span>
                            </Button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}
                    onOpenTerminal={onOpenTerminal}
                    onOpenMedia={onOpenMedia}
                    onOpenAgentProfile={onOpenAgentProfile}
                    onMentionParticipant={onMentionParticipant}
                  />
                </div>
              );
            })}
          </Virtualizer>
        )
      )}

      <div className={styles.timelineEnd} aria-hidden="true" />
    </section>
  );
}
