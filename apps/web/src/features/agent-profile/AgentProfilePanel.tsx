import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertDialog } from '../../design-system/ui/AlertDialog';
import { Avatar } from '../../design-system/ui/Avatar';
import { Badge } from '../../design-system/ui/Badge';
import { Button } from '../../design-system/ui/Button';
import { IconButton } from '../../design-system/ui/IconButton';
import { PanelHeader } from '../../design-system/ui/PanelHeader';
import { Switch } from '../../design-system/ui/Switch';
import { Tabs, type TabItem } from '../../design-system/ui/Tabs';
import {
  ArchiveIcon,
  ArchiveOffIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ArrowsClockwiseIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ClockIcon,
  CpuIcon,
  FileTextIcon,
  FolderSimpleIcon,
  HashIcon,
  InfoIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  RobotIcon,
  StopIcon,
  TerminalWindowIcon,
  TrashIcon,
  UsersPlusIcon,
  WrenchIcon,
  XIcon,
} from '../../design-system/icons/index';
import { BuzzMessageMarkdown } from '../messages/BuzzMessageMarkdown';
import { EditAgentDialog } from './EditAgentDialog';
import styles from './AgentProfilePanel.module.css';
import type {
  AgentDetail,
  AgentProfileTab,
  AgentProfileView,
  AgentSessionItem,
  AgentUpdateInput,
} from './types';

interface ChannelSummary {
  id: string;
  name: string;
  topic: string;
  kind?: 'channel' | 'dm';
}

function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function sessionLifecycleState(session: AgentSessionItem): string {
  return session.state || session.status || 'active';
}

function sessionActivityScore(s: AgentSessionItem): number {
  if (typeof s.lastActivityAt === 'number') return s.lastActivityAt;
  if (typeof s.lastMessageAt === 'number') return s.lastMessageAt;
  if (typeof s.spawnedAt === 'number') return s.spawnedAt;
  if (typeof s.createdAt === 'number') return s.createdAt;
  if (typeof s.createdAt === 'string') {
    const parsed = Date.parse(s.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function AgentProfilePanel({
  agentId,
  activeChannelId,
  currentUserId,
  serverHttp,
  allChannels,
  onClose,
  onOpenDm,
  onOpenChannel,
  onOpenTerminal,
  onAgentUpdated,
}: {
  agentId: string;
  activeChannelId?: string;
  currentUserId: string;
  serverHttp: string;
  allChannels: readonly ChannelSummary[];
  onClose: () => void;
  onOpenDm: (agentId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onOpenTerminal: (sessionId: string, context?: { agentId?: string; channelId?: string }) => void;
  onAgentUpdated?: () => void;
}) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentProfileTab>('info');
  const [view, setView] = useState<AgentProfileView>('summary');
  const [editOpen, setEditOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Add to channel state
  const [selectedAddChannelId, setSelectedAddChannelId] = useState('');

  // Focused session history state
  const [historySessionId, setHistorySessionId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyContent, setHistoryContent] = useState<string | null>(null);

  const requestSeqRef = useRef(0);
  const activeAbortRef = useRef<AbortController | null>(null);

  const loadAgent = useCallback(async (clearPrevious = false) => {
    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;
    const seq = ++requestSeqRef.current;

    if (clearPrevious) {
      setAgent(null);
      setEditOpen(false);
      setArchiveConfirmOpen(false);
    }
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const res = await fetch(
        `${serverHttp}/api/agents/${encodeURIComponent(agentId)}?userId=${encodeURIComponent(currentUserId)}`,
        { signal: controller.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { agent?: AgentDetail };
      if (!data.agent) throw new Error('Agent not found');
      if (seq !== requestSeqRef.current || controller.signal.aborted) return;
      setAgent(data.agent);
    } catch (err) {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      setAgent(null);
      setError(err instanceof Error ? err.message : '加载 Agent 详情失败');
    } finally {
      if (seq === requestSeqRef.current && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [agentId, currentUserId, serverHttp]);

  useEffect(() => {
    setView('summary');
    setTab('info');
    setHistorySessionId(null);
    setHistoryContent(null);
    void loadAgent(true);
    return () => {
      activeAbortRef.current?.abort();
    };
  }, [agentId, loadAgent]);

  const sortedSessions: AgentSessionItem[] = useMemo(() => {
    if (!agent) return [];
    const activeChannelSessionId = activeChannelId
      ? agent.channels.find((c) => c.channelId === activeChannelId)?.sessionId
      : undefined;
    const matchesActiveChannel = (s: AgentSessionItem) =>
      Boolean(
        activeChannelId &&
          (s.channelId === activeChannelId ||
            (activeChannelSessionId && s.sessionId === activeChannelSessionId)),
      );

    return [...agent.sessions].sort((a, b) => {
      const aMatch = matchesActiveChannel(a) ? 1 : 0;
      const bMatch = matchesActiveChannel(b) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;

      const aState = sessionLifecycleState(a);
      const bState = sessionLifecycleState(b);
      const aLive = aState !== 'closed' && aState !== 'offline' ? 1 : 0;
      const bLive = bState !== 'closed' && bState !== 'offline' ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;

      return sessionActivityScore(b) - sessionActivityScore(a);
    });
  }, [agent, activeChannelId]);

  const primarySession: AgentSessionItem | undefined = sortedSessions[0];

  const unjoinedChannels = useMemo(() => {
    if (!agent) return [];
    const joinedIds = new Set(agent.channels.map((c) => c.channelId));
    return allChannels.filter((c) => c.kind !== 'dm' && !joinedIds.has(c.id));
  }, [agent, allChannels]);

  useEffect(() => {
    if (unjoinedChannels.length > 0 && !unjoinedChannels.some((c) => c.id === selectedAddChannelId)) {
      setSelectedAddChannelId(unjoinedChannels[0].id);
    } else if (unjoinedChannels.length === 0) {
      setSelectedAddChannelId('');
    }
  }, [unjoinedChannels, selectedAddChannelId]);

  const handlePatchAgent = async (input: AgentUpdateInput) => {
    if (!agent || agent.id !== agentId) return;
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch(
        `${serverHttp}/api/agents/${encodeURIComponent(agent.id)}?userId=${encodeURIComponent(currentUserId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) throw new Error(`保存失败 (HTTP ${res.status})`);
      const data = (await res.json()) as { agent?: AgentDetail };
      if (data.agent && data.agent.id === agentId) setAgent(data.agent);
      onAgentUpdated?.();
    } finally {
      setSaving(false);
    }
  };

  const handleSessionAction = async (sessionId: string, op: 'restart' | 'close' | 'resume') => {
    const key = `${sessionId}:${op}`;
    setBusyKey(key);
    setActionError(null);
    try {
      const res = await fetch(`${serverHttp}/api/sessions/${encodeURIComponent(sessionId)}/${op}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`操作 ${op} 失败 (HTTP ${res.status})`);
      await loadAgent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `操作 ${op} 失败`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleOpenHistory = async (sessionId: string) => {
    setHistorySessionId(sessionId);
    setView('session-history');
    setHistoryLoading(true);
    setHistoryContent(null);
    try {
      const res = await fetch(
        `${serverHttp}/api/sessions/${encodeURIComponent(sessionId)}/history`,
      );
      const data = await res.json();
      setHistoryContent(
        typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      );
    } catch (err) {
      setHistoryContent(err instanceof Error ? err.message : '无法加载会话历史');
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleAddToChannel = async () => {
    if (!selectedAddChannelId) return;
    setBusyKey(`add:${selectedAddChannelId}`);
    setActionError(null);
    try {
      const res = await fetch(
        `${serverHttp}/api/channels/${encodeURIComponent(selectedAddChannelId)}/members`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, autoReply: false }),
        },
      );
      if (!res.ok) throw new Error(`加入频道失败 (HTTP ${res.status})`);
      await loadAgent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '加入频道失败');
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleAutoReply = async (channelId: string, enabled: boolean) => {
    setBusyKey(`autoreply:${channelId}`);
    setActionError(null);
    try {
      const res = await fetch(`${serverHttp}/api/channels/${encodeURIComponent(channelId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, autoReply: enabled }),
      });
      if (!res.ok) throw new Error(`切换自动回复失败 (HTTP ${res.status})`);
      setAgent((prev) =>
        prev
          ? {
              ...prev,
              channels: prev.channels.map((ch) =>
                ch.channelId === channelId ? { ...ch, autoReply: enabled } : ch,
              ),
            }
          : prev,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '切换自动回复失败');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveFromChannel = async (channelId: string) => {
    setBusyKey(`remove:${channelId}`);
    setActionError(null);
    try {
      const res = await fetch(`${serverHttp}/api/channels/${encodeURIComponent(channelId)}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) throw new Error(`移出频道失败 (HTTP ${res.status})`);
      await loadAgent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '移出频道失败');
    } finally {
      setBusyKey(null);
    }
  };

  const tabItems: TabItem<AgentProfileTab>[] = [
    { value: 'info', label: 'Info' },
    {
      value: 'channels',
      label: 'Channels',
      trailing: agent ? <span>{agent.channels.length}</span> : undefined,
    },
    {
      value: 'runtime',
      label: 'Runtime',
      trailing: agent ? <span>{agent.sessions.length}</span> : undefined,
    },
  ];

  const headerTitle =
    view === 'instructions'
      ? 'Agent instructions'
      : view === 'session-history'
        ? historySessionId || 'Session log'
        : 'Agent profile';

  return (
    <aside className={styles.panel} aria-label="Agent details">
      <PanelHeader
        icon={
          view !== 'summary' ? (
            <IconButton
              hint="familiar"
              size="sm"
              aria-label="Back"
              icon={<ArrowLeftIcon size={16} />}
              onClick={() => setView('summary')}
            />
          ) : (
            <RobotIcon size={17} />
          )
        }
        title={headerTitle}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {agent && view === 'summary' && (
              <IconButton
                hint="familiar"
                size="sm"
                aria-label="Edit agent"
                title="编辑 Agent"
                icon={<PencilSimpleIcon size={15} />}
                onClick={() => setEditOpen(true)}
              />
            )}
            <IconButton
              hint="familiar"
              size="sm"
              aria-label="Refresh"
              title="刷新"
              icon={<ArrowsClockwiseIcon size={15} />}
              onClick={() => void loadAgent()}
            />
            <IconButton
              hint="familiar"
              size="sm"
              aria-label="Close agent profile"
              icon={<XIcon size={16} />}
              onClick={onClose}
            />
          </div>
        }
      />

      {loading && !agent ? (
        <div className={styles.emptyBlock}>加载 Agent 详情中…</div>
      ) : error && !agent ? (
        <div className={styles.emptyBlock}>
          <span>{error}</span>
          <Button variant="outline" size="xs" onClick={() => void loadAgent()}>
            重试
          </Button>
        </div>
      ) : agent ? (
        <div className={styles.scrollBody}>
          {view === 'instructions' ? (
            <>
              <div className={styles.focusedBox}>
                {agent.systemPrompt.trim() ? (
                  <BuzzMessageMarkdown content={agent.systemPrompt} />
                ) : (
                  <span style={{ color: 'var(--text-secondary)' }}>No instruction set.</span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <PencilSimpleIcon size={14} />
                <span>Edit instructions</span>
              </Button>
            </>
          ) : view === 'session-history' ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={styles.rowValueMono}>{historySessionId}</span>
                {historySessionId && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onOpenTerminal(historySessionId)}
                  >
                    <TerminalWindowIcon size={13} />
                    <span>Open Terminal</span>
                  </Button>
                )}
              </div>
              <pre className={styles.logPre}>
                {historyLoading ? 'Loading session history…' : historyContent || 'No log output.'}
              </pre>
            </>
          ) : (
            <>
              {/* Hero */}
              <div className={styles.hero}>
                <Avatar
                  src={agent.avatarUrl || undefined}
                  alt={agent.name}
                  fallback={agent.name}
                  size="large"
                  shape="squircle"
                  statusBadge={agent.status === 'online' ? 'online' : 'offline'}
                />
                <div className={styles.heroTitleRow}>
                  <h2 className={styles.heroName}>{agent.name}</h2>
                </div>
                <div className={styles.heroMeta}>
                  <Badge tone={agent.status === 'online' ? 'success' : 'neutral'}>
                    {agent.status === 'online' ? 'Online' : 'Offline'}
                  </Badge>
                  <Badge>{agent.cliId}</Badge>
                  {agent.archived && <Badge tone="neutral">Archived</Badge>}
                </div>
                {agent.description && (
                  <p className={styles.heroDescription}>{agent.description}</p>
                )}

                {/* Primary Actions */}
                <div className={styles.actionTiles}>
                  <button
                    type="button"
                    className={`${styles.actionTile} ${styles.actionTilePrimary}`}
                    onClick={() => onOpenDm(agent.id)}
                  >
                    <ChatCircleIcon size={17} />
                    <span>Message</span>
                  </button>
                  <button
                    type="button"
                    className={styles.actionTile}
                    disabled={!primarySession}
                    title={
                      primarySession
                        ? `接管 ${
                            primarySession.channelName
                              ? `#${primarySession.channelName}`
                              : primarySession.title || primarySession.sessionId
                          } (${primarySession.sessionId.slice(0, 8)})`
                        : '暂无活跃会话'
                    }
                    onClick={() =>
                      primarySession &&
                      onOpenTerminal(primarySession.sessionId, {
                        agentId: agent.id,
                        channelId: primarySession.channelId,
                      })
                    }
                  >
                    <TerminalWindowIcon size={17} />
                    <span>Terminal</span>
                  </button>
                  <button
                    type="button"
                    className={styles.actionTile}
                    disabled={
                      !primarySession || busyKey === `${primarySession.sessionId}:restart`
                    }
                    onClick={() =>
                      primarySession && void handleSessionAction(primarySession.sessionId, 'restart')
                    }
                  >
                    <ArrowsClockwiseIcon size={17} />
                    <span>Restart</span>
                  </button>
                  {primarySession && sessionLifecycleState(primarySession) === 'closed' ? (
                    <button
                      type="button"
                      className={styles.actionTile}
                      disabled={busyKey === `${primarySession.sessionId}:resume`}
                      onClick={() => void handleSessionAction(primarySession.sessionId, 'resume')}
                    >
                      <PlayIcon size={17} />
                      <span>Resume</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.actionTile}
                      disabled={
                        !primarySession || busyKey === `${primarySession.sessionId}:close`
                      }
                      onClick={() =>
                        primarySession && void handleSessionAction(primarySession.sessionId, 'close')
                      }
                    >
                      <StopIcon size={17} />
                      <span>Stop</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Segmented Tabs */}
              <Tabs
                variant="segmented"
                size="sm"
                label="Agent profile sections"
                value={tab}
                items={tabItems}
                onValueChange={setTab}
              />

              {actionError && (
                <div
                  role="alert"
                  className="text-caption"
                  style={{
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-control)',
                    border: '1px solid var(--border-danger, var(--border-standard))',
                    background: 'var(--surface-inset)',
                    color: 'var(--text-danger, var(--text-standard))',
                  }}
                >
                  {actionError}
                </div>
              )}

              {/* INFO TAB */}
              {tab === 'info' && (
                <>
                  {/* Latest Activity Preview Card */}
                  {agent.recentMessages.length > 0 || primarySession ? (
                    <button
                      type="button"
                      className={styles.activityCard}
                      onClick={() => {
                        if (primarySession) {
                          void handleOpenHistory(primarySession.sessionId);
                        } else if (agent.recentMessages[0]) {
                          onOpenChannel(agent.recentMessages[0].channelId);
                        }
                      }}
                    >
                      <span className={styles.activityPill}>
                        {agent.recentMessages[0]
                          ? formatRelativeTime(agent.recentMessages[0].createdAt)
                          : primarySession
                            ? sessionLifecycleState(primarySession)
                            : 'Idle'}
                      </span>
                      {agent.recentMessages.length > 0 ? (
                        agent.recentMessages.slice(0, 2).map((msg) => (
                          <div key={msg.id} className={styles.activityItem}>
                            <span className={styles.activityItemMeta}>
                              #{msg.channelName}
                            </span>
                            <span className={styles.activityItemText}>{msg.content}</span>
                          </div>
                        ))
                      ) : (
                        <div className={styles.activityItem}>
                          <span className={styles.activityItemMeta}>
                            Session {primarySession?.sessionId}
                          </span>
                          <span className={styles.activityItemText}>
                            点击查看 Botmux 会话运行日志与输出历史。
                          </span>
                        </div>
                      )}
                      <div className={styles.activityFade}>
                        <span className={styles.activityLabel}>Latest Activity</span>
                      </div>
                    </button>
                  ) : (
                    <div className={styles.sectionCard}>
                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <WrenchIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Activity log</span>
                          <span className={styles.rowValue}>暂无运行记录</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Info Group */}
                  <div className={styles.sectionWrap}>
                    <div className={styles.sectionTitle}>Info</div>
                    <div className={styles.sectionCard}>
                      <button
                        type="button"
                        className={`${styles.row} ${styles.rowInteractive}`}
                        style={{ alignItems: 'flex-start' }}
                        onClick={() =>
                          agent.systemPrompt.trim()
                            ? setView('instructions')
                            : setEditOpen(true)
                        }
                      >
                        <span className={styles.rowIcon} style={{ marginTop: 2 }}>
                          <FileTextIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Agent instructions</span>
                          {agent.systemPrompt.trim() ? (
                            <span className={styles.rowSnippet}>{agent.systemPrompt}</span>
                          ) : (
                            <span className={styles.rowValue}>No instruction set. Click to add…</span>
                          )}
                        </div>
                        <span className={styles.rowTrailing} style={{ marginTop: 2 }}>
                          <CaretRightIcon size={15} />
                        </span>
                      </button>

                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <CpuIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Runtime / CLI</span>
                          <span className={styles.rowValue}>{agent.cliId}</span>
                        </div>
                      </div>

                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <FolderSimpleIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Working directory</span>
                          <span className={styles.rowValueMono}>
                            {agent.workingDir || '—'}
                          </span>
                        </div>
                      </div>

                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <InfoIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Botmux App ID</span>
                          <span className={styles.rowValueMono}>{agent.id}</span>
                        </div>
                      </div>

                      {agent.archived && (
                        <div className={styles.row}>
                          <span className={styles.rowIcon}>
                            <ArchiveIcon size={16} />
                          </span>
                          <div className={styles.rowBody}>
                            <span className={styles.rowLabel}>Visibility</span>
                            <span className={styles.rowValue}>
                              Archived（已从常规列表折叠，可随时恢复）
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Management Actions */}
                  <div className={styles.sectionWrap}>
                    <div className={styles.sectionTitle}>Management</div>
                    <div className={styles.sectionCard}>
                      <button
                        type="button"
                        className={`${styles.row} ${styles.rowInteractive}`}
                        onClick={() => setEditOpen(true)}
                      >
                        <span className={styles.rowIcon}>
                          <PencilSimpleIcon size={16} />
                        </span>
                        <span className={styles.rowLabel} style={{ flex: 1 }}>
                          Edit agent profile
                        </span>
                        <span className={styles.rowTrailing}>
                          <CaretRightIcon size={15} />
                        </span>
                      </button>

                      <button
                        type="button"
                        className={`${styles.row} ${styles.rowInteractive}`}
                        disabled={saving}
                        onClick={() => {
                          if (agent.archived) {
                            void handlePatchAgent({ archived: false });
                          } else {
                            setArchiveConfirmOpen(true);
                          }
                        }}
                      >
                        <span className={styles.rowIcon}>
                          {agent.archived ? (
                            <ArchiveOffIcon size={16} />
                          ) : (
                            <ArchiveIcon size={16} />
                          )}
                        </span>
                        <span
                          className={`${styles.rowLabel} ${
                            !agent.archived ? styles.destructiveText : ''
                          }`}
                          style={{ flex: 1 }}
                        >
                          {agent.archived ? 'Unarchive agent' : 'Archive agent'}
                        </span>
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* CHANNELS TAB */}
              {tab === 'channels' && (
                <div className={styles.sectionCard}>
                  {unjoinedChannels.length > 0 && (
                    <div className={styles.addChannelBar}>
                      <UsersPlusIcon size={16} />
                      <select
                        className={styles.nativeSelect}
                        value={selectedAddChannelId}
                        onChange={(e) => setSelectedAddChannelId(e.target.value)}
                        aria-label="Choose channel to add agent"
                      >
                        {unjoinedChannels.map((ch) => (
                          <option key={ch.id} value={ch.id}>
                            #{ch.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="outline"
                        size="xs"
                        loading={busyKey === `add:${selectedAddChannelId}`}
                        onClick={() => void handleAddToChannel()}
                      >
                        <PlusIcon size={13} />
                        <span>Add</span>
                      </Button>
                    </div>
                  )}

                  {agent.channels.length === 0 ? (
                    <div className={styles.emptyBlock}>
                      <HashIcon size={18} />
                      <span>尚未加入任何频道</span>
                      <span style={{ fontSize: 12 }}>
                        在上方选择频道加入，或在群聊中直接 @{agent.name}
                      </span>
                    </div>
                  ) : (
                    agent.channels.map((ch) => (
                      <div key={ch.channelId} className={styles.row}>
                        <button
                          type="button"
                          onClick={() => onOpenChannel(ch.channelId)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flex: 1,
                            minWidth: 0,
                            background: 'transparent',
                            border: 0,
                            padding: 0,
                            color: 'inherit',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          <HashIcon size={15} />
                          <span
                            className={styles.rowLabel}
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {ch.name}
                          </span>
                          <ArrowUpRightIcon size={13} />
                        </button>
                        <div className={styles.rowTrailing}>
                          <Switch
                            label="自动响应"
                            checked={ch.autoReply}
                            disabled={busyKey === `autoreply:${ch.channelId}`}
                            onCheckedChange={(checked) =>
                              void handleToggleAutoReply(ch.channelId, checked)
                            }
                          />
                          <IconButton
                            hint="familiar"
                            size="xs"
                            aria-label={`Remove from #${ch.name}`}
                            title="移出频道"
                            icon={<TrashIcon size={14} />}
                            disabled={busyKey === `remove:${ch.channelId}`}
                            onClick={() => void handleRemoveFromChannel(ch.channelId)}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* RUNTIME TAB */}
              {tab === 'runtime' && (
                <>
                  <div className={styles.sectionWrap}>
                    <div className={styles.sectionTitle}>Activity</div>
                    <div className={styles.sectionCard}>
                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <InfoIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Status</span>
                          <span className={styles.rowValue}>
                            {agent.status === 'online'
                              ? 'Connected to local Botmux daemon'
                              : 'Offline'}
                          </span>
                        </div>
                      </div>
                      {primarySession && (
                        <button
                          type="button"
                          className={`${styles.row} ${styles.rowInteractive}`}
                          onClick={() => void handleOpenHistory(primarySession.sessionId)}
                        >
                          <span className={styles.rowIcon}>
                            <ClockIcon size={16} />
                          </span>
                          <span className={styles.rowLabel} style={{ flex: 1 }}>
                            Harness / Session log
                          </span>
                          <span className={styles.rowTrailing}>
                            <span>View</span>
                            <CaretRightIcon size={15} />
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className={styles.sectionWrap}>
                    <div className={styles.sectionTitle}>Agent configuration</div>
                    <div className={styles.sectionCard}>
                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <CpuIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>CLI Harness</span>
                          <span className={styles.rowValue}>{agent.cliId}</span>
                        </div>
                      </div>
                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <FolderSimpleIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Working directory</span>
                          <span className={styles.rowValueMono}>
                            {agent.workingDir || '—'}
                          </span>
                        </div>
                      </div>
                      <div className={styles.row}>
                        <span className={styles.rowIcon}>
                          <WrenchIcon size={16} />
                        </span>
                        <div className={styles.rowBody}>
                          <span className={styles.rowLabel}>Pending approvals</span>
                          <span className={styles.rowValue}>
                            {agent.pendingAsks.length}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={styles.sectionWrap}>
                    <div className={styles.sectionTitle}>
                      Botmux Sessions ({agent.sessions.length})
                    </div>
                    <div className={styles.sectionCard}>
                      {sortedSessions.length === 0 ? (
                        <div className={styles.emptyBlock}>
                          <TerminalWindowIcon size={18} />
                          <span>暂无关联的 Botmux Session</span>
                        </div>
                      ) : (
                        sortedSessions.map((s) => {
                          const st = sessionLifecycleState(s);
                          const isCurrentChannel = Boolean(
                            activeChannelId && s.channelId === activeChannelId,
                          );
                          return (
                          <div key={s.sessionId} className={styles.sessionItem}>
                            <div className={styles.sessionHeader}>
                              <div style={{ minWidth: 0 }}>
                                <div className={styles.rowLabel}>
                                  {s.channelName
                                    ? `#${s.channelName}`
                                    : s.title || s.sessionId}
                                  {isCurrentChannel ? ' · 当前频道' : ''}
                                </div>
                                <div className={styles.rowValueMono}>{s.sessionId}</div>
                              </div>
                              <Badge
                                tone={
                                  st === 'running' || st === 'idle'
                                    ? 'success'
                                    : 'neutral'
                                }
                              >
                                {st}
                              </Badge>
                            </div>
                            <div className={styles.sessionActions}>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  onOpenTerminal(s.sessionId, {
                                    agentId: agent.id,
                                    channelId: s.channelId,
                                  })
                                }
                              >
                                <TerminalWindowIcon size={12} />
                                <span>Terminal</span>
                              </Button>
                              <Button
                                variant="quiet"
                                size="xs"
                                onClick={() => void handleOpenHistory(s.sessionId)}
                              >
                                <ClockIcon size={12} />
                                <span>History</span>
                              </Button>
                              <Button
                                variant="quiet"
                                size="xs"
                                loading={busyKey === `${s.sessionId}:restart`}
                                onClick={() => void handleSessionAction(s.sessionId, 'restart')}
                              >
                                Restart
                              </Button>
                              {st === 'closed' ? (
                                <Button
                                  variant="quiet"
                                  size="xs"
                                  loading={busyKey === `${s.sessionId}:resume`}
                                  onClick={() => void handleSessionAction(s.sessionId, 'resume')}
                                >
                                  Resume
                                </Button>
                              ) : (
                                <Button
                                  variant="quiet"
                                  size="xs"
                                  loading={busyKey === `${s.sessionId}:close`}
                                  onClick={() => void handleSessionAction(s.sessionId, 'close')}
                                >
                                  Close
                                </Button>
                              )}
                            </div>
                          </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      ) : null}

      {agent && (
        <EditAgentDialog
          open={editOpen}
          agent={agent}
          saving={saving}
          onOpenChange={setEditOpen}
          onSave={handlePatchAgent}
        />
      )}

      {archiveConfirmOpen && (
        <AlertDialog
          title="Archive this agent?"
          description="归档后该 Agent 会从侧边栏常规列表折叠，不会删除 Botmux 会话，你随时可以取消归档。"
          pending={saving}
          onClose={() => setArchiveConfirmOpen(false)}
          actions={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                variant="quiet"
                size="sm"
                disabled={saving}
                onClick={() => setArchiveConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                loading={saving}
                onClick={() => {
                  void handlePatchAgent({ archived: true }).then(() => {
                    setArchiveConfirmOpen(false);
                  });
                }}
              >
                Archive
              </Button>
            </div>
          }
        />
      )}
    </aside>
  );
}
