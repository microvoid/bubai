/**
 * DayDivider, MessageTimestamp, and MessageTimestampHint ported from
 * references/buzz-app/src/features/messages/MessageTimestamp.tsx.
 */
import type { ReactNode } from 'react';
import { Tooltip } from '../../design-system/ui/Tooltip';
import {
  formatCompactTime,
  formatDayGroupLabel,
  formatFullTimestamp,
  formatItemTimestamp,
  toUnixSeconds,
} from '../../shared/datetime';
import { useClockPreference } from '../../shared/clock-preference';
import { useLocalDay } from '../../shared/use-local-day';
import styles from './Messages.module.css';

export function DayDivider({ createdAt }: { createdAt: number }) {
  useLocalDay();
  const unixSec = toUnixSeconds(createdAt);
  const date = new Date(unixSec * 1000);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  return (
    <div className={styles.day}>
      <span className={styles.dayLabel}>
        <span className={styles.dayCalendar} aria-hidden="true">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="#fff" />
            <path
              d="M6 .5h12a5.5 5.5 0 0 1 5.5 5.5v1H.5V6A5.5 5.5 0 0 1 6 .5Z"
              fill="#f00"
            />
            <rect
              x="0.5"
              y="0.5"
              width="23"
              height="23"
              rx="5.5"
              fill="none"
              stroke="var(--border-standard)"
              strokeWidth="0.5"
            />
          </svg>
          <span
            data-calendar-date=""
            style={{ color: '#111', fontSize: 'calc(var(--space-5) / 2)' }}
          >
            {date.getDate()}
          </span>
        </span>
        <span data-day={day}>{formatDayGroupLabel(unixSec)}</span>
      </span>
    </div>
  );
}

export function MessageTimestamp({
  createdAt,
  visible = true,
  compact = false,
}: {
  createdAt: number;
  visible?: boolean;
  compact?: boolean;
}) {
  useLocalDay();
  useClockPreference();
  const unixSec = toUnixSeconds(createdAt);
  const date = new Date(unixSec * 1000);
  const fullDate = formatFullTimestamp(unixSec);
  const accessible = <span className="sr-only select-none">{fullDate}</span>;
  if (!visible) return <time dateTime={date.toISOString()}>{accessible}</time>;
  return (
    <Tooltip content={fullDate} disableHoverablePopup>
      <time dateTime={date.toISOString()} style={{ cursor: 'default' }}>
        <span aria-hidden="true">
          {compact
            ? formatCompactTime(unixSec)
            : formatItemTimestamp(unixSec, { withTime: true })}
        </span>
        {accessible}
      </time>
    </Tooltip>
  );
}

export function MessageTimestampHint({
  createdAt,
  attachments = false,
  children,
}: {
  createdAt: number | undefined;
  attachments?: boolean;
  children: ReactNode;
}) {
  useLocalDay();
  useClockPreference();
  const unixSec = createdAt !== undefined ? toUnixSeconds(createdAt) : undefined;
  return (
    <div
      className={styles.messagePayload}
      data-message-payload=""
      data-attachments={attachments || undefined}
    >
      {children}
      {unixSec !== undefined && (
        <time
          dateTime={new Date(unixSec * 1000).toISOString()}
          className="sr-only select-none"
        >
          {formatFullTimestamp(unixSec)}
        </time>
      )}
    </div>
  );
}
