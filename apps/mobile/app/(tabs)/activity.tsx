import { useActivity } from '@/store/useActivity';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BuzzBadge, BuzzFilterPill, BuzzSectionGroup } from '@/components/BuzzComponents';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function ActivityScreen() {
  const router = useRouter();
  const { colors } = useBuzzTheme();
  const { asks, sessions, answerAsk, refreshBootstrap } = useBubai();
  const [filter, setFilter] = useState<'all' | 'mention' | 'thread'>('all');
  const activity = useActivity();
  const [busyAskId, setBusyAskId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshBootstrap(), activity.refetch()]);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAnswer = async (ask: (typeof asks)[number], key: string) => {
    setBusyAskId(ask.askId);
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await answerAsk(ask, key);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } finally {
      setBusyAskId(null);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      <View style={styles.topBar}>
        <Text style={[buzzTypography.largeTitle, { color: colors.onSurface }]}>Activity</Text>
        {asks.length > 0 && <BuzzBadge label={`${asks.length} Pending`} tone="danger" />}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.onSurfaceVariant}
          />
        }
      >
        <View style={{ flexDirection: 'row', gap: 16 }}>
          {(['all', 'mention', 'thread'] as const).map((kind, index) => (
            <BuzzFilterPill key={kind} selected={filter === kind} onPress={() => setFilter(kind)}
              label={['All', '@Mentions', 'Threads'][index]} />
          ))}
        </View>
        {activity.error && <Text style={{ color: colors.error }}>{activity.error.message}</Text>}
        {activity.data?.items.filter(item => filter === 'all' || item.kind === filter).map(item => (
          <Pressable key={item.id} style={styles.askItem} onPress={() => router.push(item.threadId
            ? `/thread/${encodeURIComponent(item.channelId)}/${encodeURIComponent(item.threadId)}?messageId=${encodeURIComponent(item.messageId)}`
            : `/channel/${encodeURIComponent(item.channelId)}?messageId=${encodeURIComponent(item.messageId)}`)}>
            <Text style={{ color: colors.onSurface }}>{item.channelName} · {item.senderName} · {item.unreadCount}</Text>
            <Text style={{ color: colors.onSurfaceVariant }}>{item.excerpt}</Text>
          </Pressable>
        ))}
        <BuzzSectionGroup title={`Pending Approvals (${asks.length})`}>
          {asks.length === 0 ? (
            <View style={styles.emptyRow}>
              <Ionicons name="checkmark-circle-outline" size={20} color={colors.success} />
              <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                当前没有等待你确认的 Botmux 审批项
              </Text>
            </View>
          ) : (
            asks.map((ask, idx) => {
              const firstQ = ask.questions?.[0];
              const options = firstQ?.options || [
                { key: 'approve', label: '批准' },
                { key: 'reject', label: '拒绝' },
              ];
              return (
                <View
                  key={ask.askId}
                  style={[
                    styles.askItem,
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.outline,
                    },
                  ]}
                >
                  <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                    {ask.botName || ask.larkAppId}
                  </Text>
                  <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                    {firstQ?.question || ask.prompt || ask.title || ask.askId}
                  </Text>
                  <View style={styles.askActions}>
                    {options.map((opt) => (
                      <Pressable
                        key={opt.key}
                        disabled={busyAskId === ask.askId}
                        onPress={() => void handleAnswer(ask, opt.key)}
                        style={({ pressed }) => [
                          styles.askBtn,
                          {
                            backgroundColor: colors.primary,
                            opacity: busyAskId === ask.askId ? 0.5 : pressed ? 0.8 : 1,
                          },
                        ]}
                      >
                        <Text style={[buzzTypography.label, { color: colors.onPrimary }]}>
                          {opt.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              );
            })
          )}
        </BuzzSectionGroup>

        <BuzzSectionGroup title={`Live Botmux Sessions (${sessions.length})`}>
          {sessions.length === 0 ? (
            <View style={styles.emptyRow}>
              <Ionicons name="terminal-outline" size={18} color={colors.onSurfaceVariant} />
              <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                暂无活跃的 Botmux 会话
              </Text>
            </View>
          ) : (
            sessions.map((s, idx) => {
              const state = s.state || s.status || 'active';
              const isLive = state !== 'closed' && state !== 'offline';
              return (
                <Pressable
                  key={s.sessionId}
                  onPress={() =>
                    router.push(
                      `/terminal/${encodeURIComponent(s.sessionId)}${s.larkAppId ? `?agentId=${encodeURIComponent(s.larkAppId)}` : ''}`,
                    )
                  }
                  style={[
                    styles.sessionRow,
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.outline,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text
                      style={[buzzTypography.titleSmall, { color: colors.onSurface }]}
                      numberOfLines={1}
                    >
                      {s.botName || s.larkAppId || 'Agent'} · {s.title || s.sessionId.slice(0, 8)}
                    </Text>
                    <Text
                      style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                      numberOfLines={1}
                    >
                      {s.workingDir || s.sessionId}
                    </Text>
                  </View>
                  <BuzzBadge label={state} tone={isLive ? 'success' : 'neutral'} />
                </Pressable>
              );
            })
          )}
        </BuzzSectionGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: buzzGrid.gutter,
    paddingTop: buzzGrid.xxs,
    paddingBottom: buzzGrid.twelve,
  },
  content: {
    paddingHorizontal: buzzGrid.gutter,
    paddingBottom: buzzGrid.md,
    gap: buzzGrid.sm,
  },
  emptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
  },
  askItem: {
    padding: 14,
    gap: 8,
  },
  askActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  askBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: buzzRadii.pill,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});
