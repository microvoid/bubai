import { useEffect, useState } from 'react';
import {
  BookIcon,
  CaretDownIcon,
  CaretRightIcon,
  CodeIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  WrenchIcon,
} from '../../design-system/icons/index';
import type { AgentProgressStep, AgentProgressStepKind, MessageCard } from './types';
import styles from './AgentProgressCard.module.css';

function StepKindIcon({ kind }: { kind: AgentProgressStepKind }) {
  switch (kind) {
    case 'read':
      return <BookIcon size={14} aria-hidden="true" className={styles.stepIcon} />;
    case 'shell':
      return <CodeIcon size={14} aria-hidden="true" className={styles.stepIcon} />;
    case 'task':
      return <ListChecksIcon size={14} aria-hidden="true" className={styles.stepIcon} />;
    case 'search':
      return <MagnifyingGlassIcon size={14} aria-hidden="true" className={styles.stepIcon} />;
    case 'edit':
      return <PencilSimpleIcon size={14} aria-hidden="true" className={styles.stepIcon} />;
    case 'web':
      return <GlobeIcon size={14} aria-hidden="true" className={styles.stepIcon} />;
    default:
      return <WrenchIcon size={14} aria-hidden="true" className={styles.stepIcon} />;
  }
}

export interface AgentProgressCardProps {
  card: MessageCard;
}

export function AgentProgressCard({ card }: AgentProgressCardProps) {
  const isRunning = card.status === 'running';
  const progress = card.progress;
  const steps: AgentProgressStep[] = progress?.steps ?? [];
  const toolCount = progress?.toolCount ?? steps.length;
  const hasSteps = steps.length > 0 || toolCount > 0;

  // Expanded by default while running so live steps stream in; auto-collapse once settled.
  const [expanded, setExpanded] = useState(isRunning);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (!userToggled) {
      setExpanded(isRunning);
    }
  }, [isRunning, userToggled]);

  if (!isRunning && !hasSteps) {
    return null;
  }

  const headerLabel = isRunning
    ? progress?.activeLabel || card.title || '正在执行…'
    : card.status === 'failed'
      ? '执行失败'
      : '已完成';

  const handleToggle = () => {
    setUserToggled(true);
    setExpanded((prev) => !prev);
  };

  return (
    <div className={styles.root} data-running={isRunning || undefined}>
      {isRunning && (
        <button
          type="button"
          className={styles.statusHeader}
          onClick={handleToggle}
          aria-expanded={expanded}
        >
          <span className={styles.liveDot} aria-hidden="true" />
          <span className={styles.statusText}>{headerLabel}</span>
          {hasSteps && (
            expanded
              ? <CaretDownIcon size={13} aria-hidden="true" className={styles.chevron} />
              : <CaretRightIcon size={13} aria-hidden="true" className={styles.chevron} />
          )}
        </button>
      )}

      {hasSteps && (
        <div className={styles.toolSection}>
          <button
            type="button"
            className={styles.toolSummaryBtn}
            onClick={handleToggle}
            aria-expanded={expanded}
          >
            <WrenchIcon size={13} aria-hidden="true" className={styles.summaryIcon} />
            <span>
              {!isRunning ? `${headerLabel} · ` : ''}已调用 {toolCount} 次工具
            </span>
            {expanded
              ? <CaretDownIcon size={12} aria-hidden="true" className={styles.chevron} />
              : <CaretRightIcon size={12} aria-hidden="true" className={styles.chevron} />}
          </button>

          {expanded && steps.length > 0 && (
            <ul className={styles.stepList}>
              {steps.map((step) => (
                <li
                  key={step.id}
                  className={styles.stepItem}
                  data-status={step.status}
                  title={step.detail || step.label}
                >
                  <StepKindIcon kind={step.kind} />
                  <span className={styles.stepLabel}>{step.label}</span>
                  {step.status === 'running' && (
                    <span className={styles.stepSpinner} aria-hidden="true" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
