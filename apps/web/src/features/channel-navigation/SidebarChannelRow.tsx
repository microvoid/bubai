/**
 * Buzz-aligned sidebar channel / DM row with hover menu + right-click context menu.
 * Ported from references/buzz-app/src/bundled/channels/ChannelInventory.tsx (lines 1230-1450):
 * - Move to submenu (Starred, custom groups, default home, Create new…, Remove from section)
 * - Mute / Unmute
 * - Mark as read / Mark as unread
 * - Copy link
 * - Channel lifecycle: Archive / Unarchive, Leave (non-creator), Delete (creator)
 * - DM lifecycle: Close conversation (hides from sidebar, preserves chat history)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CountBadge } from '../../design-system/ui/CountBadge';
import { IconButton } from '../../design-system/ui/IconButton';
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from '../../design-system/ui/Menu';
import { NavigationItem } from '../../design-system/ui/NavigationItem';
import {
  ArchiveIcon,
  ArchiveOffIcon,
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  ChatUnreadIcon,
  CheckIcon,
  ChecksIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  GearIcon,
  HashIcon,
  LinkIcon,
  MinusIcon,
  PlusIcon,
  SignOutIcon,
  SparklesIcon,
  TrashIcon,
  XIcon,
} from '../../design-system/icons/index';
import styles from './SidebarChannelRow.module.css';

export interface SidebarGroup {
  id: string;
  name: string;
}

export interface SidebarChannelItem {
  id: string;
  name: string;
  topic: string;
  kind?: 'channel' | 'dm';
  archived?: boolean;
  createdByUserId?: string;
  unreadCount: number;
  threadUnreadCount?: number;
  mentionCount?: number;
  muted?: boolean;
  markedUnread?: boolean;
  starred?: boolean;
  groupId?: string;
}

export function SidebarChannelRow({
  channel,
  selected,
  currentUserId,
  sidebarGroups,
  sectionTitle,
  icon,
  isWorking = false,
  onOpen,
  onToggleMute,
  onMarkRead,
  onMarkUnread,
  onCopyLink,
  onSetPlacement,
  onRequestCreateGroup,
  onOpenSettings,
  onRequestArchive,
  onRequestUnarchive,
  onRequestLeave,
  onRequestDelete,
  onCloseDm,
}: {
  channel: SidebarChannelItem;
  selected: boolean;
  currentUserId: string;
  sidebarGroups: readonly SidebarGroup[];
  sectionTitle: string;
  icon?: ReactNode;
  isWorking?: boolean;
  onOpen: () => void;
  onToggleMute: (muted: boolean) => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onCopyLink: () => void;
  onSetPlacement: (placement: { starred?: boolean; groupId?: string | null }) => void;
  onRequestCreateGroup: () => void;
  onOpenSettings?: () => void;
  onRequestArchive: () => void;
  onRequestUnarchive: () => void;
  onRequestLeave: () => void;
  onRequestDelete: () => void;
  onCloseDm: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopyLinkClick = () => {
    onCopyLink();
    setCopiedLink(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopiedLink(false);
      setMenuOpen(false);
      setContextOpen(false);
    }, 700);
  };

  const isDm = channel.kind === 'dm';
  const isArchived = Boolean(channel.archived);
  const isMuted = Boolean(channel.muted);
  const isStarred = Boolean(channel.starred);
  const channelUnread = channel.unreadCount || 0;
  const threadUnread = channel.threadUnreadCount || 0;
  const mentionCount = channel.mentionCount || 0;
  const hasChannelUnread = channelUnread > 0 || Boolean(channel.markedUnread);
  const hasUnread = hasChannelUnread || threadUnread > 0 || mentionCount > 0;
  const showUnreadStyle = !isMuted && hasUnread && !selected;
  const canManage = !isDm && (!channel.createdByUserId || channel.createdByUserId === currentUserId);
  const label = isDm ? channel.topic || channel.name : channel.name;
  const homeKey = isDm ? 'dm' : 'channels';
  const homeLabel = isDm ? 'Direct Messages' : 'Channels';
  const currentPlacementValue = isStarred
    ? 'starred'
    : channel.groupId
      ? `group:${channel.groupId}`
      : homeKey;

  const renderMenuItems = () => (
    <>
      {!isArchived && (
        <MenuSubmenu>
          <MenuSubmenuTrigger>
            <MenuIcon>
              <FolderSimpleIcon size={14} />
            </MenuIcon>
            Move to
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup size="compact">
            <MenuGroup>
              <MenuGroupLabel>Sections</MenuGroupLabel>
            </MenuGroup>
            <MenuRadioGroup
              value={currentPlacementValue}
              onValueChange={(destination) => {
                if (destination === 'starred') {
                  onSetPlacement({ starred: !isStarred });
                } else if (destination.startsWith('group:')) {
                  const targetGroupId = destination.slice('group:'.length);
                  onSetPlacement({
                    starred: false,
                    groupId: targetGroupId === channel.groupId ? null : targetGroupId,
                  });
                } else {
                  onSetPlacement({ starred: false, groupId: null });
                }
              }}
            >
              <MenuRadioItem value="starred" closeOnClick={false}>
                <MenuIcon>★</MenuIcon>
                Starred
              </MenuRadioItem>
              {sidebarGroups.map((group) => (
                <MenuRadioItem
                  key={group.id}
                  value={`group:${group.id}`}
                  closeOnClick={false}
                >
                  <MenuIcon>
                    <FolderSimpleIcon size={14} />
                  </MenuIcon>
                  {group.name}
                </MenuRadioItem>
              ))}
              <MenuRadioItem value={homeKey} closeOnClick={false}>
                <MenuIcon>
                  <ChatCircleIcon size={14} />
                </MenuIcon>
                {homeLabel}
              </MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                setContextOpen(false);
                onRequestCreateGroup();
              }}
            >
              <MenuIcon>
                <PlusIcon size={14} />
              </MenuIcon>
              Create new…
            </MenuItem>
            {(isStarred || channel.groupId) && (
              <MenuItem
                onClick={() =>
                  onSetPlacement(isStarred ? { starred: false } : { groupId: null })
                }
              >
                <MenuIcon>
                  <MinusIcon size={14} />
                </MenuIcon>
                Remove from {sectionTitle}
              </MenuItem>
            )}
          </MenuSubmenuPopup>
        </MenuSubmenu>
      )}

      <MenuItem onClick={() => onToggleMute(!isMuted)}>
        <MenuIcon>
          {isMuted ? <BellIcon size={14} /> : <BellSlashIcon size={14} />}
        </MenuIcon>
        {isMuted ? 'Unmute' : 'Mute'}
      </MenuItem>

      {hasUnread ? (
        <MenuItem onClick={onMarkRead}>
          <MenuIcon>
            <ChecksIcon size={14} />
          </MenuIcon>
          Mark as read
        </MenuItem>
      ) : (
        <MenuItem onClick={onMarkUnread}>
          <MenuIcon>
            <ChatUnreadIcon size={14} />
          </MenuIcon>
          Mark as unread
        </MenuItem>
      )}

      <MenuItem closeOnClick={false} onClick={handleCopyLinkClick}>
        <MenuIcon>
          {copiedLink ? <CheckIcon size={14} /> : <LinkIcon size={14} />}
        </MenuIcon>
        {copiedLink ? 'Copied link' : 'Copy link'}
      </MenuItem>

      {!isDm && canManage && onOpenSettings && (
        <MenuItem
          onClick={() => {
            setMenuOpen(false);
            setContextOpen(false);
            onOpenSettings();
          }}
        >
          <MenuIcon>
            <GearIcon size={14} />
          </MenuIcon>
          Channel settings…
        </MenuItem>
      )}

      <MenuSeparator />

      {isDm ? (
        <MenuItem onClick={onCloseDm}>
          <MenuIcon>
            <XIcon size={14} />
          </MenuIcon>
          Close conversation
        </MenuItem>
      ) : isArchived ? (
        canManage ? (
          <MenuItem onClick={onRequestUnarchive}>
            <MenuIcon>
              <ArchiveOffIcon size={14} />
            </MenuIcon>
            Unarchive channel
          </MenuItem>
        ) : null
      ) : (
        <>
          {canManage ? (
            <>
              <MenuItem onClick={onRequestArchive}>
                <MenuIcon>
                  <ArchiveIcon size={14} />
                </MenuIcon>
                Archive channel
              </MenuItem>
              <MenuItem tone="danger" onClick={onRequestDelete}>
                <MenuIcon>
                  <TrashIcon size={14} />
                </MenuIcon>
                Delete channel
              </MenuItem>
            </>
          ) : (
            <MenuItem tone="danger" onClick={onRequestLeave}>
              <MenuIcon>
                <SignOutIcon size={14} />
              </MenuIcon>
              Leave channel
            </MenuItem>
          )}
        </>
      )}
    </>
  );

  const workingIndicator = isWorking ? (
    <span
      className={styles.mutedGlyph}
      title="Agent working…"
      data-working-indicator="true"
      style={{ color: 'var(--accent-standard, var(--text-accent, #f59e0b))' }}
    >
      <SparklesIcon size={13} aria-hidden="true" />
    </span>
  ) : null;

  const unreadBadge = isMuted ? (
    <span className={styles.mutedGlyph} title="Muted">
      <BellSlashIcon size={13} aria-hidden="true" />
    </span>
  ) : hasChannelUnread && !selected ? (
    <CountBadge
      count={Math.max(1, channelUnread)}
      label={`${Math.max(1, channelUnread)} unread messages`}
    />
  ) : threadUnread > 0 ? (
    <span
      data-thread-unread-badge="true"
      title={`${threadUnread} unread thread ${threadUnread === 1 ? 'reply' : 'replies'}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
      }}
    >
      <CountBadge
        count={threadUnread}
        label={`${threadUnread} unread thread replies`}
      />
    </span>
  ) : null;

  const mentionBadge =
    !isMuted && !selected && mentionCount > 0 ? (
      <span
        data-mention-badge="true"
        aria-label={`${mentionCount} unread mentions`}
        title={`${mentionCount} unread @mentions`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 20,
          height: 18,
          padding: '0 5px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1,
          background: 'var(--accent-standard, #e5484d)',
          color: '#fff',
        }}
      >
        @{mentionCount}
      </span>
    ) : null;

  const trailing =
    workingIndicator || mentionBadge || unreadBadge ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {workingIndicator}
        {mentionBadge}
        {unreadBadge}
      </span>
    ) : undefined;

  return (
    <ContextMenuRoot open={contextOpen} onOpenChange={setContextOpen}>
      <ContextMenuTrigger
        render={
          <div
            className={styles.row}
            data-channel-id={channel.id}
            data-unread={showUnreadStyle || undefined}
            data-muted={isMuted || undefined}
            data-archived={isArchived || undefined}
            data-menu-open={menuOpen || contextOpen || undefined}
          >
            <NavigationItem
              label={label}
              icon={icon ?? (isDm ? undefined : <HashIcon size={16} />)}
              selected={selected}
              unread={showUnreadStyle}
              trailing={trailing}
              onClick={onOpen}
            />
            <div className={styles.menuTrigger}>
              <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
                <MenuTrigger
                  render={
                    <IconButton
                      hint="familiar"
                      size="xs"
                      variant="ghost"
                      aria-label={`More actions for ${label}`}
                      title="More actions"
                      icon={<DotsThreeIcon size={15} aria-hidden="true" />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  }
                />
                <MenuPopup side="right" align="start" size="compact">
                  {renderMenuItems()}
                </MenuPopup>
              </MenuRoot>
            </div>
          </div>
        }
      />
      <MenuPopup size="compact">{renderMenuItems()}</MenuPopup>
    </ContextMenuRoot>
  );
}
