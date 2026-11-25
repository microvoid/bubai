import { useState, type Ref } from "react";
import { PinIcon, PinOffIcon, XIcon } from "../../design-system/icons";
import { Button } from "../../design-system/ui/Button";
import { EmptyState } from "../../design-system/ui/EmptyState";
import { IconButton } from "../../design-system/ui/IconButton";
import { PanelHeader } from "../../design-system/ui/PanelHeader";
import { MessageTimestamp } from "../messages/MessageTimestamp";
import type { ChatMessage, Participant } from "../messages/types";
import styles from "./ChannelPins.module.css";

export function ChannelPinsButton({
  open,
  onToggle,
  ref,
}: {
  open: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <IconButton
      ref={ref}
      size="toolbar"
      icon={<PinIcon size={16} aria-hidden="true" />}
      aria-label="Pinned messages"
      title="Pinned messages"
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus();
        onToggle();
      }}
    />
  );
}

interface ChannelPinsPanelProps {
  pins: readonly ChatMessage[];
  participants: readonly Participant[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  onOpenMessage: (message: ChatMessage) => void;
  onUnpin: (message: ChatMessage) => Promise<void>;
  channelKind?: "channel" | "dm";
  canUnpin?: boolean;
}

function PinnedList({
  pins,
  participants,
  onClose,
  onOpenMessage,
  onUnpin,
  channelKind,
  canUnpin,
}: Omit<ChannelPinsPanelProps, "loading" | "error" | "onRetry">) {
  const names = new Map(participants.map(({ id, name }) => [id, name]));
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();

  async function unpin(message: ChatMessage) {
    setError(undefined);
    setPending((previous) => new Set(previous).add(message.id));
    try {
      await onUnpin(message);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not unpin. Try again.",
      );
    } finally {
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(message.id);
        return next;
      });
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className={styles.status}>
          {error}
        </p>
      )}
      <ul className={styles.list} aria-label="Pinned messages">
        {pins.map((message) => {
          const name = names.get(message.senderId) ?? message.senderId;
          const preview =
            message.content.trim() ||
            message.card?.title ||
            (message.attachments?.length ? "Attachment" : "");
          return (
            <li key={message.id} className={styles.row}>
              <button
                type="button"
                className={styles.open}
                onClick={() => {
                  onClose();
                  onOpenMessage(message);
                }}
              >
                <span className={styles.byline}>
                  <strong>{name}</strong>
                  <MessageTimestamp createdAt={message.createdAt} />
                </span>
                <span className={styles.preview}>{preview}</span>
              </button>
              {canUnpin && (
                <IconButton
                  size="sm"
                  aria-label={`Unpin message from ${name}`}
                  title={
                    channelKind === "dm"
                      ? "Unpin from DM"
                      : "Unpin from channel"
                  }
                  icon={<PinOffIcon size={14} aria-hidden="true" />}
                  loading={pending.has(message.id)}
                  onClick={() => void unpin(message)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ChannelPinsPanel({
  loading,
  error,
  onRetry,
  canUnpin = true,
  ...props
}: ChannelPinsPanelProps) {
  const { pins, onClose } = props;

  return (
    <aside
      className={styles.panel}
      data-buzz-surface=""
      aria-label="Pinned panel"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.shiftKey) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <PanelHeader
        title="Pinned"
        actions={
          <IconButton
            size="toolbar"
            aria-label="Close pinned messages"
            title="Close pinned messages"
            onClick={onClose}
            icon={<XIcon size={18} aria-hidden="true" />}
          />
        }
      />
      <div className={styles.body}>
        {error ? (
          <EmptyState
            icon={<PinIcon />}
            title="Couldn’t load pinned messages"
            action={<Button onClick={onRetry}>Try again</Button>}
          />
        ) : null}
        {pins.length > 0 ? (
          <PinnedList {...props} canUnpin={canUnpin} />
        ) : loading ? (
          <p role="status" className={styles.status}>
            Loading pinned messages…
          </p>
        ) : !error ? (
          <EmptyState
            icon={<PinIcon />}
            title="No pinned messages"
            description={
              canUnpin
                ? "Pin a message from its message actions to keep it here."
                : undefined
            }
          />
        ) : null}
      </div>
    </aside>
  );
}
