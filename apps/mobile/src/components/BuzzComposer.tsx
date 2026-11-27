import { useBubai } from '../store/BubaiProvider';
import { buildMentionCandidates, filterMentionCandidates, type Channel, type ChatMessage, type Participant } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useBuzzTheme } from '../theme/ThemeProvider';
import { BuzzAvatar } from './BuzzAvatar';

interface BuzzComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onPickAttachment?: () => void;
  uploading?: boolean;
  placeholder: string;
  participants: readonly Participant[];
  channel?: Channel;
  currentUserId: string;
  messages: ChatMessage[];
  threadMessages?: ChatMessage[];
  editingLabel?: string | null;
  onCancelEdit?: () => void;
  disabled?: boolean;
}

export function BuzzComposer({
  value,
  onChangeText,
  onSend,
  onPickAttachment,
  uploading = false,
  placeholder,
  participants,
  channel, currentUserId, messages, threadMessages,
  editingLabel,
  onCancelEdit,
  disabled = false,
}: BuzzComposerProps) {
  const { colors, accent } = useBuzzTheme();

  const { sendTyping, subscribeWsEvents } = useBubai();
  const [typingUserId, setTypingUserId] = useState('');
  const typingName = participants.find(p => p.id === typingUserId)?.name || typingUserId;
  const lastTyped = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    setTypingUserId('');
    const unsubscribe = subscribeWsEvents(event => {
      if (event.type !== 'typing.updated' || event.payload.channelId !== channel?.id || event.payload.userId === currentUserId) return;
      const { userId } = event.payload;
      clearTimeout(timer);
      setTypingUserId(event.payload.typing ? userId : '');
      if (event.payload.typing) timer = setTimeout(() => setTypingUserId(''), 2500);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [channel?.id, currentUserId, subscribeWsEvents]);

  // Detect active @mention query at the end of draft
  const mentionMatch = useMemo(() => {
    const match = value.match(/(?:^|\s)@([^\s@]*)$/);
    return match ? match[1].toLowerCase() : null;
  }, [value]);

  const mentionCandidates = useMemo(() => {
    if (mentionMatch === null) return [];
    const candidates = buildMentionCandidates({
      participants, currentUserId, channelKind: channel?.kind, dmKey: channel?.dmKey,
      channelMemberIds: new Set(channel?.memberIds), channelMessages: messages, threadMessages,
    });
    return filterMentionCandidates(candidates, mentionMatch);
  }, [mentionMatch, participants, currentUserId, channel, messages, threadMessages]);

  const handlePickMention = (participant: Participant) => {
    void Haptics.selectionAsync();
    const replaced = value.replace(/(^|\s)@([^\s@]*)$/, `$1@${participant.name} `);
    onChangeText(replaced);
  };

  const canSend = !disabled && value.trim().length > 0;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.surface,
          borderTopColor: colors.outline,
        },
      ]}
    >
      {Boolean(typingName) && <Text style={{ color: colors.onSurfaceVariant }}>{typingName} 正在输入…</Text>}
      {/* @Mention Autocomplete Popover */}
      {mentionCandidates.length > 0 && (
        <View
          style={[
            styles.mentionTray,
            {
              backgroundColor: colors.surfaceContainerLow,
              borderColor: colors.outline,
            },
          ]}
        >
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.mentionScroll}
          >
            {mentionCandidates.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => handlePickMention(p)}
                style={[
                  styles.mentionChip,
                  { backgroundColor: colors.surfaceContainer, borderColor: colors.outline },
                ]}
              >
                <BuzzAvatar
                  name={p.name}
                  uri={p.avatarUrl}
                  size={22}
                  isAgent={p.role === 'agent'}
                />
                <Text style={[buzzTypography.label, { color: colors.onSurface }]}>
                  {p.inChannel ? '' : '频道外 · '}@{p.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Editing Banner */}
      {editingLabel && (
        <View
          style={[
            styles.editBanner,
            { backgroundColor: colors.surfaceContainerLow },
          ]}
        >
          <Ionicons name="pencil" size={13} color={colors.onSurfaceVariant} />
          <Text
            style={[buzzTypography.caption, { color: colors.onSurfaceVariant, flex: 1 }]}
            numberOfLines={1}
          >
            {editingLabel}
          </Text>
          <Pressable onPress={onCancelEdit} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={colors.onSurfaceVariant} />
          </Pressable>
        </View>
      )}

      {/* Capsule Input Bar */}
      <View
        style={[
          styles.capsule,
          {
            backgroundColor: colors.surfaceContainerLow,
            borderColor: colors.outline,
          },
        ]}
      >
        {onPickAttachment && !editingLabel && (
          <Pressable
            disabled={disabled || uploading}
            onPress={() => {
              void Haptics.selectionAsync();
              onPickAttachment();
            }}
            style={styles.attachBtn}
            accessibilityLabel="Add image or attachment"
          >
            <Ionicons
              name={uploading ? 'hourglass-outline' : 'add-circle-outline'}
              size={24}
              color={colors.onSurfaceVariant}
            />
          </Pressable>
        )}
        <TextInput testID="message-input"
          value={value}
          onChangeText={text => {
            onChangeText(text);
            if (channel && text && Date.now() - lastTyped.current > 1000) {
              lastTyped.current = Date.now();
              sendTyping(channel.id);
            }
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.onSurfaceVariant}
          multiline
          maxLength={8000}
          style={[buzzTypography.body, styles.input, { color: colors.onSurface }]}
          editable={!disabled}
        />
        <Pressable
          testID="send-message"
          disabled={!canSend}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSend();
          }}
          style={[
            styles.sendBtn,
            {
              backgroundColor: canSend ? accent.fill : colors.surfaceContainerHigh,
            },
          ]}
          accessibilityLabel="Send message"
        >
          <Ionicons
            name={editingLabel ? 'checkmark' : 'arrow-up'}
            size={18}
            color={canSend ? accent.foreground : colors.onSurfaceVariant}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: buzzGrid.twelve,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
  },
  mentionTray: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  mentionScroll: {
    paddingHorizontal: 8,
    gap: 8,
  },
  mentionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: buzzRadii.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: 46,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    paddingTop: 6,
    paddingBottom: 6,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachBtn: {
    width: 30,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
