import type { ChatMessage } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React from 'react';
import {
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBuzzTheme } from '../theme/ThemeProvider';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🔥', '👀', '🎉'];

interface MessageActionSheetProps {
  message: ChatMessage | null;
  isOwn: boolean;
  inThread?: boolean;
  onClose: () => void;
  onReact: (messageId: string, emoji: string) => void;
  onReplyThread?: (message: ChatMessage) => void;
  onTogglePin?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  onDelete?: (message: ChatMessage) => void;
}

export function MessageActionSheet({
  message,
  isOwn,
  inThread = false,
  onClose,
  onReact,
  onReplyThread,
  onTogglePin,
  onEdit,
  onDelete,
}: MessageActionSheetProps) {
  const { colors } = useBuzzTheme();
  const insets = useSafeAreaInsets();
  if (!message) return null;

  const actions: Array<{
    key: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    destructive?: boolean;
    onPress: () => void;
  }> = [];

  if (!inThread && onReplyThread) {
    actions.push({
      key: 'thread',
      label: 'Reply in thread',
      icon: 'chatbubble-outline',
      onPress: () => {
        onClose();
        onReplyThread(message);
      },
    });
  }

  if (!inThread && onTogglePin) {
    actions.push({
      key: 'pin',
      label: message.pinned ? 'Unpin message' : 'Pin message',
      icon: message.pinned ? 'pin-outline' : 'pin',
      onPress: () => {
        onClose();
        onTogglePin(message);
      },
    });
  }

  actions.push({
    key: 'share',
    label: 'Share / Copy text',
    icon: 'copy-outline',
    onPress: () => {
      onClose();
      void Share.share({ message: message.content });
    },
  });

  if (isOwn && onEdit) {
    actions.push({
      key: 'edit',
      label: 'Edit message',
      icon: 'pencil-outline',
      onPress: () => {
        onClose();
        onEdit(message);
      },
    });
  }

  if (isOwn && onDelete) {
    actions.push({
      key: 'delete',
      label: 'Delete message',
      icon: 'trash-outline',
      destructive: true,
      onPress: () => {
        onClose();
        onDelete(message);
      },
    });
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: colors.scrim }]}>
        <Pressable accessibilityLabel="关闭消息操作" style={StyleSheet.absoluteFill} onPress={onClose} />
        <View accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.outline,
              paddingBottom: Math.max(insets.bottom, 16) + 10,
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: colors.outlineVariant }]} />

          {/* Quick Emoji Reactions */}
          <View style={[styles.emojiBar, { backgroundColor: colors.surfaceContainerLow }]}>
            {QUICK_EMOJIS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onReact(message.id, emoji);
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.emojiBtn,
                  { opacity: pressed ? 0.65 : 1 },
                ]}
              >
                <Text style={{ fontSize: 22 }}>{emoji}</Text>
              </Pressable>
            ))}
          </View>

          {/* Action Rows */}
          <View
            style={[
              styles.actionsCard,
              { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline },
            ]}
          >
            {actions.map((act, idx) => (
              <Pressable
                testID={'message-action-' + act.key}
                accessibilityRole="button"
                accessibilityLabel={act.label}
                key={act.key}
                onPress={() => {
                  void Haptics.selectionAsync();
                  act.onPress();
                }}
                style={({ pressed }) => [
                  styles.actionRow,
                  idx > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.outline,
                  },
                  { opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Ionicons
                  name={act.icon}
                  size={18}
                  color={act.destructive ? colors.error : colors.onSurface}
                />
                <Text
                  style={[
                    buzzTypography.titleSmall,
                    { color: act.destructive ? colors.error : colors.onSurface },
                  ]}
                >
                  {act.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: buzzRadii.sheet,
    borderTopRightRadius: buzzRadii.sheet,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: buzzGrid.gutter,
    paddingTop: 10,
    paddingBottom: 34,
    gap: 14,
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 4,
  },
  emojiBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 10,
    borderRadius: buzzRadii.card,
  },
  emojiBtn: {
    padding: 6,
  },
  actionsCard: {
    borderRadius: buzzRadii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
