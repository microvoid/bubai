import type { ChatMessage } from '@buzz-botmux/chat-client';
import type { LocalMessage } from './localTimeline';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, type FlatList } from 'react-native';
import { pickAttachments, removeStaged } from '../services/pickAttachments';
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
  const [draft, setDraft, draftKey] = useDraft(
    serverUrl,
    activeOrgId,
    currentUserId,
    channelId,
    ...(threadId ? [threadId] : []),
  );
  const [edit, setEdit] = useState<{
    message: ChatMessage;
    text: string;
    draftKey: string;
  } | null>(null);
  const activeEdit = edit?.draftKey === draftKey ? edit : null;
  const [uploading, setUploading] = useState(false);
  const picking = useRef(false);
  const inFlight = useRef(new Set<string>());
  async function deliver(
    content: string,
    attachments?: ChatMessage['attachments'],
    retryId?: string,
    stagedAttachments?: LocalMessage['stagedAttachments'],
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
      stagedAttachments,
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
        stagedAttachments,
      });
      update((rows) =>
        rows.map((r) =>
          r.id === id && r.delivery === 'sending'
            ? { ...r, delivery: state === 'sent' ? undefined : state }
            : r,
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === '已取消发送' && !retryId) {
        update((rows) => rows.filter((r) => r.id !== id));
        await removeStaged(stagedAttachments);
      } else
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
      await deliver(message.content, message.attachments, message.id, message.stagedAttachments);
      setDraft((current) => (current === message.content ? '' : current));
    } catch (error) {
      Alert.alert(
        '发送失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function send() {
    const content = (activeEdit?.text ?? draft).trim();
    if (!content || !client || sending.current) return;
    sending.current = true;
    try {
      if (activeEdit) {
        const { message } = await client.editMessage(activeEdit.message.id, content);
        patch(message.id, message);
        setEdit(current => current === activeEdit ? null : current);
      } else {
        const failed = snapshot().find(
          (row) =>
            row.delivery === 'failed' &&
            !row.attachments?.length &&
            !row.stagedAttachments?.length &&
            row.content === content,
        );
        await deliver(content, undefined, failed?.id);
        setDraft((current) => (current.trim() === content ? '' : current));
      }
    } catch (error) {
      Alert.alert(
        activeEdit ? '编辑失败' : '发送失败',
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
      const attachments = await pickAttachments();
      if (!attachments.length) return;
      await deliver(draft.trim(), undefined, undefined, attachments);
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
    setEdit({ message, text: message.content, draftKey });
  }
  function cancelEdit() {
    setEdit(null);
  }
  return {
    draft: activeEdit?.text ?? draft,
    setDraft: (text: string) => {
      if (activeEdit) setEdit({ ...activeEdit, text });
      else setDraft(text);
    },
    editing: activeEdit?.message ?? null,
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
  const targetIndex = messageId ? items.findIndex(item => item.id === messageId) : -1;
  const jumped = useRef<string | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempts = useRef(0);
  const jump = useCallback(() => {
    if (!messageId || !ref.current || targetIndex < 0 || jumped.current === messageId) return;
    jumped.current = messageId;
    ref.current.scrollToIndex({ index: targetIndex, animated: false, viewPosition: 0.5 });
  }, [messageId, targetIndex]);

  useEffect(() => {
    jumped.current = null;
    attempts.current = 0;
  }, [messageId]);
  useEffect(() => {
    jump();
    return () => clearTimeout(retry.current);
  }, [jump]);

  return {
    ref,
    onContentSizeChange: jump,
    onScrollToIndexFailed(info: { averageItemLength: number; index: number }) {
      // Virtualized lists need to lay out distant, variable-height bubbles before
      // they can position the target precisely. First move near its estimated offset.
      ref.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
      if (attempts.current >= 5) return;
      attempts.current++;
      jumped.current = null;
      clearTimeout(retry.current);
      retry.current = setTimeout(jump, 100);
    },
  };
}
