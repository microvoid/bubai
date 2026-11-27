import type { Participant } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import type { Channel } from '@buzz-botmux/chat-client';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BuzzAvatar } from '@/components/BuzzAvatar';
import {
  BuzzConnectionPill,
  BuzzCountBadge,
  BuzzFilterPill,
  BuzzSectionGroup,
} from '@/components/BuzzComponents';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

type FilterMode = 'all' | 'unread' | 'channels' | 'dms';

export default function MessagesScreen() {
  const router = useRouter();
  const { colors } = useBuzzTheme();
  const {
    client,
    currentUserId,
    channels, sidebarGroups,
    participants,
    wsState,
    isLoading,
    error,
    serverUrl,
    refreshBootstrap,
  } = useBubai();
  const [filter, setFilter] = useState<FilterMode>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelTopic, setNewChannelTopic] = useState('');
  const [creating, setCreating] = useState(false);

  const visibleChannels = useMemo(
    () => channels.filter((c) => !c.archived),
    [channels],
  );

  const filtered = useMemo(() => {
    switch (filter) {
      case 'unread':
        return visibleChannels.filter((c) => Boolean(c.unreadCount || c.threadUnreadCount || c.mentionCount || c.markedUnread));
      case 'channels':
        return visibleChannels.filter((c) => c.kind !== 'dm');
      case 'dms':
        return visibleChannels.filter((c) => c.kind === 'dm');
      default:
        return visibleChannels;
    }
  }, [filter, visibleChannels]);

  const regularChannels = useMemo(
    () => filtered.filter((c) => c.kind !== 'dm'),
    [filtered],
  );
  const dmChannels = useMemo(
    () => filtered.filter((c) => c.kind === 'dm'),
    [filtered],
  );
  const unreadCount = useMemo(
    () => visibleChannels.filter((c) => Boolean(c.unreadCount || c.threadUnreadCount || c.mentionCount || c.markedUnread)).length,
    [visibleChannels],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshBootstrap();
    } finally {
      setRefreshing(false);
    }
  };

  const handleOpenChannel = (channel: Channel) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/channel/${encodeURIComponent(channel.id)}`);
  };

  const handleCreateChannel = async () => {
    const name = newChannelName.trim();
    if (!name || !client) return;
    setCreating(true);
    try {
      const { channel } = await client.createChannel({
        name,
        topic: newChannelTopic.trim() || undefined,
        userId: currentUserId,
      });
      setNewChannelName('');
      setNewChannelTopic('');
      setCreateOpen(false);
      await refreshBootstrap();
      router.push(`/channel/${encodeURIComponent(channel.id)}`);
    } catch (err) {
      Alert.alert('创建频道失败', err instanceof Error ? err.message : '操作失败');
    } finally {
      setCreating(false);
    }
  };

  const handleStartDm = async (agentId: string, agentName: string, role: Participant['role']) => {
    if (!client) return;
    try {
      const { channel } = await client.openDm({
        userId: currentUserId,
        targetId: agentId,
        targetRole: role,
        targetName: agentName,
      });
      setCreateOpen(false);
      await refreshBootstrap();
      router.push(`/channel/${encodeURIComponent(channel.id)}`);
    } catch (err) {
      Alert.alert('发起私聊失败', err instanceof Error ? err.message : '操作失败');
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      {/* Buzz-style Large Header */}
      <View style={styles.topBar}>
        <Text style={[buzzTypography.largeTitle, { color: colors.onSurface }]}>Messages</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <BuzzConnectionPill
            connected={wsState === 'open'}
            label={
              wsState === 'open'
                ? 'Live'
                : wsState === 'reconnecting'
                  ? 'Reconnecting'
                  : 'Offline'
            }
            onPress={() => router.push('/connect')}
          />
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.push('/search');
            }}
            style={[styles.newBtn, { backgroundColor: colors.surfaceContainerLow }]}
            accessibilityLabel="Search messages"
          >
            <Ionicons name="search" size={18} color={colors.onSurface} />
          </Pressable>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              setCreateOpen(true);
            }}
            style={[styles.newBtn, { backgroundColor: colors.surfaceContainerLow }]}
            accessibilityLabel="New channel or DM"
          >
            <Ionicons name="add" size={20} color={colors.onSurface} />
          </Pressable>
        </View>
      </View>

      {/* Filter Pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterBar}
        style={styles.filterWrap}
      >
        <BuzzFilterPill label="All" selected={filter === 'all'} onPress={() => setFilter('all')} />
        <BuzzFilterPill
          label="Unread"
          count={unreadCount}
          selected={filter === 'unread'}
          onPress={() => setFilter('unread')}
        />
        <BuzzFilterPill
          label="Channels"
          selected={filter === 'channels'}
          onPress={() => setFilter('channels')}
        />
        <BuzzFilterPill label="DMs" selected={filter === 'dms'} onPress={() => setFilter('dms')} />
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.onSurfaceVariant}
          />
        }
      >
        {error && (
          <TouchableOpacity
            onPress={() => router.push('/connect')}
            style={[
              styles.errorBanner,
              { backgroundColor: colors.errorContainer, borderColor: colors.error },
            ]}
          >
            <Ionicons name="cloud-offline-outline" size={18} color={colors.error} />
            <View style={{ flex: 1 }}>
              <Text style={[buzzTypography.label, { color: colors.onErrorContainer }]}>
                连接失败（{serverUrl}）
              </Text>
              <Text style={[buzzTypography.caption, { color: colors.onErrorContainer }]}>
                {error} · 点击切换服务端地址
              </Text>
            </View>
          </TouchableOpacity>
        )}

        {[{ id: 'starred', name: 'Starred' }, ...sidebarGroups, { id: '', name: 'Channels' }].map(group => {
          const rows = regularChannels.filter(ch => (ch.starred ? 'starred' : ch.groupId || '') === group.id);
          return rows.length > 0 && <BuzzSectionGroup key={group.id} title={group.name}>
            {rows.map((ch, idx) => (
              <TouchableOpacity
                key={ch.id} testID={`channel-row-${ch.name}`}
                onPress={() => handleOpenChannel(ch)}
                style={[
                  styles.row,
                  idx > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.outline,
                  },
                ]}
              >
                <View style={[styles.hashBox, { backgroundColor: colors.surfaceContainer }]}>
                  <Text style={[buzzTypography.titleSmall, { color: colors.onSurfaceVariant }]}>
                    #
                  </Text>
                </View>
                <View style={styles.rowBody}>
                  <Text
                    style={[
                      buzzTypography.titleSmall,
                      {
                        color: colors.onSurface,
                        fontWeight: ch.unreadCount > 0 ? '700' : '600',
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {ch.name}
                  </Text>
                  {!!ch.topic && (
                    <Text
                      style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                      numberOfLines={1}
                    >
                      {ch.topic}
                    </Text>
                  )}
                </View>
                {Boolean(ch.mentionCount) && <Text style={{ color: colors.primary }}>@{ch.mentionCount}</Text>}
                <BuzzCountBadge count={ch.unreadCount + (ch.threadUnreadCount ?? 0) || Number(Boolean(ch.markedUnread))} />
              </TouchableOpacity>
            ))}
          </BuzzSectionGroup>;
        })}

        {dmChannels.length > 0 && (
          <BuzzSectionGroup title="Direct Messages">
            {dmChannels.map((dm, idx) => {
              const targetAgent = participants.find(
                (p) => p.role === 'agent' && dm.dmKey?.includes(`a:${p.id}`),
              );
              const label = targetAgent?.name || dm.topic || dm.name;
              return (
                <TouchableOpacity
                  key={dm.id}
                  onPress={() => handleOpenChannel(dm)}
                  style={[
                    styles.row,
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.outline,
                    },
                  ]}
                >
                  <BuzzAvatar
                    name={label}
                    uri={targetAgent?.avatarUrl}
                    size={38}
                    isAgent={Boolean(targetAgent)}
                    status={targetAgent?.status}
                    ringColor={colors.surfaceContainerLow}
                  />
                  <View style={styles.rowBody}>
                    <Text
                      style={[buzzTypography.titleSmall, { color: colors.onSurface }]}
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                    <Text
                      style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                      numberOfLines={1}
                    >
                      {targetAgent ? `Agent · ${targetAgent.cliId || 'cli'}` : 'Direct message'}
                    </Text>
                  </View>
                  <BuzzCountBadge count={dm.unreadCount} />
                </TouchableOpacity>
              );
            })}
          </BuzzSectionGroup>
        )}

        {!isLoading && !error && regularChannels.length === 0 && dmChannels.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="chatbubble-ellipses-outline" size={30} color={colors.onSurfaceVariant} />
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
              暂无会话
            </Text>
            <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
              下拉刷新或检查过滤条件
            </Text>
          </View>
        )}
      </ScrollView>

      {/* New Channel / Start Agent DM Modal */}
      <Modal
        visible={createOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCreateOpen(false)}
      >
        <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]}>
          <View style={styles.topBar}>
            <Text style={[buzzTypography.title, { color: colors.onSurface }]}>New conversation</Text>
            <Pressable onPress={() => setCreateOpen(false)}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          >
            <BuzzSectionGroup title="Create Channel">
              <View style={{ padding: 14, gap: 10 }}>
                <TextInput
                  value={newChannelName}
                  onChangeText={setNewChannelName}
                  placeholder="Channel name (e.g. mobile-dev)"
                  placeholderTextColor={colors.onSurfaceVariant}
                  style={[
                    styles.modalInput,
                    buzzTypography.body,
                    { backgroundColor: colors.surface, borderColor: colors.outline, color: colors.onSurface },
                  ]}
                />
                <TextInput
                  value={newChannelTopic}
                  onChangeText={setNewChannelTopic}
                  placeholder="Topic (optional)"
                  placeholderTextColor={colors.onSurfaceVariant}
                  style={[
                    styles.modalInput,
                    buzzTypography.body,
                    { backgroundColor: colors.surface, borderColor: colors.outline, color: colors.onSurface },
                  ]}
                />
                <Pressable
                  disabled={creating || !newChannelName.trim()}
                  onPress={() => void handleCreateChannel()}
                  style={[
                    styles.modalPrimaryBtn,
                    {
                      backgroundColor: colors.primary,
                      opacity: creating || !newChannelName.trim() ? 0.5 : 1,
                    },
                  ]}
                >
                  <Text style={[buzzTypography.titleSmall, { color: colors.onPrimary }]}>
                    {creating ? 'Creating…' : 'Create channel'}
                  </Text>
                </Pressable>
              </View>
            </BuzzSectionGroup>

            <BuzzSectionGroup title="Direct Message">
              {participants
                .filter((p) => p.id !== currentUserId && !p.archived)
                .map((agent, idx) => (
                  <TouchableOpacity
                    key={agent.id}
                    onPress={() => void handleStartDm(agent.id, agent.name, agent.role)}
                    style={[
                      styles.row,
                      idx > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.outline,
                      },
                    ]}
                  >
                    <BuzzAvatar
                      name={agent.name}
                      uri={agent.avatarUrl}
                      size={36}
                      isAgent={agent.role === 'agent'}
                      status={agent.status}
                      ringColor={colors.surfaceContainerLow}
                    />
                    <View style={styles.rowBody}>
                      <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                        {agent.name}
                      </Text>
                      <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                        {agent.cliId || agent.role}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.onSurfaceVariant} />
                  </TouchableOpacity>
                ))}
            </BuzzSectionGroup>
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
  newBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalInput: {
    height: 44,
    borderRadius: buzzRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  modalPrimaryBtn: {
    height: 44,
    borderRadius: buzzRadii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  filterWrap: {
    flexGrow: 0,
  },
  filterBar: {
    paddingHorizontal: buzzGrid.gutter,
    paddingBottom: buzzGrid.twelve,
    gap: buzzGrid.xxs,
  },
  listContent: {
    paddingHorizontal: buzzGrid.gutter,
    paddingBottom: buzzGrid.md,
    gap: buzzGrid.inventorySectionTopInset,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: buzzGrid.twelve,
    borderRadius: 16,
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: buzzGrid.inventoryRowInset,
    minHeight: 58,
  },
  hashBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
    gap: 8,
  },
});
