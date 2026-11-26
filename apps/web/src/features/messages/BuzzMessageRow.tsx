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
import type { ReactNode } from 'react';
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  replyPreview?: ReactNode;
  onReply?: () => void;
  onOpenTerminal?: (sessionId: string) => void;
  onOpenMedia?: (attachments: readonly UploadedAttachment[], selectedId: string) => void;
  onOpenAgentProfile?: (agentId: string) => void;
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
  replyPreview,
  onReply,
  onOpenTerminal,
  onOpenMedia,
  onOpenAgentProfile,
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
                  {isAgent && onOpenAgentProfile && !stackPrevious ? (
                    <button
                      type="button"
                      className={styles.author}
                      onClick={() => onOpenAgentProfile(msg.senderId)}
                      style={{
                        background: 'transparent',
                        border: 0,
                        padding: 0,
                        cursor: 'pointer',
                        fontWeight: 600,
                        color: 'inherit',
                        display: 'inline-flex',
                        alignItems: 'center',
                      }}
                    >
                      <RobotIcon aria-hidden="true" className={styles.authorAgentIcon} />
                      {senderName}
                    </button>
                  ) : (
                    <strong className={styles.author}>
                      {isAgent && !stackPrevious && (
                        <RobotIcon aria-hidden="true" className={styles.authorAgentIcon} />
                      )}
                      {senderName}
                    </strong>
                  )}
                </span>
                {isAgent && !stackPrevious && sender?.cliId && (
                  <span className={styles.authorOwner}>
                    <span aria-hidden="true">· </span>
                    {sender.cliId}
                  </span>
                )}
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
                            <button
                              key={att.id}
                              type="button"
                              className={styles.attachmentImage}
                              data-image-ready=""
                              aria-label={`View image ${att.name}`}
                              onClick={() => onOpenMedia?.(attachments, att.id)}
                            >
                              <span className={styles.attachmentImagePixels}>
                                <img src={fullUrl} alt={att.name} />
                              </span>
                            </button>
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
              type="button"
              onClick={() => onOpenThread(msg.id)}
            >
              <span>
                {msg.replyCount} {msg.replyCount === 1 ? 'reply' : 'replies'}
              </span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
