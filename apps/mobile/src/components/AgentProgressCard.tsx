import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { buzzTypography } from '@buzz-botmux/design-tokens';
import type { AgentProgressStep, AgentProgressStepKind, MessageCard } from '@buzz-botmux/chat-client';
import { useBuzzTheme } from '../theme/ThemeProvider';

function stepIconName(kind: AgentProgressStepKind): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case 'read':
      return 'book-outline';
    case 'shell':
      return 'code-slash-outline';
    case 'task':
      return 'checkbox-outline';
    case 'search':
      return 'search-outline';
    case 'edit':
      return 'create-outline';
    case 'web':
      return 'globe-outline';
    default:
      return 'construct-outline';
  }
}

export interface AgentProgressCardProps {
  card: MessageCard;
  textColor: string;
}

export function AgentProgressCard({ card, textColor }: AgentProgressCardProps) {
  const { colors, accent } = useBuzzTheme();
  const isRunning = card.status === 'running';
  const progress = card.progress;
  const steps: AgentProgressStep[] = progress?.steps ?? [];
  const toolCount = progress?.toolCount ?? steps.length;
  const hasSteps = steps.length > 0 || toolCount > 0;

  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isRunning || !card.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [card.startedAt, isRunning]);

  const [expanded, setExpanded] = useState(isRunning);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (!isRunning || !userToggled) {
      setExpanded(isRunning);
    }
  }, [isRunning, userToggled]);

  const isAbnormal =
    card.status === 'failed' ||
    card.status === 'interrupted' ||
    card.status === 'timeout' ||
    card.status === 'dispatch_failed';

  if (!isRunning && !isAbnormal && !hasSteps) return null;

  const headerLabel = isRunning
    ? progress?.activeLabel || (card.phase === 'connecting' ? '连接中' : '思考中')
    : card.status === 'dispatch_failed'
      ? '派发失败'
      : card.status === 'failed'
        ? '执行失败'
        : card.status === 'interrupted'
          ? '已中断'
          : card.status === 'timeout'
            ? '响应超时'
            : '已完成';

  const mutedColor = colors.onSurfaceVariant;
  const toggle = () => {
    setUserToggled(true);
    setExpanded((prev) => !prev);
  };

  return (
    <View style={[styles.root, isRunning && styles.rootRunning]}>
      {(isRunning || isAbnormal) && (
        <Pressable onPress={toggle} style={styles.statusRow} hitSlop={6}>
          <View style={[styles.liveDot, { backgroundColor: accent.fill }]} />
          <Text style={[buzzTypography.body, styles.statusText, { color: textColor }]} numberOfLines={1}>
            {headerLabel}{card.parallel ? ' · 并行' : ''}
            {card.startedAt ? ` · ${Math.max(0, Math.floor(((card.finishedAt ?? now) - card.startedAt) / 1000))}s` : ''}
          </Text>
          {hasSteps && (
            <Ionicons
              name={expanded ? 'chevron-down' : 'chevron-forward'}
              size={14}
              color={mutedColor}
            />
          )}
        </Pressable>
      )}

      {isAbnormal && card.summary && <Text style={{ color: colors.error }}>{card.summary}</Text>}
      {hasSteps && (
        <View style={styles.toolBlock}>
          <Pressable onPress={toggle} style={styles.summaryRow} hitSlop={6}>
            <Ionicons name="construct-outline" size={13} color={mutedColor} />
            <Text style={[buzzTypography.caption, { color: mutedColor }]}>
              {!isRunning ? `${headerLabel} · ` : ''}已调用 {toolCount} 次工具
            </Text>
            <Ionicons
              name={expanded ? 'chevron-down' : 'chevron-forward'}
              size={13}
              color={mutedColor}
            />
          </Pressable>

          {expanded && steps.length > 0 && (
            <View style={styles.stepList}>
              {steps.map((step) => {
                const stepColor =
                  step.status === 'failed'
                    ? colors.error
                    : step.status === 'running'
                      ? textColor
                      : mutedColor;
                return (
                  <View key={step.id} style={styles.stepRow}>
                    <Ionicons
                      name={stepIconName(step.kind)}
                      size={14}
                      color={stepColor}
                      style={styles.stepIcon}
                    />
                    <Text
                      style={[buzzTypography.caption, styles.stepLabel, { color: stepColor }]}
                      numberOfLines={1}
                    >
                      {step.label}
                    </Text>
                    {step.status === 'running' && (
                      <View style={[styles.liveDot, { backgroundColor: accent.fill }]} />
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 6,
    marginBottom: 6,
  },
  rootRunning: {
    marginBottom: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  toolBlock: {
    gap: 6,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 1,
  },
  stepList: {
    gap: 6,
    paddingLeft: 2,
    paddingTop: 2,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  stepIcon: {
    opacity: 0.85,
  },
  stepLabel: {
    flex: 1,
    fontSize: 13,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
