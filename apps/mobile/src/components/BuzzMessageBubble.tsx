import type { ChatMessage, MessageAttachment, Participant } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useBuzzTheme } from '../theme/ThemeProvider';
import { AgentProgressCard } from './AgentProgressCard';
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
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Staggered 3-dot bounce matching references/buzz/mobile/lib/features/channels/agent_typing_bubble.dart */
function AgentTypingDots({ color }: { color: string }) {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  useEffect(() => {
    const anims = dots.map((val, idx) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(idx * 140),
          Animated.timing(val, { toValue: -4, duration: 260, useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 260, useNativeDriver: true }),
          Animated.delay(240),
        ]),
      ),
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, []);

  return (
    <View style={styles.typingDots}>
      {dots.map((val, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { backgroundColor: color, transform: [{ translateY: val }] },
          ]}
        />
      ))}
    </View>
  );
}

/** Lightweight rich-text renderer supporting fenced code blocks and inline code. */
function MessageContent({
  content,
  textColor,
  codeBg,
}: {
  content: string;
  textColor: string;
  codeBg: string;
}) {
  const segments = content.split(/(```[\s\S]*?```)/g);
  return (
    <View style={{ gap: 6 }}>
      {segments.map((seg, idx) => {
        if (!seg) return null;
        if (seg.startsWith('```') && seg.endsWith('```')) {
          const inner = seg.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, '');
          return (
            <View key={idx} style={[styles.codeBlock, { backgroundColor: codeBg }]}>
              <Text style={[styles.codeText, { color: textColor }]} selectable>
                {inner.trim()}
              </Text>
            </View>
          );
        }
        const trimmed = seg.trim();
        if (!trimmed) return null;
        return (
          <Text key={idx} style={[buzzTypography.body, { color: textColor }]} selectable>
            {trimmed}
          </Text>
        );
      })}
    </View>
  );
}

export interface BuzzMessageBubbleProps {
  message: ChatMessage;
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
  sender,
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
  const { colors, accent } = useBuzzTheme();
  const isAgent = message.senderRole === 'agent';
  const isOwn = !isAgent && message.senderId === currentUserId;
  const senderName = sender?.name || message.senderId;
  const isRunning = message.card?.status === 'running';

  const bubbleBg = isOwn ? accent.fill : colors.receivedBubble;
  const bubbleFg = isOwn ? accent.foreground : colors.onSurface;
  const codeBg = isOwn ? 'rgba(0,0,0,0.16)' : colors.surfaceContainerHigh;

  const attachments = message.attachments ?? [];
  const imageAttachments = attachments.filter((a) => a.mimeType.startsWith('image/'));
  const fileAttachments = attachments.filter((a) => !a.mimeType.startsWith('image/'));

  const resolveUrl = (url: string) =>
    /^https?:\/\//i.test(url) ? url : `${serverBaseUrl}${url.startsWith('/') ? '' : '/'}${url}`;

  return (
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
                  size={32}
                  isAgent={isAgent}
                  status={isAgent ? sender?.status : undefined}
                />
              </Pressable>
            ) : null}
          </View>
        )}

        <View style={[styles.column, isOwn && styles.columnOwn]}>
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
                <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
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
              <Text style={[buzzTypography.micro, { color: colors.warning }]}>Pinned</Text>
            </View>
          )}

          {/* Main Bubble */}
          <Pressable
            onLongPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onLongPress(message);
            }}
            delayLongPress={260}
            style={({ pressed }) => [
              styles.bubble,
              {
                backgroundColor: bubbleBg,
                borderTopLeftRadius: !isOwn && stackPrevious ? 6 : 18,
                borderBottomLeftRadius: !isOwn && stackNext ? 6 : 18,
                borderTopRightRadius: isOwn && stackPrevious ? 6 : 18,
                borderBottomRightRadius: isOwn && stackNext ? 6 : 18,
                opacity: pressed ? 0.88 : 1,
              },
            ]}
          >
            {isAgent &&
            message.card &&
            (isRunning ||
              (message.card.progress &&
                (message.card.progress.toolCount > 0 || message.card.progress.steps.length > 0))) ? (
              <AgentProgressCard card={message.card} textColor={bubbleFg} />
            ) : isRunning ? (
              <View style={styles.runningHeader}>
                <AgentTypingDots color={bubbleFg} />
                <Text style={[buzzTypography.micro, { color: bubbleFg, opacity: 0.78 }]}>
                  {message.card?.title || 'Running'}
                </Text>
              </View>
            ) : null}

            {!(isAgent && isRunning && message.card?.progress && message.card.progress.steps.length > 0) && (
              <MessageContent content={message.content} textColor={bubbleFg} codeBg={codeBg} />
            )}

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

            {isOwn && !stackNext && (
              <Text style={[styles.ownTime, { color: bubbleFg }]}>
                {formatTime(message.createdAt)}
                {message.updatedAt && message.updatedAt > message.createdAt + 1000 ? ' · edited' : ''}
              </Text>
            )}
          </Pressable>

          {/* Image Attachments */}
          {imageAttachments.length > 0 && (
            <View style={styles.imageGrid}>
              {imageAttachments.map((att) => (
                <Pressable
                  key={att.id}
                  onPress={() => onOpenImage?.(att)}
                  style={[styles.imageWrap, { borderColor: colors.outline }]}
                >
                  <Image
                    source={{ uri: resolveUrl(att.url) }}
                    style={styles.thumbImage}
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
            </View>
          )}

          {/* File Attachments */}
          {fileAttachments.map((att) => (
            <View
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
            </View>
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
              style={[styles.threadPill, { backgroundColor: colors.surfaceContainerLow }]}
            >
              <Ionicons name="chatbubble-outline" size={12} color={colors.tertiary} />
              <Text style={[buzzTypography.micro, { color: colors.tertiary }]}>
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
              </Text>
              <Ionicons name="chevron-forward" size={12} color={colors.tertiary} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
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
    gap: 8,
  },
  rowOwn: {
    justifyContent: 'flex-end',
  },
  rowOther: {
    justifyContent: 'flex-start',
  },
  avatarSlot: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  column: {
    maxWidth: '78%',
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
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 6,
  },
  runningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  typingDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 14,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  codeBlock: {
    padding: 10,
    borderRadius: 10,
  },
  codeText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    lineHeight: 17,
  },
  terminalChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: buzzRadii.pill,
    marginTop: 2,
  },
  ownTime: {
    fontSize: 10,
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
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: buzzRadii.pill,
    marginTop: 2,
  },
});
