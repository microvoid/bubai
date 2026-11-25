/**
 * Virtualized channel timeline with Buzz's Virtua Virtualizer, reading position
 * restoration, prepend anchor preservation, bottom-follow-only-at-bottom, and
 * JumpToLatestButton.
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

const VIEW_STORAGE_PREFIX = 'buzz-view.v1:';
const VIEW_SCOPE = 'buzz-botmux';
const BOTTOM_THRESHOLD_PX = 80;

function viewStorageKey(channelId: string): string {
  return `${VIEW_STORAGE_PREFIX}${JSON.stringify([VIEW_SCOPE, `scroll:${channelId}`])}`;
}

function readSavedPosition(channelId: string): ReadingPosition | null {
  try {
    const raw = localStorage.getItem(viewStorageKey(channelId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as { bottom?: unknown; anchor?: { id?: unknown; y?: unknown } };
    if (typeof obj.bottom !== 'boolean') return null;
    if (
      obj.anchor &&
      typeof obj.anchor.id === 'string' &&
      typeof obj.anchor.y === 'number' &&
      Number.isFinite(obj.anchor.y)
    ) {
      return { bottom: obj.bottom, anchor: { id: obj.anchor.id, y: obj.anchor.y } };
    }
    return { bottom: obj.bottom };
  } catch {
    return null;
  }
}

function writeSavedPosition(channelId: string, position: ReadingPosition | null): void {
  if (!channelId || !position) return;
  try {
    const payload = position.bottom ? { bottom: true } : position;
    localStorage.setItem(viewStorageKey(channelId), JSON.stringify(payload));
  } catch {
    // Ignore quota / private-mode storage errors
  }
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
  emptyState: ReactNode;
}

/** Keyed by channelId (matching Buzz's ChannelTimeline) so switching channels
 * cleanly persists the outgoing position and restores the incoming channel's. */
export function BuzzChannelTimeline(props: BuzzChannelTimelineProps) {
  return <Timeline key={props.channelId || '__empty__'} {...props} />;
}

function Timeline({
  channelId,
  messages,
  participants,
  currentUserId,
  serverHttp,
  hasMore,
  loadingMore,
  onLoadOlder,
  activeThreadRootId,
  messageFocus,
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
  emptyState,
}: BuzzChannelTimelineProps) {
  const scroller = useRef<HTMLElement | null>(null);
  const edge = useRef<HTMLDivElement | null>(null);
  const handle = useRef<VirtualizerHandle | null>(null);

  const [size, setSize] = useState({ width: 0, edgeHeight: 0 });
  const [jumpVisible, setJumpVisible] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const initialSaved = useRef<ReadingPosition | null>(
    channelId ? readSavedPosition(channelId) : null,
  );
  const savedPosition = useRef<ReadingPosition | null>(initialSaved.current);
  const settled = useRef(false);
  const follow = useRef(initialSaved.current ? initialSaved.current.bottom : true);
  const userScrolled = useRef(false);
  const jumpingToLatest = useRef(false);
  const jumpTimer = useRef<number | undefined>(undefined);
  const lastWritten = useRef<string | undefined>(undefined);
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

  const persistPosition = useCallback(
    (pos: ReadingPosition | null) => {
      if (!channelId || !pos) return;
      const normalized = pos.bottom ? { bottom: true } : pos;
      const serialized = JSON.stringify(normalized);
      if (serialized === lastWritten.current) return;
      lastWritten.current = serialized;
      writeSavedPosition(channelId, normalized);
    },
    [channelId],
  );

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

  // Save reading position on unmount (e.g., switching channels) and pagehide
  useEffect(() => {
    const flush = () => {
      if (settled.current && scroller.current) {
        savedPosition.current = positionAt(scroller.current);
        persistPosition(savedPosition.current);
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
      flush();
    };
  }, [persistPosition]);

  // Initial scroll placement (restore saved anchor or start at bottom)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || size.width === 0 || messages.length === 0 || settled.current || focusPending) return;

    const saved = initialSaved.current;
    if (saved && !saved.bottom && saved.anchor) {
      const targetIndex = messages.findIndex((m) => m.id === saved.anchor!.id);
      if (targetIndex >= 0) {
        follow.current = false;
        handle.current?.scrollToIndex(targetIndex, { align: 'start' });
        const refine = () => {
          const current = scroller.current;
          if (!current) return;
          const row = current.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(saved.anchor!.id)}"]`,
          );
          if (row) {
            const currentY =
              row.getBoundingClientRect().top - current.getBoundingClientRect().top;
            const drift = currentY - saved.anchor!.y;
            if (Math.abs(drift) > 1) {
              current.scrollTop += drift;
            }
          }
          settled.current = true;
          savedPosition.current = positionAt(current);
          setJumpVisible(!savedPosition.current.bottom);
        };
        // Run immediately and once after Virtua flushes item measurements
        refine();
        requestAnimationFrame(refine);
        return;
      }
    }

    // Default: start at bottom
    follow.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const current = scroller.current;
      if (!current) return;
      if (follow.current) {
        current.scrollTop = current.scrollHeight;
      }
      settled.current = true;
      savedPosition.current = { bottom: true };
      setJumpVisible(false);
    });
  }, [messages, size.width, focusPending]);

  // Handle list mutations after initial settle: prepends vs appends
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
              const nextPos = positionAt(current);
              savedPosition.current = { ...nextPos, bottom: false };
              persistPosition(savedPosition.current);
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
          el.scrollTop = el.scrollHeight;
          requestAnimationFrame(() => {
            if (scroller.current && follow.current) {
              scroller.current.scrollTop = scroller.current.scrollHeight;
            }
          });
          setJumpVisible(false);
          setNewMessageCount(0);
          savedPosition.current = { bottom: true };
          persistPosition(savedPosition.current);
        } else {
          setNewMessageCount((n) => n + addedCount);
          setJumpVisible(true);
        }
      }
    }

    prevIdsRef.current = {
      firstId: nextFirstId,
      lastId: nextLastId,
      count: messages.length,
    };
  }, [messages, isPrepending, currentUserId, persistPosition, focusPending]);

  useLayoutEffect(() => {
    if (!messageFocus || !focusPending || !size.width) return;
    const index = messages.findIndex((message) => message.id === messageFocus.id);
    if (index === -1 || !handle.current) return;

    follow.current = false;
    jumpingToLatest.current = false;
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
      const position = positionAt(element);
      savedPosition.current = position;
      persistPosition(position);
      setJumpVisible(!position.bottom);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [activeThreadRootId, focusPending, messageFocus, messages, persistPosition, size.width]);

  const triggerLoadOlder = useCallback(() => {
    if (!hasMore || loadingMore) return;
    if (scroller.current) {
      const pos = positionAt(scroller.current);
      if (pos.anchor) {
        pendingPrependAnchor.current = pos.anchor;
      }
      follow.current = false;
    }
    onLoadOlder();
  }, [hasMore, loadingMore, onLoadOlder]);

  const jumpToLatest = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    follow.current = true;
    jumpingToLatest.current = true;
    setJumpVisible(false);
    setNewMessageCount(0);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    savedPosition.current = { bottom: true };
    persistPosition(savedPosition.current);
    if (jumpTimer.current !== undefined) clearTimeout(jumpTimer.current);
    jumpTimer.current = window.setTimeout(() => {
      jumpTimer.current = undefined;
      if (scroller.current && jumpingToLatest.current) {
        scroller.current.scrollTop = scroller.current.scrollHeight;
      }
      jumpingToLatest.current = false;
    }, 350);
  }, [messages.length, persistPosition]);

  return (
    <section
      ref={scroller}
      className={styles.feed}
      data-message-scroller=""
      data-jump-visible={jumpVisible || undefined}
      tabIndex={0}
      aria-label="Channel message history"
      onWheel={() => {
        userScrolled.current = true;
        jumpingToLatest.current = false;
      }}
      onPointerDown={() => {
        userScrolled.current = true;
        jumpingToLatest.current = false;
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (!settled.current || jumpingToLatest.current) return;
        const pos = positionAt(element);
        follow.current = pos.bottom;
        savedPosition.current = pos;
        setJumpVisible(!pos.bottom);
        if (pos.bottom) setNewMessageCount(0);
        persistPosition(pos);
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
              const stackPrevious =
                !previous?.replyPreviews?.length && continuesMessageGroup(previous, msg);
              const stackNext = !!next && !replies?.length && continuesMessageGroup(msg, next);
              const day =
                index === 0 ||
                calendarDay(toUnixSeconds(previous!.createdAt)) !==
                  calendarDay(toUnixSeconds(msg.createdAt));

              return (
                <BuzzMessageRow
                  key={msg.id}
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
                  replyPreview={replies?.length ? (
                    <ol className={styles.threadPreviews} aria-label="Recent replies">
                      {replies.map((reply) => {
                        const sender = participantMap.get(reply.senderId)?.name || reply.senderId;
                        const preview = reply.content.trim().replace(/\s+/g, ' ')
                          || reply.attachments?.map((attachment) => attachment.name).join(', ')
                          || reply.card?.title
                          || 'Message';
                        return (
                          <li key={reply.id}>
                            <Button variant="ghost" size="caption" shape="control" onClick={() => onOpenReply(reply)}>
                              <strong className={styles.threadPreviewSender}>{sender}</strong>
                              <span className={styles.threadPreviewText}>{preview}</span>
                            </Button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}
                  onOpenTerminal={onOpenTerminal}
                  onOpenMedia={onOpenMedia}
                  onOpenAgentProfile={onOpenAgentProfile}
                />
              );
            })}
          </Virtualizer>
        )
      )}

      <div className={styles.timelineEnd} aria-hidden="true" />
    </section>
  );
}
