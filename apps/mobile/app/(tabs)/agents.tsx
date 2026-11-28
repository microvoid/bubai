import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import type { Participant } from '@buzz-botmux/chat-client';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BuzzAvatar } from '@/components/BuzzAvatar';
import { BuzzBadge } from '@/components/BuzzComponents';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

/**
 * Buzz Mobile Agent Directory (aligned with references/buzz/mobile/lib/features/agents/agent_card.dart)
 */
export default function AgentsScreen() {
  const router = useRouter();
  const { colors } = useBuzzTheme();
  const { participants, sessions, refreshBootstrap } = useBubai();
  const [showArchived, setShowArchived] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const agents = useMemo(
    () => participants.filter((p) => p.role === 'agent'),
    [participants],
  );
  const activeAgents = useMemo(() => agents.filter((a) => !a.archived), [agents]);
  const archivedAgents = useMemo(() => agents.filter((a) => a.archived), [agents]);
  const visibleAgents = showArchived ? [...activeAgents, ...archivedAgents] : activeAgents;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshBootstrap();
    } finally {
      setRefreshing(false);
    }
  };

  const handleOpenAgent = (agent: Participant) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/agent/${encodeURIComponent(agent.id)}`);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['bottom']}>
      <View style={styles.topBar}>
        <Text style={[buzzTypography.largeTitle, { color: colors.onSurface }]}>智能体</Text>
        <BuzzBadge
          label={`${activeAgents.filter((a) => a.status === 'online').length}/${activeAgents.length} Online`}
          tone="success"
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.onSurfaceVariant}
          />
        }
      >
        <View style={styles.grid}>
          {visibleAgents.map((agent) => {
            const sessionCount = sessions.filter((s) => s.larkAppId === agent.id).length;
            return (
              <Pressable
                key={agent.id}
                onPress={() => handleOpenAgent(agent)}
                style={({ pressed }) => [
                  styles.card,
                  {
                    backgroundColor: colors.surfaceContainerLow,
                    borderColor: colors.outline,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <View style={styles.avatarWrap}>
                  <BuzzAvatar
                    name={agent.name}
                    uri={agent.avatarUrl}
                    size={76}
                    isAgent
                    status={agent.status}
                    ringColor={colors.surfaceContainerLow}
                  />
                </View>

                <Text
                  style={[buzzTypography.titleSmall, { color: colors.onSurface, textAlign: 'center' }]}
                  numberOfLines={1}
                >
                  {agent.name}
                </Text>

                <Text
                  style={[
                    buzzTypography.caption,
                    { color: colors.onSurfaceVariant, textAlign: 'center' },
                  ]}
                  numberOfLines={2}
                >
                  {agent.description?.trim() || `${agent.cliId || 'cli'} · ${sessionCount} sessions`}
                </Text>

                <View style={styles.cardFooter}>
                  <BuzzBadge label={agent.cliId || 'cli'} />
                  {agent.archived && <BuzzBadge label="已归档" tone="warning" />}
                </View>
              </Pressable>
            );
          })}
        </View>

        {archivedAgents.length > 0 && (
          <Pressable
            onPress={() => setShowArchived((v) => !v)}
            style={[styles.archiveToggle, { backgroundColor: colors.surfaceContainerLow }]}
          >
            <Ionicons
              name={showArchived ? 'eye-off-outline' : 'archive-outline'}
              size={16}
              color={colors.onSurfaceVariant}
            />
            <Text style={[buzzTypography.label, { color: colors.onSurfaceVariant }]}>
              {showArchived
                ? `隐藏已归档 (${archivedAgents.length})`
                : `查看已归档 (${archivedAgents.length})`}
            </Text>
          </Pressable>
        )}

        {visibleAgents.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="hardware-chip-outline" size={32} color={colors.onSurfaceVariant} />
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
              暂无 Agent
            </Text>
            <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
              可通过 Gateway、Webhook 或 CLI Bridge 接入 Agent
            </Text>
          </View>
        )}
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
  scrollContent: {
    paddingHorizontal: buzzGrid.gutter,
    paddingBottom: buzzGrid.md,
    gap: buzzGrid.xs,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: buzzGrid.twelve,
  },
  card: {
    width: '48%',
    flexGrow: 1,
    minWidth: 150,
    borderRadius: buzzRadii.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: buzzGrid.twelve,
    alignItems: 'center',
    gap: 8,
  },
  avatarWrap: {
    paddingTop: 6,
    paddingBottom: 2,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  archiveToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: buzzRadii.md,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
    gap: 8,
  },
});
