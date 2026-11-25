import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChatCircleIcon,
  HashIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  XIcon,
} from "../../design-system/icons";
import { activeModal } from "../../design-system/overlayLayer";
import { Avatar } from "../../design-system/ui/Avatar";
import { Button } from "../../design-system/ui/Button";
import { Dialog } from "../../design-system/ui/Dialog";
import { KeyboardShortcut } from "../../design-system/ui/KeyboardShortcut";
import { LoadingRegion } from "../../design-system/ui/LoadingRegion";
import { NavigationItem } from "../../design-system/ui/NavigationItem";
import { SearchField } from "../../design-system/ui/SearchField";
import { BuzzMessageMarkdown } from "../messages/BuzzMessageMarkdown";
import { MessageTimestamp } from "../messages/MessageTimestamp";
import type { ChatMessage, Participant } from "../messages/types";
import { formatBinding, isApplePlatform } from "../shortcuts/format";
import { MatchedLabel } from "./MatchedLabel";
import { matchName } from "./match";
import { useMessageSearch } from "./useMessageSearch";
import "./page-search.css";

interface SearchChannel {
  id: string;
  name: string;
  topic?: string;
  kind?: string;
}

interface SearchDestination {
  key: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  preview?: ReactNode;
  positions?: readonly number[];
  open(): void;
}

interface SearchGroup {
  label: string;
  tone: "channel" | "person" | "agent" | "message";
  destinations: SearchDestination[];
}

const searchBinding = { mod: true, key: "k" };
const channelSearchBinding = { mod: true, key: "f" };
const searchMemory = 5 * 60_000;

function channelLabel(channel: SearchChannel) {
  return channel.kind === "dm" ? channel.topic || channel.name : channel.name;
}

function findNames<T>(
  items: readonly T[],
  label: (item: T) => string,
  query: string,
) {
  return items
    .flatMap((item) => {
      const text = label(item);
      const match = query ? matchName(text, query) : { rank: 0, positions: [] };
      return match ? [{ item, text, ...match }] : [];
    })
    .sort((a, b) => a.rank - b.rank);
}

function messageSnippet(message: ChatMessage, query: string) {
  const text = message.content.trim().replace(/\s+/g, " ");
  if (!text)
    return (
      message.attachments?.map((attachment) => attachment.name).join(", ") ||
      "Message"
    );
  const position = text.toLowerCase().indexOf(query);
  const start = Math.max(0, position - 45);
  const end = start + 160;
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export interface BuzzPageSearchProps {
  serverHttp: string;
  activeChannelId: string;
  channels: readonly SearchChannel[];
  participants: readonly Participant[];
  currentUserId?: string;
  onOpenMessage: (message: ChatMessage) => void;
  onOpenChannel: (id: string) => void;
  onOpenParticipant?: (participant: Participant) => void;
}

/** The upstream PageSearch and SearchChoices presentation over local chat data. */
export function BuzzPageSearch({
  serverHttp,
  activeChannelId,
  channels,
  participants,
  currentUserId,
  onOpenMessage,
  onOpenChannel,
  onOpenParticipant,
}: BuzzPageSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>();
  const [group, setGroup] = useState<string>();
  const [selection, setSelection] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const remembered = useRef<{ query: string; expires: number } | undefined>(
    undefined,
  );
  const escaped = useRef(false);
  const listId = useId();
  const apple = isApplePlatform(navigator.platform);
  const binding = formatBinding(searchBinding, apple);
  const scopeBinding = formatBinding(channelSearchBinding, apple);
  const normalized = query.trim().toLowerCase();
  const scopeChannel = channels.find((channel) => channel.id === scope);
  const title = scope ? "Search this conversation" : "Search Buzz";
  const { messages, pending, failed } = useMessageSearch({
    serverHttp,
    query: query.trim(),
    channelId: scope,
    currentUserId,
    open,
    attempt,
  });

  const begin = useCallback(
    (channelId?: string) => {
      if (!open) {
        returnFocus.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : trigger.current;
      }
      const memory = remembered.current;
      setQuery(
        !channelId && memory && Date.now() < memory.expires ? memory.query : "",
      );
      setScope(channelId);
      setGroup(undefined);
      setSelection(undefined);
      setOpen(true);
      if (open) input.current?.focus();
    },
    [open],
  );

  const close = () => {
    remembered.current =
      escaped.current || scope
        ? undefined
        : { query, expires: Date.now() + searchMemory };
    escaped.current = false;
    setOpen(false);
  };

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const modifier = apple
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        !modifier ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.defaultPrevented
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "k" && (key !== "f" || !activeChannelId)) return;
      const modal = activeModal(document);
      if (modal && (!input.current || !modal.contains(input.current))) return;
      event.preventDefault();
      if (!event.repeat) begin(key === "f" ? activeChannelId : undefined);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [activeChannelId, apple, begin]);

  const select = (run: () => void) => {
    returnFocus.current = null;
    close();
    run();
  };

  const participantsById = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const matchingChannels = scope
    ? []
    : findNames(channels, channelLabel, normalized);
  const channelDestinations = (kind: "channel" | "dm") =>
    matchingChannels
      .filter(({ item }) =>
        kind === "dm" ? item.kind === "dm" : item.kind !== "dm",
      )
      .map(({ item, text, positions }): SearchDestination => ({
        key: `channel:${item.id}`,
        label: text,
        detail: item.kind === "dm" ? undefined : item.topic,
        icon:
          item.kind === "dm" ? (
            <ChatCircleIcon size={16} />
          ) : (
            <HashIcon size={16} />
          ),
        positions,
        open: () => select(() => onOpenChannel(item.id)),
      }));
  const matchingParticipants =
    !scope && normalized && onOpenParticipant
      ? findNames(
          participants.filter(
            (person) => person.id !== currentUserId && !person.archived,
          ),
          (person) => person.name,
          normalized,
        )
      : [];
  const participantDestinations = (role: Participant["role"]) =>
    matchingParticipants
      .filter(({ item }) => item.role === role)
      .map(({ item, text, positions }): SearchDestination => ({
        key: `participant:${item.id}`,
        label: text,
        detail: item.description,
        icon: (
          <Avatar
            src={item.avatarUrl}
            alt=""
            fallback={item.name}
            shape={role === "agent" ? "squircle" : "circle"}
            size="small"
          />
        ),
        positions,
        open: () => select(() => onOpenParticipant?.(item)),
      }));
  const allGroups: SearchGroup[] = [
    {
      label: "Channels",
      tone: "channel",
      destinations: channelDestinations("channel"),
    },
    {
      label: "Direct messages",
      tone: "person",
      destinations: channelDestinations("dm"),
    },
    {
      label: "People",
      tone: "person",
      destinations: participantDestinations("human"),
    },
    {
      label: "Agents",
      tone: "agent",
      destinations: participantDestinations("agent"),
    },
    {
      label: "Messages",
      tone: "message",
      destinations: messages.flatMap((message) => {
        const channel = channelsById.get(message.channelId);
        if (!channel) return [];
        const sender = participantsById.get(message.senderId)?.name;
        const conversation =
          channel.kind === "dm"
            ? channelLabel(channel)
            : `#${channelLabel(channel)}`;
        const label = messageSnippet(message, normalized);
        return [
          {
            key: `message:${message.id}`,
            label,
            detail: sender ? `${conversation} · ${sender}` : conversation,
            icon:
              message.senderRole === "agent" ? (
                <RobotIcon size={16} />
              ) : (
                <ChatCircleIcon size={16} />
              ),
            positions: matchName(label, normalized)?.positions,
            preview: (
              <>
                <MessageTimestamp createdAt={message.createdAt} compact />
                <BuzzMessageMarkdown content={message.content || label} />
              </>
            ),
            open: () => select(() => onOpenMessage(message)),
          },
        ];
      }),
    },
  ];
  const groups = allGroups.filter(({ destinations }) => destinations.length);
  const currentGroup = groups.find((item) => item.label === group);
  const grouped = currentGroup
    ? [currentGroup]
    : groups.map((item, index) => ({
        ...item,
        destinations: item.destinations.slice(0, index ? 3 : 5),
      }));
  const choices = grouped.flatMap(({ tone, destinations }) =>
    destinations.map((destination) => ({ ...destination, tone })),
  );
  const highlighted =
    choices.find((choice) => choice.key === selection) ?? choices[0];
  const selectedKey = highlighted?.key;
  const optionId = (key: string) => `${listId}-${key}`;

  useEffect(() => {
    if (!selection || !selectedKey) return;
    const option = document.getElementById(`${listId}-${selectedKey}`);
    const scroll = list.current;
    if (!option || !scroll) return;
    const visible = scroll.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < visible.top || row.bottom > visible.bottom)
      option.scrollIntoView({ block: "nearest" });
  }, [listId, selectedKey, selection]);

  function chooseGroup(label?: string) {
    setGroup(label);
    setSelection(undefined);
    if (list.current) list.current.scrollTop = 0;
  }

  function removeScope() {
    setScope(undefined);
    chooseGroup();
    input.current?.focus();
  }

  return (
    <div className="shell-menu-search">
      <Button
        ref={trigger}
        variant="inverted"
        size="sm"
        shape="capsule"
        aria-label="Search Buzz"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Search Buzz (${binding.text})`}
        onClick={() => {
          trigger.current?.focus();
          begin();
        }}
      >
        <span className="shell-search-content">
          <MagnifyingGlassIcon size={16} aria-hidden="true" />
          <span className="shell-search-label">Search</span>
          <span className="shell-search-shortcut">
            <KeyboardShortcut {...binding} />
          </span>
        </span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title={title}
        presentation="search"
        size="wide"
        height="stable-tall"
        bodyLayout="flex"
        footerGap="none"
        initialFocus={input}
        finalFocus={() => returnFocus.current ?? false}
        onEscape={() => {
          if (currentGroup) {
            chooseGroup();
            input.current?.focus();
            return true;
          }
          escaped.current = true;
          return false;
        }}
      >
        <div className="search-palette" data-search-peek="">
          {scope && (
            <div className="search-palette-scope-row">
              <Button
                size="xs"
                variant="outline-subtle"
                aria-label="Remove conversation search scope"
                onClick={removeScope}
              >
                {scopeChannel
                  ? channelLabel(scopeChannel)
                  : "This conversation"}
                <XIcon size={14} aria-hidden="true" />
              </Button>
            </div>
          )}
          <div className="search-palette-controls">
            <SearchField
              variant="palette"
              inputRef={input}
              role="combobox"
              aria-controls={listId}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={
                selectedKey ? optionId(selectedKey) : undefined
              }
              label={title}
              placeholder="Search"
              value={query}
              maxLength={256}
              autoComplete="off"
              onValueChange={(value) => {
                setQuery(value);
                chooseGroup();
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                )
                  return;
                if (event.key === "Backspace" && !query && scope) {
                  event.preventDefault();
                  removeScope();
                } else if (
                  event.key === "Enter" &&
                  highlighted &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey
                ) {
                  event.preventDefault();
                  highlighted.open();
                } else if (
                  (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                  choices.length &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey
                ) {
                  event.preventDefault();
                  const index = choices.findIndex(
                    ({ key }) => key === selectedKey,
                  );
                  const offset = event.key === "ArrowDown" ? 1 : -1;
                  setSelection(
                    choices[(index + offset + choices.length) % choices.length]
                      .key,
                  );
                }
              }}
            />
          </div>
          <div
            className="search-peek-workspace"
            data-preview={highlighted ? "" : undefined}
          >
            {groups.length > 0 && (
              <fieldset className="search-peek-rail" aria-label="Result groups">
                <Button
                  variant={currentGroup ? "outline-subtle" : "subtle"}
                  size="xs"
                  aria-pressed={!currentGroup}
                  onClick={() => chooseGroup()}
                >
                  Top results
                </Button>
                {groups.map((item) => (
                  <Button
                    key={item.label}
                    variant={
                      currentGroup === item ? "subtle" : "outline-subtle"
                    }
                    size="xs"
                    aria-pressed={currentGroup === item}
                    onClick={() => chooseGroup(item.label)}
                  >
                    <span
                      className="search-peek-filter-dot"
                      data-tone={item.tone}
                      aria-hidden="true"
                    />
                    {item.label === "Direct messages" ? "DMs" : item.label}
                    <span className="search-peek-count">
                      {item.destinations.length}
                    </span>
                  </Button>
                ))}
              </fieldset>
            )}
            <div className="search-peek-body" ref={list}>
              <LoadingRegion
                pending={pending}
                label="Searching messages…"
                statusVisibility="screen-reader"
              >
                <div
                  id={listId}
                  role="listbox"
                  aria-label="Search results"
                  aria-busy={pending}
                  className="search-palette-results interaction-panel"
                >
                  {grouped.map((item) => (
                    <div
                      key={item.label}
                      role="group"
                      aria-label={item.label}
                      className="search-palette-group"
                      data-tone={item.tone}
                    >
                      <div
                        className="navigation-section-heading"
                        aria-hidden="true"
                      >
                        <span className="text-label-sm">{item.label}</span>
                      </div>
                      {item.destinations.map((destination) => (
                        <NavigationItem
                          key={destination.key}
                          id={optionId(destination.key)}
                          role="option"
                          tabIndex={-1}
                          aria-selected={destination.key === selectedKey}
                          variant="search"
                          multiline
                          highlighted={destination.key === selectedKey}
                          icon={
                            <span
                              className="search-peek-tile"
                              aria-hidden="true"
                            >
                              {destination.icon}
                            </span>
                          }
                          label={
                            <span className="search-result-label">
                              <span className="search-result-title">
                                <MatchedLabel
                                  label={destination.label}
                                  positions={destination.positions}
                                />
                              </span>
                              {destination.detail && (
                                <span className="search-result-detail text-caption text-secondary">
                                  {destination.detail}
                                </span>
                              )}
                            </span>
                          }
                          onPointerMove={(event) => {
                            if (event.pointerType === "mouse")
                              setSelection(destination.key);
                          }}
                          onClick={destination.open}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                {failed ? (
                  <div className="search-palette-centered" role="alert">
                    <p>Message search is unavailable.</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        input.current?.focus();
                        setAttempt((value) => value + 1);
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  !choices.length && (
                    <p className="search-palette-centered" role="status">
                      {pending
                        ? "Searching messages…"
                        : normalized
                          ? "No matching results."
                          : scope
                            ? "Type to search messages in this conversation."
                            : "Search for channels or messages."}
                    </p>
                  )
                )}
              </LoadingRegion>
            </div>
            {highlighted && (
              <aside
                className="search-peek-side"
                data-tone={highlighted.tone}
                aria-label="Selected result preview"
              >
                <div className="search-peek-head">
                  <span className="search-peek-tile" aria-hidden="true">
                    {highlighted.icon}
                  </span>
                  <div className="search-result-label">
                    <span className="text-label-sm">
                      {highlighted.detail || highlighted.label}
                    </span>
                    {!highlighted.preview && highlighted.detail && (
                      <span className="text-caption text-secondary">
                        {highlighted.label}
                      </span>
                    )}
                  </div>
                </div>
                {highlighted.preview && (
                  <div className="search-peek-preview text-body-sm">
                    {highlighted.preview}
                  </div>
                )}
              </aside>
            )}
          </div>
          <div className="search-peek-keys text-caption text-subtle">
            <span>
              <KeyboardShortcut text="↑↓" label="Up and Down Arrow" /> Navigate
            </span>
            <span>
              <KeyboardShortcut text="↵" label="Enter" /> Open
            </span>
            {!scope && activeChannelId && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setScope(activeChannelId);
                  chooseGroup();
                  input.current?.focus();
                }}
              >
                <KeyboardShortcut {...scopeBinding} /> Search this conversation
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
