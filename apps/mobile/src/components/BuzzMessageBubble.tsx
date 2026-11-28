import type { LocalMessage } from '../store/localTimeline';
import { VoiceMessage } from './VoiceMessage';
import { SwipeReply } from './SwipeReply';
import { attachmentSource, openAttachment } from '../services/attachments';
import { useBubai } from '../store/BubaiProvider';
import type { ChatMessage, MessageAttachment, Participant } from '@buzz-botmux/chat-client';
import { buzzMessageLayout, buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React from 'react';
import {
  useWindowDimensions,
  Linking,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useBuzzTheme } from '../theme/ThemeProvider';
import { AgentProgressCard } from './AgentProgressCard';
import Markdown from 'react-native-markdown-display';
import { BuzzAvatar } from './BuzzAvatar';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatDayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((today - msgDay) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function MessageContent({
  content,
  textColor,
  codeBg,
}: {
  content: string;
  textColor: string;
  codeBg: string;
}) {
  return <Markdown style={{
    body: { ...buzzTypography.message, color: textColor },
    paragraph: { marginTop: 0, marginBottom: 0 },
    heading1: { fontSize: 20, lineHeight: 25, fontWeight: '600' },
    heading2: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
    heading3: { fontSize: 17, lineHeight: 23, fontWeight: '600' },
    heading4: buzzTypography.author, heading5: buzzTypography.author, heading6: buzzTypography.author,
    code_inline: { color: textColor, backgroundColor: codeBg, borderRadius: buzzRadii.xs, borderWidth: 0 },
    fence: { color: textColor, backgroundColor: codeBg, padding: 8, borderRadius: buzzRadii.xs, borderWidth: 0 },
    blockquote: { backgroundColor: codeBg, borderLeftColor: textColor, borderLeftWidth: 2, paddingHorizontal: 8 },
    bullet_list: { marginVertical: 3 }, ordered_list: { marginVertical: 3 },
    link: { color: textColor, textDecorationLine: 'underline' },
    hr: { backgroundColor: textColor, height: StyleSheet.hairlineWidth, opacity: 0.4 },
    table: { borderColor: textColor, borderRadius: buzzRadii.xs, borderWidth: StyleSheet.hairlineWidth },
    tr: { borderColor: textColor, borderBottomWidth: StyleSheet.hairlineWidth },
  }} onLinkPress={url => {
    if (/^https?:\/\//i.test(url)) void Linking.openURL(url).catch(error => Alert.alert('打开失败', String(error)));
    return false;
  }}>{content}</Markdown>;
}

export interface BuzzMessageBubbleProps {
  message: LocalMessage;
  onRetry?: (message:LocalMessage)=>void;
  sender?: Participant;
  currentUserId: string;
  serverBaseUrl: string;
  stackPrevious: boolean;
  stackNext: boolean;
  showDayDivider: boolean;
  inThread?: boolean;
  onLongPress: (message: ChatMessage) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenThread?: (message: ChatMessage) => void;
  onOpenImage?: (attachment: MessageAttachment) => void;
  onOpenAgentProfile?: (agentId: string) => void;
  onOpenTerminal?: (sessionId: string) => void;
}

export function BuzzMessageBubble({
  message,
  sender, onRetry,
  currentUserId,
  serverBaseUrl,
  stackPrevious,
  stackNext,
  showDayDivider,
  inThread = false,
  onLongPress,
  onToggleReaction,
  onOpenThread,
  onOpenImage,
  onOpenAgentProfile,
  onOpenTerminal,
}: BuzzMessageBubbleProps) {
  const { authToken, participants } = useBubai();
  const { colors, accent } = useBuzzTheme();
  const { width } = useWindowDimensions();
  const isAgent = message.senderRole === 'agent';
  const isOwn = !isAgent && message.senderId === currentUserId;
  const senderName = sender?.name || message.senderId;
  const isRunning = message.card?.status === 'running';

  const bubbleBg = isOwn ? accent.fill : colors.receivedBubble;
  const bubbleFg = isOwn ? accent.foreground : colors.onSurface;
  const codeBg = isOwn ? 'rgba(0,0,0,0.16)' : colors.surfaceContainerHigh;

  const attachments = message.attachments ?? [];
  const imageAttachments = attachments.filter((a) => a.mimeType.startsWith('image/'));
  const audioAttachments = attachments.filter(a => a.mimeType.startsWith('audio/'));
  const fileAttachments = attachments.filter(a => !a.mimeType.startsWith('image/') && !a.mimeType.startsWith('audio/'));



  return (
    <SwipeReply onReply={onOpenThread && !message.delivery ? ()=>onOpenThread(message) : undefined}>
    <View style={styles.wrapper}>
      {showDayDivider && (
        <View style={styles.dayDivider}>
          <View style={[styles.dayPill, { backgroundColor: colors.surfaceContainerLow }]}>
            <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
              {formatDayLabel(message.createdAt)}
            </Text>
          </View>
        </View>
      )}

      <View
        style={[
          styles.row,
          isOwn ? styles.rowOwn : styles.rowOther,
          { marginTop: stackPrevious ? 2 : 10 },
        ]}
      >
        {/* Left Avatar Slot (received messages only, shown on last item of stack) */}
        {!isOwn && (
          <View style={styles.avatarSlot}>
            {!stackNext ? (
              <Pressable
                disabled={!isAgent || !onOpenAgentProfile}
                onPress={() => isAgent && onOpenAgentProfile?.(message.senderId)}
              >
                <BuzzAvatar
                  name={senderName}
                  uri={sender?.avatarUrl}
                  size={buzzMessageLayout.avatar}
                  isAgent={isAgent}
                  status={isAgent ? sender?.status : undefined}
                />
              </Pressable>
            ) : null}
          </View>
        )}

        <View style={[styles.column, { maxWidth: width * buzzMessageLayout.widthFraction }, isOwn && styles.columnOwn]}>
          {/* Byline */}
          {!stackPrevious && !isOwn && (
            <View style={styles.byline}>
              <Pressable
                disabled={!isAgent || !onOpenAgentProfile}
                onPress={() => isAgent && onOpenAgentProfile?.(message.senderId)}
                style={styles.authorRow}
              >
                {isAgent && (
                  <Ionicons name="hardware-chip-outline" size={12} color={colors.onSurfaceVariant} />
                )}
                <Text style={[buzzTypography.author, { color: colors.onSurfaceVariant }]}>
                  {senderName}
                </Text>
                {isAgent && sender?.cliId && (
                  <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                    · {sender.cliId}
                  </Text>
                )}
              </Pressable>
              <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                {formatTime(message.createdAt)}
              </Text>
            </View>
          )}

          {message.pinned && (
            <View style={styles.pinnedRow}>
              <Ionicons name="pin" size={11} color={colors.warning} />
              <Text style={[buzzTypography.micro, { color: colors.warning }]}>已置顶</Text>
            </View>
          )}

          {/* Main Bubble */}
          <Pressable
            onLongPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              if (!message.delivery) onLongPress(message);
            }}
            delayLongPress={260}
            style={({ pressed }) => [
              styles.bubble,
              {
                backgroundColor: bubbleBg,
                borderRadius: buzzRadii.card,
                opacity: pressed ? 0.88 : 1,
              },
            ]}
          >
            {isAgent && message.card ? (
              <AgentProgressCard card={message.card} textColor={bubbleFg} />
            ) : null}

            {!!message.content && !(isAgent && isRunning && message.card?.progress && message.card.progress.steps.length > 0) && (
              <MessageContent content={message.content} textColor={bubbleFg} codeBg={codeBg} />
            )}

            {audioAttachments.map(attachment => <VoiceMessage key={attachment.id} url={attachment.url} server={serverBaseUrl} token={authToken} color={bubbleFg}/>)}
            {/* Botmux Terminal shortcut on agent turn messages */}
            {message.botmuxSessionId && onOpenTerminal && (
              <Pressable
                onPress={() => onOpenTerminal(message.botmuxSessionId!)}
                style={[
                  styles.terminalChip,
                  {
                    backgroundColor: isOwn
                      ? 'rgba(0,0,0,0.16)'
                      : colors.surfaceContainerHigh,
                  },
                ]}
              >
                <Ionicons name="terminal-outline" size={13} color={bubbleFg} />
                <Text style={[buzzTypography.micro, { color: bubbleFg }]}>
                  Terminal · {message.botmuxSessionId.slice(0, 8)}
                </Text>
              </Pressable>
            )}

          </Pressable>
          {isOwn && !stackNext && !message.delivery && (
            <Text accessibilityLabel={`已发送，${formatTime(message.createdAt)}`} style={[styles.ownTime,{color:colors.onSurfaceVariant}]}>
              {formatTime(message.createdAt)}{message.updatedAt && message.updatedAt > message.createdAt + 1000 ? ' · 已编辑' : ''} ✓
            </Text>
          )}
          {message.delivery && <Pressable accessibilityRole="button" disabled={message.delivery!=='failed'}
            onPress={()=>onRetry?.(message)}>
            <Text style={{color:message.delivery==='failed'?colors.error:colors.onSurfaceVariant,fontSize:13}}>
              {message.delivery==='failed'?'发送失败 · 点击重试':message.delivery==='queued'?'等待网络 · 恢复后自动发送':'正在发送…'}
            </Text>
          </Pressable>}
          {/* Image Attachments */}
          {imageAttachments.length > 0 && (
            <View style={styles.imageGrid}>
              {imageAttachments.map((att) => (
                <Pressable
                  key={att.id}
                  onPress={() => onOpenImage ? onOpenImage(att) : void openAttachment(serverBaseUrl, att, authToken).catch(error => Alert.alert('打开失败', String(error)))}
                  style={[styles.imageWrap, { borderColor: colors.outline }]}
                >
                  <Image
                    source={attachmentSource(serverBaseUrl, att.url, authToken)}
                    style={styles.thumbImage}
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
            </View>
          )}

          {/* File Attachments */}
          {fileAttachments.map((att) => (
            <Pressable
              onPress={() => void openAttachment(serverBaseUrl, att, authToken).catch(error => Alert.alert('打开失败', String(error)))}
              key={att.id}
              style={[
                styles.fileChip,
                { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline },
              ]}
            >
              <Ionicons name="document-outline" size={14} color={colors.onSurfaceVariant} />
              <Text
                style={[buzzTypography.caption, { color: colors.onSurface, flex: 1 }]}
                numberOfLines={1}
              >
                {att.name}
              </Text>
            </Pressable>
          ))}

          {/* Reactions */}
          {message.reactions && message.reactions.length > 0 && (
            <View style={[styles.reactionsRow, isOwn && styles.reactionsOwn]}>
              {message.reactions.map((rx) => {
                const mine = rx.userIds.includes(currentUserId);
                return (
                  <Pressable
                    key={rx.emoji}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      onToggleReaction(message.id, rx.emoji);
                    }}
                    style={[
                      styles.reactionPill,
                      {
                        backgroundColor: mine
                          ? `${accent.fill}28`
                          : colors.surfaceContainerLow,
                        borderColor: mine ? accent.fill : colors.outline,
                      },
                    ]}
                  >
                    <Text style={{ fontSize: 13 }}>{rx.emoji}</Text>
                    <Text style={[buzzTypography.micro, { color: colors.onSurface }]}>
                      {rx.userIds.length}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Thread Reply Summary */}
          {!inThread && (message.replyCount ?? 0) > 0 && onOpenThread && (
            <Pressable
              onPress={() => onOpenThread(message)}
              style={[styles.threadPill, {alignSelf: isOwn ? 'flex-end' : 'flex-start'}]}
            >
              {Array.from(new Set(message.replyPreviews?.map(reply => reply.senderId))).slice(0, 3).map(id => {
                const person = participants.find(p => p.id === id);
                return <View key={id} accessible={false} importantForAccessibility="no-hide-descendants"><BuzzAvatar size={18} name={person?.name || id} uri={person?.avatarUrl} isAgent={person?.role === 'agent'} /></View>;
              })}
              <Text numberOfLines={2} style={[buzzTypography.caption, { flexShrink: 1, color: colors.onSurfaceVariant }]}>
                {message.replyCount} 条回复
                {message.unreadReplyCount ? ` · ${message.unreadReplyCount} 未读` : ''}
                {message.replyPreviews?.map(reply => `\n${reply.content || reply.card?.title || '附件'}`).join('')}
              </Text>
              <Ionicons name="chevron-forward" size={12} color={colors.tertiary} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
    </SwipeReply>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: buzzGrid.xs,
  },
  dayDivider: {
    alignItems: 'center',
    marginVertical: 14,
  },
  dayPill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: buzzRadii.pill,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: buzzMessageLayout.avatarGap,
  },
  rowOwn: {
    justifyContent: 'flex-end',
  },
  rowOther: {
    justifyContent: 'flex-start',
  },
  avatarSlot: {
    width: buzzMessageLayout.avatar,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  column: {
    gap: 4,
  },
  columnOwn: {
    alignItems: 'flex-end',
  },
  byline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 4,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  pinnedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 4,
  },
  bubble: {
    paddingHorizontal: buzzMessageLayout.insetX,
    paddingVertical: buzzMessageLayout.insetY,
    gap: 6,
  },
  terminalChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 5,
    marginLeft: 10,
    marginTop: 4,
  },
  ownTime: {
    ...buzzTypography.timestamp,
    opacity: 0.65,
    alignSelf: 'flex-end',
  },
  imageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  imageWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  thumbImage: {
    width: 180,
    height: 140,
  },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  reactionsOwn: {
    justifyContent: 'flex-end',
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: buzzRadii.pill,
    borderWidth: 1,
  },
  threadPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 5,
    marginTop: 4,
  },
});
