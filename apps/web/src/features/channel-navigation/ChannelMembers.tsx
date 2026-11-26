import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import {
  CircleNotchIcon,
  DotsThreeIcon,
  Filter2Icon,
  TrashIcon,
  UsersIcon,
} from "../../design-system/icons";
import { Avatar } from "../../design-system/ui/Avatar";
import { AvatarStack } from "../../design-system/ui/AvatarStack";
import { Button } from "../../design-system/ui/Button";
import { Dialog } from "../../design-system/ui/Dialog";
import { EmptyState } from "../../design-system/ui/EmptyState";
import { IconButton } from "../../design-system/ui/IconButton";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../design-system/ui/Menu";
import { SearchField } from "../../design-system/ui/SearchField";
import { SurfaceButton } from "../../design-system/ui/SurfaceButton";
import { Switch } from "../../design-system/ui/Switch";
import type { Participant } from "../messages/types";
import styles from "./ChannelMembers.module.css";

export interface ChannelMember {
  id: string;
  channelId: string;
  userId: string | null;
  agentId: string | null;
  autoReply: boolean;
  role?: "owner" | "admin" | "member" | "guest";
}

export function ChannelHeaderIdentity({
  name,
  topic,
  members,
  participants,
  open,
  onOpen,
  canManage = true,
  ref,
}: {
  name: string;
  topic?: string;
  members: readonly ChannelMember[];
  participants: readonly Participant[];
  open: boolean;
  onOpen: () => void;
  canManage?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const profiles = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const people = members.flatMap((member) => {
    if (!member.userId) return [];
    const profile = profiles.get(member.userId);
    return [
      {
        id: member.userId,
        name: profile?.name ?? "Member",
        src: profile?.avatarUrl,
        shape: "circle" as const,
      },
    ];
  });
  people.sort((a, b) => Number(Boolean(b.src)) - Number(Boolean(a.src)));

  return (
    <SurfaceButton
      ref={ref}
      className={styles.identity}
      aria-label={
        canManage ? `Manage members of ${name}` : `Channel access for ${name}`
      }
      title={canManage ? "Manage members" : "Channel access"}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <span className={styles.avatars} aria-hidden="true">
        {people.length > 0 ? (
          <AvatarStack size="small" max={3} items={people} />
        ) : (
          <Avatar
            size="small"
            alt=""
            fallback="Members"
            fallbackContent={<UsersIcon size={16} aria-hidden="true" />}
          />
        )}
      </span>
      <span className={styles.label}>
        <span className={`${styles.name} text-body-sm`}>{name}</span>
        {topic && (
          <span className={`${styles.topic} text-caption`} title={topic} data-channel-topic="">
            {topic}
          </span>
        )}
      </span>
    </SurfaceButton>
  );
}

type RosterKind = "People" | "Agents";
type RosterFilter = "All" | RosterKind;
type MemberAction = { kind: "add" | "remove" | "autoReply"; id: string };
type MemberEntry = {
  member: ChannelMember;
  name: string;
  identityId: string;
  avatarUrl: string | undefined;
  agent: boolean;
  role: NonNullable<ChannelMember["role"]>;
};

const groups = ["People", "Agents"] as const;
const roleLabels = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

interface ChannelMembersDialogProps {
  open: boolean;
  channelName: string;
  currentUserId: string;
  ownerId?: string;
  members: readonly ChannelMember[];
  participants: readonly Participant[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenChange: (open: boolean) => void;
  onAdd: (participant: Participant) => Promise<void>;
  onRemove: (member: ChannelMember) => Promise<void>;
  onToggleAutoReply?: (agentId: string, enabled: boolean) => Promise<void>;
  onOpenAgentProfile?: (agentId: string) => void;
  canManage?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

export function ChannelMembersDialog({
  open,
  channelName,
  currentUserId,
  ownerId,
  members,
  participants,
  loading,
  error,
  onRetry,
  onOpenChange,
  onAdd,
  onRemove,
  onToggleAutoReply,
  onOpenAgentProfile,
  canManage = true,
  triggerRef,
}: ChannelMembersDialogProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RosterFilter>("All");
  const [highlight, setHighlight] = useState(-1);
  const [pending, setPending] = useState<MemberAction | null>(null);
  const inFlight = useRef(false);
  const [removing, setRemoving] = useState<MemberEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const input = useRef<HTMLElement>(null);
  const memberList = useRef<HTMLDivElement>(null);
  const cancelRemoval = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFilter("All");
      setHighlight(-1);
      setRemoving(null);
      setActionError(null);
    }
  }, [open]);

  useEffect(() => {
    if (removing) cancelRemoval.current?.focus();
  }, [removing]);

  const profiles = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const roster: MemberEntry[] = members.flatMap((member) => {
    const identityId = member.userId ?? member.agentId;
    if (!identityId) return [];
    const participant = profiles.get(identityId);
    return [
      {
        member,
        identityId,
        avatarUrl: participant?.avatarUrl,
        agent: Boolean(member.agentId),
        name:
          participant?.name ??
          (member.agentId ? "Unknown agent" : "Unknown member"),
        role:
          member.role ??
          (member.userId && member.userId === ownerId ? "owner" : "member"),
      },
    ];
  });
  const memberIds = new Set(roster.map((entry) => entry.identityId));
  const needle = query.trim().toLocaleLowerCase();
  const matchingMembers = roster.filter((entry) =>
    `${entry.name} ${entry.identityId}`.toLocaleLowerCase().includes(needle),
  );
  const visible = matchingMembers.filter(
    (entry) => filter === "All" || (filter === "Agents") === entry.agent,
  );
  const additions =
    canManage && needle && !loading && !error
      ? participants.filter(
          (participant) =>
            !memberIds.has(participant.id) &&
            !participant.archived &&
            `${participant.name} ${participant.id}`
              .toLocaleLowerCase()
              .includes(needle),
        )
      : [];
  const activeAddition = additions[highlight];
  const filterAvailable = groups.every((group) =>
    roster.some((entry) => entry.agent === (group === "Agents")),
  );
  const rosterReady = !loading && !error;
  const canChange = canManage && rosterReady;

  async function runAction(action: MemberAction, work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(action);
    setActionError(null);
    try {
      await work();
      if (action.kind === "remove") setRemoving(null);
      if (action.kind === "add") setHighlight(-1);
      if (action.kind !== "autoReply")
        requestAnimationFrame(() => input.current?.focus());
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "The membership update failed.",
      );
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function searchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (!additions.length || pending) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((index) => {
        if (index < 0) return direction > 0 ? 0 : additions.length - 1;
        return (index + direction + additions.length) % additions.length;
      });
    } else if (
      event.key === "Enter" &&
      (activeAddition || additions.length === 1)
    ) {
      event.preventDefault();
      const participant = activeAddition ?? additions[0];
      if (participant)
        void runAction({ kind: "add", id: participant.id }, () =>
          onAdd(participant),
        );
    }
  }

  function cancelRemove() {
    setRemoving(null);
    setActionError(null);
    requestAnimationFrame(() => input.current?.focus());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && removing) cancelRemove();
        else onOpenChange(next);
      }}
      title={
        removing
          ? `Remove ${removing.name} from channel`
          : canManage
            ? "Manage members"
            : "Channel access"
      }
      description={
        removing
          ? `Remove access to ${channelName} for this member.`
          : undefined
      }
      height={removing ? "content" : "stable"}
      bodyLayout={removing ? "flow" : "flex"}
      footerGap={removing ? "compact" : "none"}
      closeLabel={removing ? "Back to members" : "Close members"}
      preventClose={pending !== null}
      initialFocus={input}
      finalFocus={triggerRef}
      actions={
        removing && (
          <>
            <Button
              ref={cancelRemoval}
              variant="subtle"
              disabled={Boolean(pending)}
              onClick={cancelRemove}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending?.kind === "remove"}
              disabled={!canChange}
              onClick={() =>
                void runAction({ kind: "remove", id: removing.member.id }, () =>
                  onRemove(removing.member),
                )
              }
            >
              Remove
            </Button>
          </>
        )
      }
    >
      {removing ? (
        actionError && (
          <p role="alert" className="text-body-sm text-danger">
            {actionError}
          </p>
        )
      ) : (
        <div className={styles.layout}>
          <div className={styles.searchControls}>
            <div className={styles.memberSearch}>
              <SearchField
                inputRef={input}
                label="Search people and agents"
                placeholder={
                  canManage ? "Add people and agents" : "Search members"
                }
                value={query}
                onValueChange={(value) => {
                  setQuery(value);
                  setFilter("All");
                  setHighlight(-1);
                }}
                onKeyDown={searchKeys}
                trailing={
                  filterAvailable && !needle ? (
                    <MenuRoot>
                      <MenuTrigger
                        render={
                          <IconButton
                            aria-label={`Filter members: ${filter}`}
                            title={`Filter members: ${filter}`}
                            variant={filter === "All" ? "ghost" : "prominent"}
                            icon={<Filter2Icon size={16} aria-hidden="true" />}
                          />
                        }
                      />
                      <MenuPopup align="end">
                        <MenuGroup>
                          <MenuGroupLabel>People and agents</MenuGroupLabel>
                          <MenuRadioGroup
                            value={filter}
                            onValueChange={(value) => {
                              setFilter(value as RosterFilter);
                              if (memberList.current)
                                memberList.current.scrollTop = 0;
                            }}
                          >
                            {(["All", ...groups] as const).map((group) => (
                              <MenuRadioItem
                                key={group}
                                value={group}
                                closeOnClick
                              >
                                {group}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuGroup>
                      </MenuPopup>
                    </MenuRoot>
                  ) : undefined
                }
              />
              <span className="sr-only" role="status">
                {activeAddition
                  ? `${activeAddition.name}. Press Enter to add.`
                  : ""}
              </span>
            </div>
          </div>
          {actionError && (
            <p role="alert" className="text-body-sm text-danger">
              {actionError}
            </p>
          )}
          <div
            ref={memberList}
            className={`${styles.memberList} buzz-thin-scrollbar`}
            aria-label="Member list"
            aria-busy={loading}
          >
            {error && (
              <EmptyState
                frame="none"
                icon={<UsersIcon size={20} />}
                title="Couldn’t load members"
                description={error}
                action={
                  <Button size="sm" onClick={onRetry} disabled={loading}>
                    Retry
                  </Button>
                }
              />
            )}
            {loading && roster.length === 0 && !error && (
              <div className={styles.loadingMembers} role="status">
                <CircleNotchIcon
                  size={24}
                  className="motion-safe:animate-spin"
                  aria-hidden="true"
                />
                <span className="sr-only">Loading members…</span>
              </div>
            )}
            {groups.map((group) => {
              const entries = visible.filter(
                (entry) => entry.agent === (group === "Agents"),
              );
              if (!entries.length) return null;
              return (
                <section key={group} aria-label={group}>
                  <h3
                    className={`${styles.groupHeading} text-caption text-subtle`}
                  >
                    {group} · {entries.length}
                  </h3>
                  <ul className={styles.memberRows}>
                    {entries.map((entry) => {
                      const agentId = entry.member.agentId;
                      const isSelf = entry.member.userId === currentUserId;
                      const canRemove =
                        canChange && entry.role !== "owner" && !isSelf;
                      const openProfile =
                        agentId && onOpenAgentProfile
                          ? () => {
                              onOpenChange(false);
                              onOpenAgentProfile(agentId);
                            }
                          : undefined;
                      return (
                        <li key={entry.member.id} className={styles.member}>
                          <MemberIdentity
                            name={entry.name}
                            avatarUrl={entry.avatarUrl}
                            agent={entry.agent}
                          >
                            {isSelf ? " (you)" : ""}
                          </MemberIdentity>
                          <span
                            className={`${styles.role} text-caption text-subtle`}
                          >
                            {roleLabels[entry.role]}
                          </span>
                          {agentId && onToggleAutoReply && (
                            <div className={styles.autoReply}>
                              <span
                                className="text-caption text-subtle"
                                aria-hidden="true"
                              >
                                Auto reply
                              </span>
                              <Switch
                                aria-label={`Auto reply for ${entry.name}`}
                                checked={entry.member.autoReply}
                                disabled={!rosterReady || Boolean(pending)}
                                onCheckedChange={(checked) =>
                                  void runAction(
                                    { kind: "autoReply", id: entry.member.id },
                                    () => onToggleAutoReply(agentId, checked),
                                  )
                                }
                              />
                            </div>
                          )}
                          <MemberMenu
                            name={entry.name}
                            disabled={Boolean(pending)}
                            onRemove={
                              canRemove
                                ? () => {
                                    setActionError(null);
                                    setRemoving(entry);
                                  }
                                : undefined
                            }
                            onOpenProfile={openProfile}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {additions.length > 0 && (
              <section
                className={styles.memberGroup}
                aria-label="Available to add"
              >
                <h3
                  className={`${styles.groupHeading} text-caption text-subtle`}
                >
                  Available to add
                </h3>
                <ul className={styles.memberRows}>
                  {additions.map((participant, index) => (
                    <li
                      key={participant.id}
                      className={styles.member}
                      data-highlighted={index === highlight || undefined}
                    >
                      <MemberIdentity
                        name={participant.name}
                        avatarUrl={participant.avatarUrl}
                        agent={participant.role === "agent"}
                      />
                      <div className={styles.addAction}>
                        <Button
                          size="xs"
                          variant="prominent"
                          aria-label={`Add ${participant.name}`}
                          loading={
                            pending?.kind === "add" &&
                            pending.id === participant.id
                          }
                          disabled={Boolean(
                            pending && pending.id !== participant.id,
                          )}
                          onClick={() =>
                            void runAction(
                              { kind: "add", id: participant.id },
                              () => onAdd(participant),
                            )
                          }
                        >
                          Add
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!loading &&
              !error &&
              visible.length === 0 &&
              additions.length === 0 && (
                <EmptyState
                  frame="none"
                  icon={<UsersIcon size={20} />}
                  title={
                    needle ? "No matching people or agents" : "No members yet"
                  }
                />
              )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function MemberIdentity({
  name,
  avatarUrl,
  agent,
  children,
}: {
  name: string;
  avatarUrl?: string | undefined;
  agent: boolean;
  children?: string;
}) {
  return (
    <div className={styles.profile}>
      <Avatar
        alt=""
        fallback={name}
        src={avatarUrl}
        size="small"
        shape={agent ? "squircle" : "circle"}
      />
      <span className={`${styles.name} text-body-sm`}>
        {name}
        {children}
      </span>
    </div>
  );
}

function MemberMenu({
  name,
  disabled,
  onRemove,
  onOpenProfile,
}: {
  name: string;
  disabled: boolean;
  onRemove?: () => void;
  onOpenProfile?: () => void;
}) {
  if (!onRemove && !onOpenProfile) return null;
  return (
    <div className={styles.memberActions}>
      <MenuRoot>
        <MenuTrigger
          render={
            <IconButton
              size="toolbar"
              aria-label={`Actions for ${name}`}
              title={`Actions for ${name}`}
              disabled={disabled}
              icon={<DotsThreeIcon size={16} aria-hidden="true" />}
            />
          }
        />
        <MenuPopup align="end">
          {onOpenProfile && (
            <MenuItem onClick={onOpenProfile}>View agent profile</MenuItem>
          )}
          {onRemove && (
            <MenuItem tone="danger" onClick={onRemove}>
              <MenuIcon>
                <TrashIcon size={16} aria-hidden="true" />
              </MenuIcon>
              Remove from channel
            </MenuItem>
          )}
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}
