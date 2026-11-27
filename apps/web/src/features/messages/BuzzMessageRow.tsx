/**
 * Message row aligned with references/buzz-app/src/features/messages/MessageRow.tsx
 * and Messages.module.css.
 *
 * Preserves Buzz's exact DOM hierarchy:
 *   [data-message-id]
 *     DayDivider?
 *     .message[data-layout][data-stack-previous][data-stack-next][data-viewer-message][data-own]
 *       .messageGutter
 *       .messageBody
 *         .messageContent[data-bubble]
 *           .messageAvatar (.nestedAvatar > Avatar) — shown on last message of group (!stackNext)
 *           .messageHeader (MessageActionBar + .byline / sr-only)
 *           .pinnedMarker?
 *           MessageTimestampHint (.messagePayload)
 *             .messageBubble[data-own]
 *               BuzzMessageMarkdown (.text) / inline edit
 *               MessageReactions (.reactions)
 *             .messageAttachments? (images -> in-app MediaViewer, video/audio previews, files -> FileTypeIcon + download)
 *         reply preview?
 *         [data-thread-summary][data-reply-connector]?
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Avatar } from '../../design-system/ui/Avatar';
import { Button } from '../../design-system/ui/Button';
import { IconButton } from '../../design-system/ui/IconButton';
import { Input } from '../../design-system/ui/Input';
import {
  ArrowsOutIcon,
  DownloadIcon,
  PinIcon,
  RobotIcon,
} from '../../design-system/icons/index';
import { BuzzMessageMarkdown } from './BuzzMessageMarkdown';
import { AgentProgressCard } from './AgentProgressCard';
import { resolveAttachmentSource } from './BuzzMediaViewer';
import { writeClipboardText } from '../../shared/clipboard';
import { FileTypeIcon } from './FileTypeIcon';
import { MessageActionBar } from './MessageActionBar';
import { MessageReactions } from './MessageReactions';
import {
  DayDivider,
  MessageTimestamp,
  MessageTimestampHint,
} from './MessageTimestamp';
import styles from './Messages.module.css';
import type { UploadedAttachment } from './ProseMirrorComposer';
import type { ChatMessage, Participant } from './types';

const MAX_IMAGE_WIDTH = 360;
const MAX_IMAGE_HEIGHT = 320;
const MAX_DIMENSION_CACHE_SIZE = 500;
const imageDimensionCache = new Map<string, { width: number; height: number }>();

function rememberImageDimensions(src: string, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return;
  }
  if (imageDimensionCache.size >= MAX_DIMENSION_CACHE_SIZE && !imageDimensionCache.has(src)) {
    const oldest = imageDimensionCache.keys().next().value;
    if (oldest) imageDimensionCache.delete(oldest);
  }
  imageDimensionCache.set(src, { width, height });
}

function BuzzAttachmentImage({
  src,
  alt,
  compact,
  onClick,
}: {
  src: string;
  alt: string;
  compact: boolean;
  onClick: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | undefined>(() =>
    imageDimensionCache.get(src),
  );
  const [ready, setReady] = useState(() => imageDimensionCache.has(src));

  const syncFromImage = (img: HTMLImageElement | null) => {
    if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
      return;
    }
    const next = { width: img.naturalWidth, height: img.naturalHeight };
    rememberImageDimensions(src, next.width, next.height);
    setDimensions(next);
    setReady(true);
  };

  useLayoutEffect(() => {
    const cached = imageDimensionCache.get(src);
    if (cached) {
      setDimensions(cached);
      setReady(true);
      return;
    }
    setDimensions(undefined);
    setReady(false);
    syncFromImage(imgRef.current);
  }, [src]);

  let style: CSSProperties | undefined;
  if (compact) {
    style = { width: '100%', height: 0, paddingBottom: '100%', aspectRatio: 'auto' };
  } else if (dimensions) {
    const previewWidth = Math.max(
      1,
      Math.min(
        MAX_IMAGE_WIDTH,
        dimensions.width,
        (MAX_IMAGE_HEIGHT * dimensions.width) / dimensions.height,
      ),
    );
    const previewHeight = Math.max(1, (previewWidth * dimensions.height) / dimensions.width);
    if (Number.isFinite(previewWidth) && Number.isFinite(previewHeight)) {
      style = {
        width: previewWidth,
        aspectRatio: `${previewWidth} / ${previewHeight}`,
      };
    }
  }

  return (
    <button
      type="button"
      className={styles.attachmentImage}
      style={style}
      data-media-preview=""
      data-image-ready={ready || undefined}
      aria-label={`View image ${alt}`}
      onClick={onClick}
    >
      <span className={styles.attachmentImagePixels}>
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={(e) => syncFromImage(e.currentTarget)}
        />
      </span>
      <span className={styles.imageOutline} data-image-outline="" aria-hidden="true" />
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCliBadgeLabel(cliId?: string): string | null {
  if (!cliId) return null;
  const normalized = cliId.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'antigravity') return 'Antigravity';
  if (normalized === 'codex' || normalized === 'codex-app' || normalized === 'codex-cli') {
    return 'Codex';
  }
  if (normalized === 'claude' || normalized === 'claude-code') return 'Claude';
  if (normalized === 'cursor' || normalized === 'cursor-cli') return 'Cursor';
  if (normalized === 'opencode') return 'OpenCode';
  if (normalized === 'gemini' || normalized === 'gemini-cli') return 'Gemini';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatWorkingDirShort(workingDir?: string): string | null {
  if (!workingDir) return null;
  const cleaned = workingDir.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

export interface BuzzMessageRowProps {
  msg: ChatMessage;
  sender?: Participant;
  currentUserId: string;
  serverHttp: string;
  layout?: 'timeline' | 'thread' | 'continuation';
  stackPrevious?: boolean;
  stackNext?: boolean;
  day?: boolean;
  alignViewer?: boolean;
  compactAvatar?: boolean;
  inThread?: boolean;
  threadOpen?: boolean;
  highlighted?: boolean;
  isEditing?: boolean;
  editingDraft?: string;
  onEditingDraftChange?: (value: string) => void;
  onStartEdit?: (msg: ChatMessage) => void;
  onSaveEdit?: (messageId: string) => void;
  onCancelEdit?: () => void;
  onDelete?: (messageId: string) => void;
  onTogglePin?: (msg: ChatMessage) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread?: (messageId: string) => void;
  replyQuote?: ReactNode;
  replyPreview?: ReactNode;
  onReply?: () => void;
  onOpenTerminal?: (sessionId: string) => void;
  onOpenMedia?: (attachments: readonly UploadedAttachment[], selectedId: string) => void;
  onOpenAgentProfile?: (agentId: string) => void;
  onMentionParticipant?: (participant: { id: string; name: string; role: 'human' | 'agent' }) => void;
}

export function BuzzMessageRow({
  msg,
  sender,
  currentUserId,
  serverHttp,
  layout = 'timeline',
  stackPrevious = layout === 'continuation',
  stackNext = false,
  day = false,
  alignViewer = true,
  compactAvatar = false,
  inThread = false,
  threadOpen = false,
  highlighted = false,
  isEditing = false,
  editingDraft = '',
  onEditingDraftChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  onToggleReaction,
  onOpenThread,
  replyQuote,
  replyPreview,
  onReply,
  onOpenTerminal,
  onOpenMedia,
  onOpenAgentProfile,
  onMentionParticipant,
}: BuzzMessageRowProps) {
  const isAgent = msg.senderRole === 'agent';
  const isViewer = msg.senderRole === 'human' && msg.senderId === currentUserId;
  const senderName = sender?.name || msg.senderId;
  const terminalSessionId = msg.botmuxSessionId;

  const attachments = msg.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  const imageAttachments = attachments.filter((a) => a.mimeType.startsWith('image/'));
  const videoAttachments = attachments.filter((a) => a.mimeType.startsWith('video/'));
  const audioAttachments = attachments.filter((a) => a.mimeType.startsWith('audio/'));
  const fileAttachments = attachments.filter(
    (a) =>
      !a.mimeType.startsWith('image/') &&
      !a.mimeType.startsWith('video/') &&
      !a.mimeType.startsWith('audio/'),
  );

  const cardStatus = msg.card?.status;
  const hasTools = Boolean(
    msg.card?.progress &&
      (msg.card.progress.toolCount > 0 || msg.card.progress.steps.length > 0),
  );
  const hasProgressCard = Boolean(
    isAgent &&
      msg.card &&
      (cardStatus === 'running' ||
        cardStatus === 'failed' ||
        cardStatus === 'interrupted' ||
        cardStatus === 'timeout' ||
        cardStatus === 'dispatch_failed' ||
        cardStatus === 'waiting_approval' ||
        hasTools),
  );
  const showMarkdownContent =
    !(isAgent && cardStatus === 'running') && Boolean(msg.content.trim());
  const hasBubble = Boolean(showMarkdownContent || hasProgressCard || isEditing);
  const attachmentOnly = !hasBubble && hasAttachments;
  const ownBubble = isViewer && alignViewer && !attachmentOnly;
  const avatarSize = compactAvatar ? 'small' : 'default';

  const replyHandler =
    onReply ?? (!inThread && onOpenThread ? () => onOpenThread(msg.id) : undefined);

  return (
    <div
      data-message-id={msg.id}
      data-message-highlighted={highlighted || undefined}
      tabIndex={highlighted ? -1 : undefined}
      aria-current={threadOpen ? true : undefined}
    >
      {day && <DayDivider createdAt={msg.createdAt} />}
      <div
        className={highlighted ? `${styles.message} ${styles.messageHighlight}` : styles.message}
        data-highlight-surface=""
        data-thread-open={threadOpen || undefined}
        data-layout={layout}
        data-stack-previous={stackPrevious || undefined}
        data-stack-next={stackNext || undefined}
        data-viewer-message={isViewer && alignViewer ? '' : undefined}
        data-own={ownBubble || undefined}
      >
        <span className={styles.messageGutter} />

        <div className={styles.messageBody}>
          <div
            className={styles.messageContent}
            data-bubble={hasBubble || undefined}
          >
            {!stackNext && (
              <div className={styles.messageAvatar}>
                {isAgent && onOpenAgentProfile ? (
                  <button
                    type="button"
                    className={styles.nestedAvatar}
                    onClick={() => onOpenAgentProfile(msg.senderId)}
                    title={`查看 ${senderName} 详情`}
                    style={{
                      background: 'transparent',
                      border: 0,
                      padding: 0,
                      cursor: 'pointer',
                    }}
                  >
                    <Avatar
                      src={sender?.avatarUrl}
                      alt={senderName}
                      fallback={senderName}
                      size={avatarSize}
                      shape="squircle"
                    />
                  </button>
                ) : (
                  <span className={styles.nestedAvatar}>
                    <Avatar
                      src={sender?.avatarUrl}
                      alt={isAgent ? 'Agent' : `${senderName} avatar`}
                      fallback={senderName}
                      size={avatarSize}
                      shape={isAgent ? 'squircle' : 'circle'}
                    />
                  </span>
                )}
              </div>
            )}

            <div className={styles.messageHeader}>
              <MessageActionBar
                content={msg.content}
                canEdit={isViewer}
                pinned={Boolean(msg.pinned)}
                replyLabel={inThread ? 'Reply to message' : 'Reply in thread'}
                onReply={replyHandler}
                onTogglePin={onTogglePin ? () => onTogglePin(msg) : undefined}
                onOpenTerminal={
                  terminalSessionId && onOpenTerminal
                    ? () => onOpenTerminal(terminalSessionId)
                    : undefined
                }
                onCopyLink={() => {
                  const url = `${window.location.origin}${window.location.pathname}#channel=${encodeURIComponent(msg.channelId)}&message=${encodeURIComponent(msg.id)}`;
                  void writeClipboardText(url).catch(() => undefined);
                }}
                onReact={(emoji) => onToggleReaction(msg.id, emoji)}
                onEdit={onStartEdit ? () => onStartEdit(msg) : undefined}
                onDelete={onDelete ? () => onDelete(msg.id) : undefined}
              />
              <div className={stackPrevious ? 'sr-only select-none' : styles.byline}>
                <span className={styles.authorWithStatus}>
                  {isAgent && !stackPrevious && onMentionParticipant ? (
                    <button
                      type="button"
                      className={`${styles.author} ${styles.authorMentionBtn}`}
                      onClick={() =>
                        onMentionParticipant({
                          id: msg.senderId,
                          name: senderName,
                          role: 'agent',
                        })
                      }
                      title={`点击 @${senderName}`}
                    >
                      <span className={styles.authorPrefixSlot} aria-hidden="true">
                        <span className={styles.authorPrefixDefault}>
                          <RobotIcon size={14} />
                        </span>
                        <span className={styles.authorPrefixHover}>@</span>
                      </span>
                      <span>{senderName}</span>
                    </button>
                  ) : isAgent && !stackPrevious && onOpenAgentProfile ? (
                    <button
                      type="button"
                      className={`${styles.author} ${styles.authorMentionBtn}`}
                      onClick={() => onOpenAgentProfile(msg.senderId)}
                      title={`查看 ${senderName} 详情`}
                    >
                      <span className={styles.authorPrefixSlot} aria-hidden="true">
                        <RobotIcon size={14} />
                      </span>
                      <span>{senderName}</span>
                    </button>
                  ) : (
                    <strong className={styles.author}>
                      {isAgent && !stackPrevious && (
                        <span className={styles.authorPrefixSlot} aria-hidden="true">
                          <RobotIcon size={14} />
                        </span>
                      )}
                      <span>{senderName}</span>
                    </strong>
                  )}
                </span>
                {isAgent && !stackPrevious && (() => {
                  const engineLabel = formatCliBadgeLabel(sender?.cliId);
                  if (!engineLabel) return null;
                  const dirShort = formatWorkingDirShort(sender?.workingDir);
                  const statusLabel = sender?.status === 'online' ? '在线' : '离线';
                  const tooltip = [engineLabel, statusLabel, dirShort]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <span className={styles.authorEnginePill} title={tooltip}>
                      {engineLabel}
                    </span>
                  );
                })()}
                {!stackPrevious && <MessageTimestamp createdAt={msg.createdAt} />}
              </div>
            </div>

            {msg.pinned && (
              <div className={styles.pinnedMarker}>
                <span>
                  <PinIcon size={12} aria-hidden="true" />
                  Pinned
                </span>
              </div>
            )}

            <MessageTimestampHint
              createdAt={stackPrevious ? msg.createdAt : undefined}
              attachments={hasAttachments}
            >
              {replyQuote}
              {hasBubble && (
                <div
                  className={styles.messageBubble}
                  data-message-action-anchor=""
                  data-own={ownBubble || undefined}
                >
                  {isEditing ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        onSaveEdit?.(msg.id);
                      }}
                      style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                    >
                      <Input
                        value={editingDraft}
                        onChange={(e) => onEditingDraftChange?.(e.target.value)}
                        autoFocus
                      />
                      <Button type="submit" variant="primary" size="xs">
                        保存
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => onCancelEdit?.()}
                      >
                        取消
                      </Button>
                    </form>
                  ) : (
                    <>
                      {hasProgressCard && msg.card && (
                        <AgentProgressCard
                          card={msg.card}
                          createdAt={msg.createdAt}
                          sessionId={terminalSessionId}
                          onOpenTerminal={onOpenTerminal}
                          hasContent={showMarkdownContent}
                        />
                      )}
                      {showMarkdownContent && (
                        <BuzzMessageMarkdown
                          content={msg.content}
                          edited={Boolean(msg.updatedAt) && !(isAgent && msg.card)}
                        />
                      )}
                    </>
                  )}

                  <MessageReactions
                    reactions={msg.reactions}
                    currentUserId={currentUserId}
                    onToggle={(emoji) => onToggleReaction(msg.id, emoji)}
                  />
                </div>
              )}

              {hasAttachments && (
                <div className={styles.messageAttachments} data-message-attachments="">
                  {imageAttachments.length > 0 && (
                    <div className={styles.imageGroup}>
                      <div
                        className={`${styles.imageList} ${imageAttachments.length >= 4 ? styles.imageGrid : ''}`}
                        data-image-grid={imageAttachments.length >= 4 || undefined}
                        role="group"
                        aria-label={`${imageAttachments.length} ${imageAttachments.length === 1 ? 'image' : 'images'}`}
                      >
                        {imageAttachments.map((att) => {
                          const fullUrl = resolveAttachmentSource(att.url, serverHttp);
                          return (
                            <BuzzAttachmentImage
                              key={att.id}
                              src={fullUrl}
                              alt={att.name}
                              compact={imageAttachments.length >= 4}
                              onClick={() => onOpenMedia?.(attachments, att.id)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {videoAttachments.map((att) => {
                    const fullUrl = resolveAttachmentSource(att.url, serverHttp);
                    return (
                      <div
                        key={att.id}
                        className={`${styles.mediaPreview} ${inThread ? styles.mediaPreviewThread : ''}`}
                        data-video-preview=""
                      >
                        <video
                          className={styles.mediaVideo}
                          src={fullUrl}
                          controls
                          playsInline
                          preload="metadata"
                        />
                        {onOpenMedia && (
                          <div className={styles.mediaExpand}>
                            <IconButton
                              size="sm"
                              variant="glass"
                              shape="round"
                              type="button"
                              aria-label={`Open ${att.name} in fullscreen viewer`}
                              onClick={() => onOpenMedia(attachments, att.id)}
                              icon={<ArrowsOutIcon size={16} aria-hidden="true" />}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {audioAttachments.map((att) => {
                    const fullUrl = resolveAttachmentSource(att.url, serverHttp);
                    return (
                      <div key={att.id} className={styles.audioAttachment}>
                        <audio src={fullUrl} controls style={{ flex: 1, minWidth: 0 }} />
                        <IconButton
                          nativeButton={false}
                          role="link"
                          render={<a href={fullUrl} download={att.name} />}
                          size="xs"
                          aria-label={`Download ${att.name}`}
                          title={`Download ${att.name}`}
                          icon={<DownloadIcon size={14} aria-hidden="true" />}
                        />
                      </div>
                    );
                  })}

                  {fileAttachments.length > 0 && (
                    <div className={styles.fileGroup}>
                      {fileAttachments.map((att) => {
                        const fullUrl = resolveAttachmentSource(att.url, serverHttp);
                        return (
                          <a
                            key={att.id}
                            href={fullUrl}
                            download={att.name}
                            className={styles.fileAttachment}
                          >
                            <FileTypeIcon name={att.name} mime={att.mimeType} />
                            <span className={styles.fileAttachmentBody}>
                              <span className={styles.fileAttachmentName}>{att.name}</span>
                              <span className={styles.fileAttachmentMeta}>
                                {formatBytes(att.size)}
                              </span>
                            </span>
                            <DownloadIcon size={14} aria-hidden="true" />
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </MessageTimestampHint>
          </div>

          {!hasBubble && (
            <MessageReactions
              reactions={msg.reactions}
              currentUserId={currentUserId}
              onToggle={(emoji) => onToggleReaction(msg.id, emoji)}
            />
          )}

          {replyPreview}
          {!inThread && (msg.replyCount ?? 0) > 0 && onOpenThread && (
            <Button
              variant="ghost"
              size="sm"
              data-thread-summary=""
              data-reply-connector=""
              data-thread-unread={(msg.unreadReplyCount ?? 0) > 0 ? 'true' : undefined}
              data-thread-unread-count={(msg.unreadReplyCount ?? 0) > 0 ? msg.unreadReplyCount : undefined}
              type="button"
              onClick={() => onOpenThread(msg.id)}
            >
              {(msg.unreadReplyCount ?? 0) > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--accent-standard, #e5484d)',
                    marginRight: 6,
                    flexShrink: 0,
                  }}
                />
              )}
              <span>
                {msg.replyCount} {msg.replyCount === 1 ? 'reply' : 'replies'}
              </span>
              {(msg.unreadReplyCount ?? 0) > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    fontWeight: 600,
                    color: 'var(--accent-standard, #e5484d)',
                  }}
                >
                  · {msg.unreadReplyCount} new
                </span>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
