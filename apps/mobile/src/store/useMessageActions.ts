import type { ChatMessage } from '@buzz-botmux/chat-client';
import type { LocalMessage } from './localTimeline';
import { useRef, useState } from 'react';
import { Alert, type FlatList } from 'react-native';
import { pickAttachments } from '../services/pickAttachments';
import { useBubai } from './BubaiProvider';
import { useDraft } from './useDraft';

export function useMessageActions(
  channelId: string,
  threadId: string | null,
  update: (fn: (rows: LocalMessage[]) => LocalMessage[]) => void,
  snapshot: () => LocalMessage[],
  patch: (id: string, changes: Partial<ChatMessage>) => void,
) {
  const { client, serverUrl, activeOrgId, currentUserId, sendWsMessage } =
    useBubai();
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
  const inFlight = useRef(new Set<string>());
  async function deliver(
    content: string,
    attachments?: ChatMessage['attachments'],
    retryId?: string,
  ) {
    const id = retryId ?? globalThis.expo.uuidv4();
    if (inFlight.current.has(id)) throw new Error('消息正在发送');
    inFlight.current.add(id);
    const local: LocalMessage = {
      id,
      channelId,
      threadId: threadId ?? undefined,
      content,
      attachments,
      senderRole: 'human',
      senderId: currentUserId,
      createdAt: Date.now(),
      delivery: 'sending',
    };
    update((rows) =>
      rows.some((r) => r.id === id)
        ? rows.map((r) => (r.id === id ? { ...r, delivery: 'sending' } : r))
        : [...rows, local],
    );
    try {
      const state = await sendWsMessage({
        messageId: id,
        channelId,
        threadId: threadId ?? undefined,
        content,
        attachments,
      });
      update((rows) =>
        rows.map((r) =>
          r.id === id && r.delivery
            ? { ...r, delivery: state === 'queued' ? 'queued' : undefined }
            : r,
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === '已取消发送')
        update((rows) => rows.filter((r) => r.id !== id));
      else
        update((rows) =>
          rows.map((r) =>
            r.id === id && r.delivery ? { ...r, delivery: 'failed' } : r,
          ),
        );
      throw error;
    } finally {
      inFlight.current.delete(id);
    }
  }
  const sending = useRef(false);
  async function retry(message: LocalMessage) {
    try {
      await deliver(message.content, message.attachments, message.id);
      setDraft((current) => (current === message.content ? '' : current));
    } catch (error) {
      Alert.alert(
        '发送失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function send() {
    const content = draft.trim();
    if (!content || !client || sending.current) return;
    sending.current = true;
    try {
      if (editing) {
        const { message } = await client.editMessage(editing.id, content);
        patch(message.id, message);
        setEditing(null);
      } else {
        const failed = snapshot().find(
          (row) =>
            row.delivery === 'failed' &&
            !row.attachments?.length &&
            row.content === content,
        );
        await deliver(content, undefined, failed?.id);
      }
      setDraft((current) => (current.trim() === content ? '' : current));
    } catch (error) {
      Alert.alert(
        editing ? '编辑失败' : '发送失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      sending.current = false;
    }
  }
  async function attach() {
    if (!client || picking.current) return;
    picking.current = true;
    setUploading(true);
    try {
      const attachments = await pickAttachments(client);
      if (!attachments.length) return;
      await deliver(draft.trim(), attachments);
      setDraft((current) => (current === draft ? '' : current));
    } catch (error) {
      Alert.alert(
        '附件发送失败',
        error instanceof Error ? error.message : String(error),
      );
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
      Alert.alert(
        '表情操作失败',
        error instanceof Error ? error.message : String(error),
      );
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
  return {
    draft,
    setDraft,
    editing,
    startEdit,
    cancelEdit,
    uploading,
    send,
    attach,
    react,
    retry,
  };
}

export function useMessageScroll(items: ChatMessage[], messageId?: string) {
  const ref = useRef<FlatList<ChatMessage>>(null);
  const jumped = useRef<string | null>(null);
  return {
    ref,
    onScrollToIndexFailed(info: { averageItemLength: number; index: number }) {
      ref.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: false,
      });
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
