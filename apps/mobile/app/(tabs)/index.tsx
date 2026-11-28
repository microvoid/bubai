import { WorkspaceDock, WorkspaceHeader } from '@/components/WorkspaceControls';
import { unreadCount as rowUnread, visibleUnread } from '@/store/unread';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BuzzAvatar } from '@/components/BuzzAvatar';
import {
  BuzzCountBadge,
  BuzzFilterPill,
  BuzzSectionGroup,
} from '@/components/BuzzComponents';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

type FilterMode = 'all' | 'unread' | 'channels' | 'dms';

export default function MessagesScreen() {
  const insets = useSafeAreaInsets();
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
        return visibleChannels.filter(visibleUnread);
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
    () => visibleChannels.filter(visibleUnread).length,
    [visibleChannels],
  );

  let connectionNotice: string | null = null;
  if (error && channels.length > 0) {
    connectionNotice = wsState === 'open' ? '同步暂时不可用' : '离线 · 显示已缓存的内容';
  } else if (!error && wsState === 'reconnecting') {
    connectionNotice = '实时连接已断开，正在重连';
  }

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
      <WorkspaceHeader />

      {/* Filter Pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterBar}
        style={styles.filterWrap}
      >
        <BuzzFilterPill label="全部" selected={filter === 'all'} onPress={() => setFilter('all')} />
        <BuzzFilterPill
          label="未读"
          count={unreadCount}
          selected={filter === 'unread'}
          onPress={() => setFilter('unread')}
        />
        <BuzzFilterPill
          label="频道"
          selected={filter === 'channels'}
          onPress={() => setFilter('channels')}
        />
        <BuzzFilterPill label="私聊" selected={filter === 'dms'} onPress={() => setFilter('dms')} />
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
        {error && !channels.length && (
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

        {[{ id: 'starred', name: '星标' }, ...sidebarGroups, { id: '', name: '频道' }].map(group => {
          const rows = regularChannels.filter(ch => (ch.starred ? 'starred' : ch.groupId || '') === group.id);
          return rows.length > 0 && <BuzzSectionGroup collapsible key={group.id} title={group.name}>
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
                      buzzTypography.channelTitle,
                      {
                        color: ch.muted ? colors.onSurfaceVariant : colors.onSurface,
                        fontWeight: ch.unreadCount || ch.threadUnreadCount || ch.markedUnread ? '700' : '500',
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
                {ch.muted && <Ionicons accessibilityLabel="已静音" name="volume-mute-outline" size={15} color={colors.onSurfaceVariant} />}
                <BuzzCountBadge count={rowUnread(ch)} />
              </TouchableOpacity>
            ))}
          </BuzzSectionGroup>;
        })}

        {dmChannels.length > 0 && (
          <BuzzSectionGroup collapsible title="私聊">
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
                      style={[buzzTypography.channelTitle, { color: dm.muted ? colors.onSurfaceVariant : colors.onSurface, fontWeight: dm.unreadCount || dm.threadUnreadCount || dm.markedUnread ? '700' : '500' }]}
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                    <Text
                      style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                      numberOfLines={1}
                    >
                      {targetAgent ? `Agent · ${targetAgent.cliId || 'cli'}` : '私聊'}
                    </Text>
                  </View>
                  {dm.muted && <Ionicons accessibilityLabel="已静音" name="volume-mute-outline" size={15} color={colors.onSurfaceVariant} />}
                  <BuzzCountBadge count={rowUnread(dm)} />
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

      {connectionNotice && (
        <Pressable accessibilityRole="button" accessibilityLabel={connectionNotice} onPress={() => router.push('/connect')}
          style={[styles.cachedStatus,{bottom:Math.max(12,insets.bottom)+72,backgroundColor:colors.surfaceContainerHigh}]}>
          <Ionicons name="cloud-offline-outline" size={16} color={colors.onSurfaceVariant}/>
          <Text accessibilityLiveRegion="polite" style={[buzzTypography.caption,{color:colors.onSurfaceVariant}]}>
            {connectionNotice}
          </Text>
        </Pressable>
      )}
      <WorkspaceDock onCreate={()=>setCreateOpen(true)} />

      {/* New Channel / Start Agent DM Modal */}
      <Modal
        visible={createOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCreateOpen(false)}
      >
        <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]}>
          <View style={styles.topBar}>
            <Text style={[buzzTypography.title, { color: colors.onSurface }]}>新建会话</Text>
            <Pressable onPress={() => setCreateOpen(false)}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          >
            <BuzzSectionGroup title="创建频道">
              <View style={{ padding: 14, gap: 10 }}>
                <TextInput
                  value={newChannelName}
                  onChangeText={setNewChannelName}
                  placeholder="频道名称"
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
                  placeholder="主题（选填）"
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
                    {creating ? '正在创建…' : '创建频道'}
                  </Text>
                </Pressable>
              </View>
            </BuzzSectionGroup>

            <BuzzSectionGroup title="发起私聊">
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
    paddingBottom: 110,
    gap: buzzGrid.inventorySectionTopInset,
  },
  cachedStatus: {
    position: 'absolute', alignSelf: 'center', flexDirection: 'row', gap: 6, alignItems: 'center',
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6,
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
