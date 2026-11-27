import { useState } from 'react';
import { Badge } from '../../design-system/ui/Badge';
import { Button } from '../../design-system/ui/Button';
import { EmptyState } from '../../design-system/ui/EmptyState';
import { IconButton } from '../../design-system/ui/IconButton';
import { Panel } from '../../design-system/ui/Panel';
import { PanelHeader } from '../../design-system/ui/PanelHeader';
import { BellIcon, ChatCircleIcon, HashIcon, XIcon } from '../../design-system/icons/index';
import type { ChatMessage } from '../messages/types';

export interface ActivityItem {
  id: string;
  kind: 'mention' | 'thread' | 'dm';
  channelId: string;
  channelName: string;
  channelKind: 'channel' | 'dm';
  threadId?: string;
  messageId: string;
  senderName: string;
  excerpt: string;
  unreadCount: number;
  createdAt: number;
  message: ChatMessage;
}

type ActivityFilter = 'all' | 'mention' | 'thread';

export function ActivityPanel({
  items,
  loading,
  onRefresh,
  onClose,
  onOpenMessage,
}: {
  items: readonly ActivityItem[];
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onOpenMessage: (message: ChatMessage) => void;
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all');

  const visible = items.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'mention') return item.kind === 'mention';
    return item.kind === 'thread';
  });

  const mentionCount = items.filter((i) => i.kind === 'mention').length;
  const threadCount = items.filter((i) => i.kind === 'thread').length;

  return (
    <Panel
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
      data-activity-panel="true"
    >
      <PanelHeader
        title="Activity & Unreads"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Button variant="quiet" size="xs" onClick={onRefresh} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
            <IconButton
              hint="familiar"
              size="toolbar"
              aria-label="Close activity"
              icon={<XIcon size={16} aria-hidden="true" />}
              onClick={onClose}
            />
          </div>
        }
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-subtle, rgba(128,128,128,0.16))',
        }}
      >
        <Button
          size="xs"
          variant={filter === 'all' ? 'primary' : 'quiet'}
          onClick={() => setFilter('all')}
        >
          All ({items.length})
        </Button>
        <Button
          size="xs"
          variant={filter === 'mention' ? 'primary' : 'quiet'}
          onClick={() => setFilter('mention')}
        >
          @Mentions ({mentionCount})
        </Button>
        <Button
          size="xs"
          variant={filter === 'thread' ? 'primary' : 'quiet'}
          onClick={() => setFilter('thread')}
        >
          Threads ({threadCount})
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loading && items.length === 0 ? (
          <div className="text-caption text-subtle" style={{ padding: 16, textAlign: 'center' }}>
            Loading activity…
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<BellIcon size={24} />}
            title="All caught up"
            description="No unread mentions, thread replies, or direct messages."
          />
        ) : (
          visible.map((item) => (
            <button
              key={item.id}
              type="button"
              data-activity-item={item.kind}
              data-activity-channel-id={item.channelId}
              data-activity-message-id={item.messageId}
              onClick={() => onOpenMessage(item.message)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 4,
                padding: '10px 12px',
                borderRadius: 'var(--radius-md, 10px)',
                border: '1px solid var(--border-subtle, rgba(128,128,128,0.16))',
                background: 'var(--surface-raised, transparent)',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span
                  className="text-caption"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontWeight: 600,
                    color: 'var(--text-standard)',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.channelKind === 'dm' ? (
                    <ChatCircleIcon size={13} aria-hidden="true" />
                  ) : (
                    <HashIcon size={13} aria-hidden="true" />
                  )}
                  {item.channelName}
                </span>
                {item.kind === 'mention' ? (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: 'var(--accent-standard, #e5484d)',
                      color: '#fff',
                      flexShrink: 0,
                    }}
                  >
                    @mention
                  </span>
                ) : item.kind === 'thread' ? (
                  <Badge>{item.unreadCount} new</Badge>
                ) : (
                  <Badge>DM</Badge>
                )}
              </div>
              <div className="text-caption text-subtle" style={{ fontWeight: 500 }}>
                {item.senderName}
              </div>
              <div
                className="text-caption"
                style={{
                  color: 'var(--text-secondary, var(--text-subtle))',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {item.excerpt}
              </div>
            </button>
          ))
        )}
      </div>
    </Panel>
  );
}
