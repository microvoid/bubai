import { useState } from 'react';
import { Avatar } from '../../design-system/ui/Avatar';
import { Badge } from '../../design-system/ui/Badge';
import { IconButton } from '../../design-system/ui/IconButton';
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from '../../design-system/ui/Menu';
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  CaretDownIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  DotsThreeIcon,
  PlayIcon,
  StopIcon,
  TerminalWindowIcon,
  XIcon,
} from '../../design-system/icons/index';
import styles from './TerminalPane.module.css';

export interface TerminalSessionOption {
  sessionId: string;
  label: string;
  state: string;
  workingDir?: string;
}

export interface TerminalPaneProps {
  sessionId: string;
  agent?: {
    id: string;
    name: string;
    avatarUrl?: string;
    cliId?: string;
    status: 'online' | 'offline';
    workingDir?: string;
  };
  sessionLabel?: string;
  sessionState?: string;
  workingDir?: string;
  siblingSessions: readonly TerminalSessionOption[];
  terminalUrl: string | null;
  terminalLinkLoaded: boolean;
  historyContent: string | null;
  showingHistory: boolean;
  actionBusy: string | null;
  expanded: boolean;
  canReturnToProfile: boolean;
  onReturnToProfile?: () => void;
  onOpenAgentProfile?: (agentId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSessionAction: (op: 'resume' | 'restart' | 'close') => void;
  onToggleHistory: () => void;
  onToggleExpand: () => void;
  onClose: () => void;
}

export function TerminalPane({
  sessionId,
  agent,
  sessionLabel,
  sessionState = 'active',
  workingDir,
  siblingSessions,
  terminalUrl,
  terminalLinkLoaded,
  historyContent,
  showingHistory,
  actionBusy,
  expanded,
  canReturnToProfile,
  onReturnToProfile,
  onOpenAgentProfile,
  onSelectSession,
  onSessionAction,
  onToggleHistory,
  onToggleExpand,
  onClose,
}: TerminalPaneProps) {
  const [copied, setCopied] = useState(false);

  const normalizedState = sessionState.toLowerCase();
  const isLive = normalizedState !== 'closed' && normalizedState !== 'offline';
  const shortId = sessionId.slice(0, 8);
  const displayLabel = sessionLabel || shortId;
  const effectiveWorkingDir = workingDir || agent?.workingDir;

  const handleCopySessionId = () => {
    void navigator.clipboard?.writeText(sessionId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <aside className={styles.pane} aria-label="Terminal">
      {/* Semantic Top Bar */}
      <header className={styles.header}>
        <div className={styles.identity}>
          {canReturnToProfile && onReturnToProfile && (
            <IconButton
              hint="familiar"
              size="sm"
              aria-label="返回 Agent 资料页"
              title="返回 Agent 资料页"
              icon={<ArrowLeftIcon size={15} />}
              onClick={onReturnToProfile}
            />
          )}

          {agent ? (
            <button
              type="button"
              className={styles.agentNameBtn}
              onClick={() => onOpenAgentProfile?.(agent.id)}
              title={`查看 ${agent.name} 资料`}
            >
              <Avatar
                src={agent.avatarUrl}
                alt={agent.name}
                fallback={agent.name}
                size="tiny"
                shape="squircle"
                statusBadge={agent.status === 'online' ? 'online' : 'offline'}
              />
              <span className={styles.agentName}>{agent.name}</span>
            </button>
          ) : (
            <div className={styles.titleStack}>
              <TerminalWindowIcon size={16} />
              <span className={styles.agentName}>Terminal</span>
            </div>
          )}

          {siblingSessions.length > 1 ? (
            <MenuRoot>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className={styles.sessionSwitcher}
                    title="切换该 Agent 的其他会话"
                  >
                    <span className={styles.sessionSwitcherLabel}>{displayLabel}</span>
                    <CaretDownIcon size={12} />
                  </button>
                }
              />
              <MenuPopup size="compact" align="start" sideOffset={6}>
                {siblingSessions.map((opt) => (
                  <MenuItem
                    key={opt.sessionId}
                    onClick={() => onSelectSession(opt.sessionId)}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {opt.label}
                    </span>
                    {opt.sessionId === sessionId && <CheckIcon size={14} />}
                  </MenuItem>
                ))}
              </MenuPopup>
            </MenuRoot>
          ) : (
            <span className={styles.sessionPillStatic} title={sessionId}>
              {displayLabel}
            </span>
          )}

          {agent?.cliId && <Badge size="xs">{agent.cliId}</Badge>}
        </div>

        <div className={styles.actions}>
          <IconButton
            hint="familiar"
            size="sm"
            aria-label={showingHistory ? '返回实时终端' : '查看会话历史'}
            title={showingHistory ? '返回实时终端' : '查看会话历史'}
            icon={showingHistory ? <TerminalWindowIcon size={15} /> : <ClockIcon size={15} />}
            onClick={onToggleHistory}
          />
          <IconButton
            hint="familiar"
            size="sm"
            aria-label="重启会话"
            title="重启会话"
            disabled={actionBusy !== null}
            icon={<ArrowsClockwiseIcon size={15} />}
            onClick={() => onSessionAction('restart')}
          />
          <IconButton
            hint="familiar"
            size="sm"
            aria-label={expanded ? '恢复标准宽度' : '宽屏查看'}
            title={expanded ? '恢复标准宽度' : '宽屏查看'}
            icon={expanded ? <ArrowsInIcon size={15} /> : <ArrowsOutIcon size={15} />}
            onClick={onToggleExpand}
          />

          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  hint="familiar"
                  size="sm"
                  aria-label="更多操作"
                  title="更多操作"
                  icon={<DotsThreeIcon size={16} />}
                />
              }
            />
            <MenuPopup size="compact" align="end" sideOffset={6}>
              <MenuItem
                disabled={actionBusy !== null}
                onClick={() => onSessionAction('resume')}
              >
                <PlayIcon size={14} />
                <span>Resume session</span>
              </MenuItem>
              <MenuItem
                disabled={actionBusy !== null}
                onClick={() => onSessionAction('restart')}
              >
                <ArrowsClockwiseIcon size={14} />
                <span>Restart session</span>
              </MenuItem>
              <MenuItem onClick={handleCopySessionId}>
                <CopyIcon size={14} />
                <span>Copy Session ID</span>
              </MenuItem>
              <MenuItem
                tone="danger"
                disabled={actionBusy !== null}
                onClick={() => onSessionAction('close')}
              >
                <StopIcon size={14} />
                <span>Close session</span>
              </MenuItem>
            </MenuPopup>
          </MenuRoot>

          <IconButton
            hint="familiar"
            size="sm"
            aria-label="关闭终端"
            title="关闭终端"
            icon={<XIcon size={16} />}
            onClick={onClose}
          />
        </div>
      </header>

      {/* Inset Framed Terminal Container */}
      <div className={styles.stage}>
        <div className={styles.frame}>
          <div className={styles.viewport}>
            {showingHistory ? (
              <pre className={styles.historyPre}>
                {historyContent ?? 'Loading session history…'}
              </pre>
            ) : terminalUrl ? (
              <iframe
                src={terminalUrl}
                title={`${agent?.name || 'Terminal'} · ${displayLabel}`}
                className={styles.iframe}
              />
            ) : (
              <div className={styles.placeholder}>
                <TerminalWindowIcon size={22} />
                <span>
                  {terminalLinkLoaded
                    ? '当前 Botmux 会话的终端不可用。'
                    : '正在连接 Botmux 原生终端…'}
                </span>
              </div>
            )}
          </div>

          <footer className={styles.statusBar}>
            <div className={styles.statusLeft}>
              <span className={styles.statusIndicator}>
                <span
                  className={`${styles.statusDot} ${isLive ? styles.statusDotLive : ''}`}
                />
                <span>{actionBusy ? `${actionBusy}…` : sessionState}</span>
              </span>
              {effectiveWorkingDir && (
                <span className={styles.workingDir} title={effectiveWorkingDir}>
                  {effectiveWorkingDir}
                </span>
              )}
            </div>
            <button
              type="button"
              className={styles.sessionIdBtn}
              onClick={handleCopySessionId}
              title={`点击复制完整 Session ID: ${sessionId}`}
            >
              {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
              <span>{copied ? 'Copied' : shortId}</span>
            </button>
          </footer>
        </div>
      </div>
    </aside>
  );
}
