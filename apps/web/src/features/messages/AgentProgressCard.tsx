import { useEffect, useState } from 'react';
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  ClockIcon,
  StopIcon,
  TerminalWindowIcon,
  XIcon,
} from '../../design-system/icons/index';
import type {
  AgentProgressStep,
  AgentProgressStepKind,
  MessageCard,
  MessageCardStatus,
} from './types';
import styles from './AgentProgressCard.module.css';

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

function runningVerbForStep(step?: AgentProgressStep): string {
  if (!step) return '正在执行';
  switch (step.kind) {
    case 'shell':
      return '正在运行命令';
    case 'read':
      return '正在读取文件';
    case 'edit':
      return '正在修改文件';
    case 'search':
      return '正在搜索代码';
    case 'web':
      return '正在联网查询';
    case 'task':
      return '正在处理子任务';
    default: {
      const normalized = step.label.toLowerCase();
      if (normalized.includes('exec') || normalized.includes('shell') || normalized.includes('command')) {
        return '正在运行命令';
      }
      if (normalized.includes('read') || normalized.includes('open')) return '正在读取文件';
      if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) {
        return '正在修改文件';
      }
      if (normalized.includes('search') || normalized.includes('grep') || normalized.includes('find')) {
        return '正在搜索代码';
      }
      if (normalized.includes('web') || normalized.includes('fetch')) return '正在联网查询';
      return '正在调用工具';
    }
  }
}

function stepVerb(kind: AgentProgressStepKind, label: string): string {
  switch (kind) {
    case 'shell':
      return '运行命令';
    case 'read':
      return '读取文件';
    case 'edit':
      return '修改文件';
    case 'search':
      return '搜索代码';
    case 'web':
      return '联网查询';
    case 'task':
      return '子任务';
    default: {
      const lower = label.toLowerCase();
      if (lower.includes('exec') || lower.includes('shell') || lower.includes('command')) return '运行命令';
      if (lower.includes('read') || lower.includes('open')) return '读取文件';
      if (lower.includes('edit') || lower.includes('write') || lower.includes('patch')) return '修改文件';
      if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) return '搜索代码';
      if (lower.includes('web') || lower.includes('fetch')) return '联网查询';
      return '调用工具';
    }
  }
}

function stepPreview(step: AgentProgressStep): string {
  const raw = (step.detail || step.label || '').trim();
  const stripped = raw
    .replace(/^(?:读取|编辑|修改|搜索|检索|调用|运行|执行)\s+/u, '')
    .trim();
  return stripped || raw;
}

function isAbnormalStatus(status: MessageCardStatus): boolean {
  return (
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'timeout' ||
    status === 'dispatch_failed'
  );
}

export interface AgentProgressCardProps {
  card: MessageCard;
  createdAt?: number;
  sessionId?: string;
  onOpenTerminal?: (sessionId: string) => void;
  hasContent?: boolean;
}

export function AgentProgressCard({
  card,
  createdAt,
  sessionId,
  onOpenTerminal,
  hasContent = false,
}: AgentProgressCardProps) {
  const status = card.status;
  const isRunning = status === 'running';
  const progress = card.progress;
  const steps: AgentProgressStep[] = progress?.steps ?? [];
  const toolCount = progress?.toolCount ?? steps.length;
  const hasSteps = steps.length > 0;
  const hasTools = toolCount > 0 || hasSteps;

  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick elapsed duration every second while running.
  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  // Auto-collapse once settled if it was expanded during execution.
  useEffect(() => {
    if (!isRunning) {
      setExpanded(false);
    }
  }, [isRunning]);

  // Pure text completed reply (0 tools): hide status bar completely so it matches a normal bubble.
  if (status === 'completed' && !hasTools) {
    return null;
  }

  const startedAt = card.startedAt ?? createdAt;
  const endedAt = isRunning ? now : (card.finishedAt ?? progress?.updatedAt);
  const elapsedText =
    startedAt && endedAt ? formatElapsed(Math.max(0, endedAt - startedAt)) : undefined;

  const activeStep =
    [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];

  let primaryText = '';
  let tone: 'running' | 'connecting' | 'completed' | 'danger' | 'warning' | 'muted' = 'completed';

  if (isRunning) {
    if (hasTools) {
      primaryText = runningVerbForStep(activeStep);
      tone = 'running';
    } else if (card.phase === 'connecting') {
      primaryText = '连接中';
      tone = 'connecting';
    } else {
      primaryText = '思考中';
      tone = 'running';
    }
  } else if (status === 'completed') {
    primaryText = '已完成';
    tone = 'completed';
  } else if (status === 'dispatch_failed') {
    primaryText = '派发失败';
    tone = 'danger';
  } else if (status === 'failed') {
    primaryText = '执行失败';
    tone = 'danger';
  } else if (status === 'interrupted') {
    primaryText = '已中断';
    tone = 'warning';
  } else if (status === 'timeout') {
    primaryText = '响应超时';
    tone = 'warning';
  } else if (status === 'waiting_approval') {
    primaryText = '等待确认';
    tone = 'warning';
  }

  const metaParts: string[] = [];
  if (status !== 'dispatch_failed' && hasTools) {
    metaParts.push(`${toolCount} 次工具`);
  }
  if (status !== 'dispatch_failed' && elapsedText) {
    metaParts.push(elapsedText);
  }
  if (isRunning && !hasTools && card.parallel) {
    metaParts.push('并行会话');
  }

  const canExpand = status !== 'dispatch_failed' && hasSteps;
  const showTerminalAction = status === 'timeout' && Boolean(sessionId && onOpenTerminal);

  const renderStatusGlyph = () => {
    if (tone === 'connecting') {
      return <span className={styles.connectingDot} aria-hidden="true" />;
    }
    if (tone === 'running') {
      return <span className={styles.liveDot} aria-hidden="true" />;
    }
    if (status === 'completed') {
      return <CheckIcon size={13} aria-hidden="true" className={styles.statusIcon} />;
    }
    if (status === 'failed' || status === 'dispatch_failed') {
      return <XIcon size={13} aria-hidden="true" className={styles.statusIcon} />;
    }
    if (status === 'interrupted') {
      return <StopIcon size={13} aria-hidden="true" className={styles.statusIcon} />;
    }
    if (status === 'timeout') {
      return <ClockIcon size={13} aria-hidden="true" className={styles.statusIcon} />;
    }
    return <span className={styles.liveDot} aria-hidden="true" />;
  };

  const barInner = (
    <>
      {renderStatusGlyph()}
      <span className={styles.primaryLabel}>{primaryText}</span>
      {metaParts.length > 0 && (
        <span className={styles.metaText}>
          {metaParts.map((part, idx) => (
            <span key={idx} className={styles.metaPart}>
              <span className={styles.metaSep} aria-hidden="true">·</span>
              <span>{part}</span>
            </span>
          ))}
        </span>
      )}
      {canExpand && (
        expanded
          ? <CaretDownIcon size={12} aria-hidden="true" className={styles.chevron} />
          : <CaretRightIcon size={12} aria-hidden="true" className={styles.chevron} />
      )}
    </>
  );

  return (
    <div
      className={styles.root}
      data-tone={tone}
      data-compact={!hasContent && !expanded ? '' : undefined}
      data-abnormal={isAbnormalStatus(status) ? '' : undefined}
    >
      <div className={styles.headerRow}>
        {canExpand ? (
          <button
            type="button"
            className={styles.statusBarBtn}
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
          >
            {barInner}
          </button>
        ) : (
          <div className={styles.statusBarStatic}>{barInner}</div>
        )}

        {showTerminalAction && sessionId && onOpenTerminal && (
          <button
            type="button"
            className={styles.terminalBtn}
            onClick={() => onOpenTerminal(sessionId)}
          >
            <TerminalWindowIcon size={12} aria-hidden="true" />
            <span>查看终端</span>
          </button>
        )}
      </div>

      {canExpand && expanded && (
        <ul className={styles.stepList}>
          {steps.map((step) => (
            <li
              key={step.id}
              className={styles.stepItem}
              data-status={step.status}
              title={step.detail || step.label}
            >
              <span className={styles.stepMark} aria-hidden="true">
                {step.status === 'running' ? (
                  <span className={styles.stepLiveDot} />
                ) : step.status === 'failed' ? (
                  <XIcon size={12} />
                ) : (
                  <CheckIcon size={12} />
                )}
              </span>
              <span className={styles.stepVerb}>{stepVerb(step.kind, step.label)}</span>
              <span className={styles.stepDetail}>{stepPreview(step)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
