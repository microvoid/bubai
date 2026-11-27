import type { ChatMessage } from '@buzz-botmux/chat-client';
import { useRef, useState } from 'react';
import { Alert, type FlatList } from 'react-native';
import { pickAttachments } from '../services/pickAttachments';
import { useBubai } from './BubaiProvider';
import { useDraft } from './useDraft';

export function useMessageActions(
  channelId: string,
  threadId: string | null,
  patch: (id: string, changes: Partial<ChatMessage>) => void,
) {
  const { client, serverUrl, activeOrgId, currentUserId, sendWsMessage } = useBubai();
  const [draft, setDraft] = useDraft(
    serverUrl,
    activeOrgId,
    currentUserId,
    channelId,
    ...(threadId ? [threadId] : []),
  );
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [uploading, setUploading] = useState(false);
  const picking = useRef(false);
  async function send() {
    const content = draft.trim();
    if (!content || !client) return;
    try {
      if (editing) {
        const { message } = await client.editMessage(editing.id, content);
        patch(message.id, message);
        setEditing(null);
      } else {
        await sendWsMessage({ channelId, threadId: threadId ?? undefined, content });
      }
      setDraft((current) => (current.trim() === content ? '' : current));
    } catch (error) {
      Alert.alert(editing ? '编辑失败' : '发送失败', error instanceof Error ? error.message : String(error));
    }
  }
  async function attach() {
    if (!client || picking.current) return;
    picking.current = true;
    setUploading(true);
    try {
      const attachments = await pickAttachments(client);
      if (!attachments.length) return;
      await sendWsMessage({
        channelId,
        threadId: threadId ?? undefined,
        content: draft.trim(),
        attachments,
      });
      setDraft((current) => (current === draft ? '' : current));
    } catch (error) {
      Alert.alert('附件发送失败', error instanceof Error ? error.message : String(error));
    } finally {
      picking.current = false;
      setUploading(false);
    }
  }
  async function react(id: string, emoji: string) {
    if (!client) return;
    try {
      const result = await client.toggleReaction(id, emoji, currentUserId);
      patch(result.messageId || id, { reactions: result.reactions ?? [] });
    } catch (error) {
      Alert.alert('表情操作失败', error instanceof Error ? error.message : String(error));
    }
  }
  function startEdit(message: ChatMessage) {
    setEditing(message);
    setDraft(message.content);
  }
  function cancelEdit() {
    setEditing(null);
    setDraft('');
  }
  return { draft, setDraft, editing, startEdit, cancelEdit, uploading, send, attach, react };
}

export function useMessageScroll(items: ChatMessage[], messageId?: string) {
  const ref = useRef<FlatList<ChatMessage>>(null);
  const jumped = useRef<string | null>(null);
  return {
    ref,
    onScrollToIndexFailed(info: { averageItemLength: number; index: number }) {
      ref.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    },
    onContentSizeChange() {
      if (!messageId || !ref.current || jumped.current === messageId) return;
      const index = items.findIndex((item) => item.id === messageId);
      if (index < 0) return;
      jumped.current = messageId;
      ref.current.scrollToIndex({ index, animated: false });
    },
  };
}
