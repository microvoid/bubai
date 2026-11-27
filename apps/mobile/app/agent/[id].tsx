import type { AgentDetail, BotmuxSession } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BuzzAvatar } from '@/components/BuzzAvatar';
import { BuzzBadge, BuzzSectionGroup } from '@/components/BuzzComponents';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

type ProfileTab = 'info' | 'channels' | 'runtime';

function sessionState(s: BotmuxSession): string {
  return (s.state || s.status || 'active').toLowerCase();
}

function sessionScore(s: BotmuxSession): number {
  return s.lastActivityAt ?? s.lastMessageAt ?? s.spawnedAt ?? 0;
}

export default function AgentDetailScreen() {
  const { id: rawId, channelId: rawChannelId } = useLocalSearchParams<{
    id: string;
    channelId?: string;
  }>();
  const agentId = Array.isArray(rawId) ? rawId[0] : rawId || '';
  const activeChannelId = Array.isArray(rawChannelId) ? rawChannelId[0] : rawChannelId;

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, accent } = useBuzzTheme();
  const { client, currentUserId, channels, refreshBootstrap } = useBubai();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ProfileTab>('info');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [saving, setSaving] = useState(false);

  // Instructions modal & History modal & Add-to-channel modal
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [historyModal, setHistoryModal] = useState<{
    sessionId: string;
    loading: boolean;
    content: string | null;
  } | null>(null);
  const [addChannelOpen, setAddChannelOpen] = useState(false);

  const loadAgent = useCallback(async () => {
    if (!client || !agentId) return;
    setError(null);
    try {
      const { agent: detail } = await client.getAgentDetail(agentId, currentUserId);
      setAgent(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 Agent 详情失败');
    } finally {
      setLoading(false);
    }
  }, [agentId, client, currentUserId]);

  useEffect(() => {
    setLoading(true);
    void loadAgent();
  }, [loadAgent]);

  const sortedSessions = useMemo(() => {
    if (!agent) return [];
    const channelSid = activeChannelId
      ? agent.channels.find((c) => c.channelId === activeChannelId)?.sessionId
      : undefined;
    const isCurrent = (s: BotmuxSession) =>
      Boolean(
        activeChannelId &&
          (s.channelId === activeChannelId || (channelSid && s.sessionId === channelSid)),
      );
    return [...agent.sessions].sort((a, b) => {
      const am = isCurrent(a) ? 1 : 0;
      const bm = isCurrent(b) ? 1 : 0;
      if (am !== bm) return bm - am;
      const al = sessionState(a) !== 'closed' && sessionState(a) !== 'offline' ? 1 : 0;
      const bl = sessionState(b) !== 'closed' && sessionState(b) !== 'offline' ? 1 : 0;
      if (al !== bl) return bl - al;
      return sessionScore(b) - sessionScore(a);
    });
  }, [activeChannelId, agent]);

  const primarySession = sortedSessions[0];

  const unjoinedChannels = useMemo(() => {
    if (!agent) return [];
    const joined = new Set(agent.channels.map((c) => c.channelId));
    return channels.filter((c) => c.kind !== 'dm' && !c.archived && !joined.has(c.id));
  }, [agent, channels]);

  const openEdit = () => {
    if (!agent) return;
    setEditName(agent.name);
    setEditDesc(agent.description);
    setEditAvatar(agent.avatarUrl);
    setEditPrompt(agent.systemPrompt);
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!client || !agent) return;
    setSaving(true);
    try {
      const { agent: updated } = await client.updateAgent(agent.id, {
        displayName: editName.trim() || null,
        description: editDesc.trim().slice(0, 280) || null,
        avatarUrl: editAvatar.trim() || null,
        systemPrompt: editPrompt,
      });
      setAgent(updated);
      setEditOpen(false);
      void refreshBootstrap();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleArchive = () => {
    if (!client || !agent) return;
    const nextArchived = !agent.archived;
    const run = async () => {
      setSaving(true);
      try {
        const { agent: updated } = await client.updateAgent(agent.id, { archived: nextArchived });
        setAgent(updated);
        void refreshBootstrap();
      } finally {
        setSaving(false);
      }
    };
    if (nextArchived) {
      Alert.alert('Archive this agent?', '归档后会从常规列表折叠，会保留已有会话，随时可恢复。', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Archive', style: 'destructive', onPress: () => void run() },
      ]);
    } else {
      void run();
    }
  };

  const handleOpenDm = async () => {
    if (!client || !agent) return;
    setBusyKey('dm');
    try {
      const { channel } = await client.openDm({
        userId: currentUserId,
        targetId: agent.id,
        targetRole: 'agent',
        targetName: agent.name,
      });
      void refreshBootstrap();
      router.push(`/channel/${encodeURIComponent(channel.id)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSessionOp = async (sessionId: string, op: 'restart' | 'close' | 'resume') => {
    if (!client) return;
    setBusyKey(`${sessionId}:${op}`);
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await client.sessionAction(sessionId, op);
      await loadAgent();
      void refreshBootstrap();
    } finally {
      setBusyKey(null);
    }
  };

  const handleOpenHistory = async (sessionId: string) => {
    if (!client) return;
    setHistoryModal({ sessionId, loading: true, content: null });
    try {
      const data = await client.getSessionHistory(sessionId);
      setHistoryModal({
        sessionId,
        loading: false,
        content: JSON.stringify(data, null, 2),
      });
    } catch (err) {
      setHistoryModal({
        sessionId,
        loading: false,
        content: err instanceof Error ? err.message : '无法加载会话历史',
      });
    }
  };

  const handleAddToChannel = async (channelId: string) => {
    if (!client || !agent) return;
    setBusyKey(`add:${channelId}`);
    try {
      await client.upsertChannelMember(channelId, { agentId: agent.id, autoReply: false });
      setAddChannelOpen(false);
      await loadAgent();
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleAutoReply = async (channelId: string, enabled: boolean) => {
    if (!client || !agent) return;
    await client.upsertChannelMember(channelId, { agentId: agent.id, autoReply: enabled });
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
  };

  const handleRemoveChannel = async (channelId: string) => {
    if (!client || !agent) return;
    await client.removeChannelMember(channelId, { agentId: agent.id });
    await loadAgent();
  };

  const primaryState = primarySession ? sessionState(primarySession) : 'offline';

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.surface, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      {/* Top Bar */}
      <View style={[styles.header, { borderBottomColor: colors.outline }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}>
          Agent profile
        </Text>
        {agent && (
          <Pressable onPress={openEdit} style={styles.iconBtn} hitSlop={6}>
            <Ionicons name="pencil-outline" size={20} color={colors.onSurface} />
          </Pressable>
        )}
      </View>

      {loading && !agent ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.onSurfaceVariant} />
        </View>
      ) : error && !agent ? (
        <View style={styles.center}>
          <Text style={[buzzTypography.bodySmall, { color: colors.error }]}>{error}</Text>
        </View>
      ) : agent ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await loadAgent();
                setRefreshing(false);
              }}
              tintColor={colors.onSurfaceVariant}
            />
          }
        >
          {/* Hero */}
          <View style={styles.hero}>
            <BuzzAvatar
              name={agent.name}
              uri={agent.avatarUrl || undefined}
              size={84}
              isAgent
              status={agent.status}
            />
            <Text style={[buzzTypography.title, { color: colors.onSurface }]}>{agent.name}</Text>
            <View style={styles.badgeRow}>
              <BuzzBadge
                label={agent.status === 'online' ? 'Online' : 'Offline'}
                tone={agent.status === 'online' ? 'success' : 'neutral'}
              />
              <BuzzBadge label={agent.cliId} />
              {agent.archived && <BuzzBadge label="Archived" tone="warning" />}
            </View>
            {!!agent.description && (
              <Text
                style={[
                  buzzTypography.bodySmall,
                  { color: colors.onSurfaceVariant, textAlign: 'center' },
                ]}
              >
                {agent.description}
              </Text>
            )}

            {/* Primary Action Tiles */}
            <View style={styles.actionTiles}>
              <Pressable
                onPress={() => void handleOpenDm()}
                disabled={busyKey === 'dm'}
                style={[styles.tile, { backgroundColor: accent.fill }]}
              >
                <Ionicons name="chatbubble-outline" size={20} color={accent.foreground} />
                <Text style={[buzzTypography.caption, { color: accent.foreground }]}>Message</Text>
              </Pressable>

              <Pressable
                disabled={!primarySession}
                onPress={() =>
                  primarySession &&
                  router.push(
                    `/terminal/${encodeURIComponent(primarySession.sessionId)}?agentId=${encodeURIComponent(agent.id)}`,
                  )
                }
                style={[
                  styles.tile,
                  {
                    backgroundColor: colors.surfaceContainerLow,
                    borderColor: colors.outline,
                    borderWidth: StyleSheet.hairlineWidth,
                    opacity: primarySession ? 1 : 0.45,
                  },
                ]}
              >
                <Ionicons name="terminal-outline" size={20} color={colors.onSurface} />
                <Text style={[buzzTypography.caption, { color: colors.onSurface }]}>Terminal</Text>
              </Pressable>

              <Pressable
                disabled={!primarySession || busyKey !== null}
                onPress={() => primarySession && void handleSessionOp(primarySession.sessionId, 'restart')}
                style={[
                  styles.tile,
                  {
                    backgroundColor: colors.surfaceContainerLow,
                    borderColor: colors.outline,
                    borderWidth: StyleSheet.hairlineWidth,
                    opacity: primarySession ? 1 : 0.45,
                  },
                ]}
              >
                <Ionicons name="refresh-outline" size={20} color={colors.onSurface} />
                <Text style={[buzzTypography.caption, { color: colors.onSurface }]}>Restart</Text>
              </Pressable>

              <Pressable
                disabled={!primarySession || busyKey !== null}
                onPress={() =>
                  primarySession &&
                  void handleSessionOp(
                    primarySession.sessionId,
                    primaryState === 'closed' ? 'resume' : 'close',
                  )
                }
                style={[
                  styles.tile,
                  {
                    backgroundColor: colors.surfaceContainerLow,
                    borderColor: colors.outline,
                    borderWidth: StyleSheet.hairlineWidth,
                    opacity: primarySession ? 1 : 0.45,
                  },
                ]}
              >
                <Ionicons
                  name={primaryState === 'closed' ? 'play-outline' : 'stop-outline'}
                  size={20}
                  color={colors.onSurface}
                />
                <Text style={[buzzTypography.caption, { color: colors.onSurface }]}>
                  {primaryState === 'closed' ? 'Resume' : 'Stop'}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Segmented Tab Bar */}
          <View style={[styles.tabBar, { backgroundColor: colors.surfaceContainerLow }]}>
            {(
              [
                { id: 'info', label: 'Info' },
                { id: 'channels', label: `Channels ${agent.channels.length}` },
                { id: 'runtime', label: `Runtime ${sortedSessions.length}` },
              ] as const
            ).map((item) => {
              const selected = tab === item.id;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setTab(item.id);
                  }}
                  style={[
                    styles.tabBtn,
                    selected && { backgroundColor: colors.surface },
                  ]}
                >
                  <Text
                    style={[
                      buzzTypography.label,
                      { color: selected ? colors.onSurface : colors.onSurfaceVariant },
                    ]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* INFO TAB */}
          {tab === 'info' && (
            <>
              {agent.recentMessages.length > 0 && (
                <BuzzSectionGroup title="Latest Activity">
                  {agent.recentMessages.slice(0, 3).map((msg, idx) => (
                    <TouchableOpacity
                      key={msg.id}
                      onPress={() => router.push(`/channel/${encodeURIComponent(msg.channelId)}`)}
                      style={[
                        styles.row,
                        idx > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: colors.outline,
                        },
                      ]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                          #{msg.channelName}
                        </Text>
                        <Text
                          style={[buzzTypography.bodySmall, { color: colors.onSurface }]}
                          numberOfLines={2}
                        >
                          {msg.content}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.onSurfaceVariant} />
                    </TouchableOpacity>
                  ))}
                </BuzzSectionGroup>
              )}

              <BuzzSectionGroup title="Info">
                <TouchableOpacity
                  onPress={() =>
                    agent.systemPrompt.trim() ? setInstructionsOpen(true) : openEdit()
                  }
                  style={styles.row}
                >
                  <Ionicons name="document-text-outline" size={18} color={colors.onSurfaceVariant} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                      Agent instructions
                    </Text>
                    <Text
                      style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                      numberOfLines={2}
                    >
                      {agent.systemPrompt.trim() || 'No instruction set. Tap to add…'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.onSurfaceVariant} />
                </TouchableOpacity>

                <View
                  style={[
                    styles.row,
                    { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outline },
                  ]}
                >
                  <Ionicons name="hardware-chip-outline" size={18} color={colors.onSurfaceVariant} />
                  <View style={{ flex: 1 }}>
                    <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                      Runtime / CLI
                    </Text>
                    <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                      {agent.cliId}
                    </Text>
                  </View>
                </View>

                <View
                  style={[
                    styles.row,
                    { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outline },
                  ]}
                >
                  <Ionicons name="folder-outline" size={18} color={colors.onSurfaceVariant} />
                  <View style={{ flex: 1 }}>
                    <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                      Working directory
                    </Text>
                    <Text
                      style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                      numberOfLines={1}
                    >
                      {agent.workingDir || '—'}
                    </Text>
                  </View>
                </View>
              </BuzzSectionGroup>

              <BuzzSectionGroup title="Management">
                <TouchableOpacity onPress={openEdit} style={styles.row}>
                  <Ionicons name="pencil-outline" size={18} color={colors.onSurfaceVariant} />
                  <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}>
                    Edit agent profile
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.onSurfaceVariant} />
                </TouchableOpacity>

                <TouchableOpacity
                  disabled={saving}
                  onPress={handleToggleArchive}
                  style={[
                    styles.row,
                    { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outline },
                  ]}
                >
                  <Ionicons
                    name={agent.archived ? 'archive-outline' : 'archive'}
                    size={18}
                    color={agent.archived ? colors.onSurfaceVariant : colors.error}
                  />
                  <Text
                    style={[
                      buzzTypography.titleSmall,
                      { color: agent.archived ? colors.onSurface : colors.error, flex: 1 },
                    ]}
                  >
                    {agent.archived ? 'Unarchive agent' : 'Archive agent'}
                  </Text>
                </TouchableOpacity>
              </BuzzSectionGroup>
            </>
          )}

          {/* CHANNELS TAB */}
          {tab === 'channels' && (
            <BuzzSectionGroup>
              {unjoinedChannels.length > 0 && (
                <TouchableOpacity
                  onPress={() => setAddChannelOpen(true)}
                  style={styles.row}
                >
                  <Ionicons name="add-circle-outline" size={20} color={colors.tertiary} />
                  <Text style={[buzzTypography.titleSmall, { color: colors.tertiary, flex: 1 }]}>
                    Add to channel
                  </Text>
                </TouchableOpacity>
              )}
              {agent.channels.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                    尚未加入任何频道
                  </Text>
                </View>
              ) : (
                agent.channels.map((ch, idx) => (
                  <View
                    key={ch.channelId}
                    style={[
                      styles.row,
                      (idx > 0 || unjoinedChannels.length > 0) && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.outline,
                      },
                    ]}
                  >
                    <TouchableOpacity
                      style={{ flex: 1 }}
                      onPress={() => router.push(`/channel/${encodeURIComponent(ch.channelId)}`)}
                    >
                      <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                        #{ch.name}
                      </Text>
                      <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                        自动响应
                      </Text>
                    </TouchableOpacity>
                    <Switch
                      value={ch.autoReply}
                      onValueChange={(v) => void handleToggleAutoReply(ch.channelId, v)}
                    />
                    <Pressable
                      onPress={() => void handleRemoveChannel(ch.channelId)}
                      hitSlop={8}
                      style={{ paddingLeft: 6 }}
                    >
                      <Ionicons name="trash-outline" size={17} color={colors.onSurfaceVariant} />
                    </Pressable>
                  </View>
                ))
              )}
            </BuzzSectionGroup>
          )}

          {/* RUNTIME TAB */}
          {tab === 'runtime' && (
            <BuzzSectionGroup title={`Botmux Sessions (${sortedSessions.length})`}>
              {sortedSessions.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                    暂无关联的 Botmux Session
                  </Text>
                </View>
              ) : (
                sortedSessions.map((s, idx) => {
                  const st = sessionState(s);
                  const isLive = st !== 'closed' && st !== 'offline';
                  const isCurrent = Boolean(activeChannelId && s.channelId === activeChannelId);
                  return (
                    <View
                      key={s.sessionId}
                      style={[
                        styles.sessionCard,
                        idx > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: colors.outline,
                        },
                      ]}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                            {s.channelName ? `#${s.channelName}` : s.title || s.sessionId.slice(0, 8)}
                            {isCurrent ? ' · 当前频道' : ''}
                          </Text>
                          <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                            {s.sessionId}
                          </Text>
                        </View>
                        <BuzzBadge label={st} tone={isLive ? 'success' : 'neutral'} />
                      </View>

                      <View style={styles.sessionBtns}>
                        <Pressable
                          onPress={() =>
                            router.push(
                              `/terminal/${encodeURIComponent(s.sessionId)}?agentId=${encodeURIComponent(agent.id)}`,
                            )
                          }
                          style={[styles.smallBtn, { backgroundColor: colors.primary }]}
                        >
                          <Text style={[buzzTypography.micro, { color: colors.onPrimary }]}>
                            Terminal
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void handleOpenHistory(s.sessionId)}
                          style={[styles.smallBtn, { backgroundColor: colors.surfaceContainerHigh }]}
                        >
                          <Text style={[buzzTypography.micro, { color: colors.onSurface }]}>
                            History
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void handleSessionOp(s.sessionId, 'restart')}
                          style={[styles.smallBtn, { backgroundColor: colors.surfaceContainerHigh }]}
                        >
                          <Text style={[buzzTypography.micro, { color: colors.onSurface }]}>
                            Restart
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() =>
                            void handleSessionOp(s.sessionId, st === 'closed' ? 'resume' : 'close')
                          }
                          style={[styles.smallBtn, { backgroundColor: colors.surfaceContainerHigh }]}
                        >
                          <Text style={[buzzTypography.micro, { color: colors.onSurface }]}>
                            {st === 'closed' ? 'Resume' : 'Close'}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })
              )}
            </BuzzSectionGroup>
          )}
        </ScrollView>
      ) : null}

      {/* Edit Agent Modal */}
      <Modal visible={editOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setEditOpen(false)}>
        <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: Platform.OS === 'android' ? insets.top : 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={[styles.header, { borderBottomColor: colors.outline }]}>
            <Pressable onPress={() => setEditOpen(false)} style={styles.iconBtn}>
              <Text style={[buzzTypography.label, { color: colors.onSurfaceVariant }]}>Cancel</Text>
            </Pressable>
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1, textAlign: 'center' }]}>
              Edit agent
            </Text>
            <Pressable disabled={saving} onPress={() => void handleSaveEdit()} style={styles.iconBtn}>
              <Text style={[buzzTypography.label, { color: colors.tertiary }]}>
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={{ gap: 6 }}>
              <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                DISPLAY NAME
              </Text>
              <TextInput
                value={editName}
                onChangeText={setEditName}
                style={[styles.input, buzzTypography.body, { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline, color: colors.onSurface }]}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                DESCRIPTION ({editDesc.length}/280)
              </Text>
              <TextInput
                value={editDesc}
                onChangeText={(t) => setEditDesc(t.slice(0, 280))}
                style={[styles.input, buzzTypography.body, { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline, color: colors.onSurface }]}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                AVATAR URL
              </Text>
              <TextInput
                value={editAvatar}
                onChangeText={setEditAvatar}
                autoCapitalize="none"
                style={[styles.input, buzzTypography.body, { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline, color: colors.onSurface }]}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                SYSTEM PROMPT / INSTRUCTIONS
              </Text>
              <TextInput
                value={editPrompt}
                onChangeText={setEditPrompt}
                multiline
                textAlignVertical="top"
                style={[styles.textarea, buzzTypography.bodySmall, { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline, color: colors.onSurface }]}
              />
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Full Instructions Modal */}
      <Modal visible={instructionsOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setInstructionsOpen(false)}>
        <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: Platform.OS === 'android' ? insets.top : 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={[styles.header, { borderBottomColor: colors.outline }]}>
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}>
              Agent instructions
            </Text>
            <Pressable onPress={() => setInstructionsOpen(false)} style={styles.iconBtn}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Text style={[buzzTypography.body, { color: colors.onSurface }]} selectable>
              {agent?.systemPrompt || 'No instruction set.'}
            </Text>
          </ScrollView>
        </View>
      </Modal>

      {/* Session History Modal */}
      <Modal visible={Boolean(historyModal)} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setHistoryModal(null)}>
        <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: Platform.OS === 'android' ? insets.top : 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={[styles.header, { borderBottomColor: colors.outline }]}>
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]} numberOfLines={1}>
              Log · {historyModal?.sessionId.slice(0, 8)}
            </Text>
            <Pressable onPress={() => setHistoryModal(null)} style={styles.iconBtn}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            {historyModal?.loading ? (
              <ActivityIndicator color={colors.onSurfaceVariant} />
            ) : (
              <Text
                style={{
                  fontFamily: Platform.select({
                    ios: 'Menlo',
                    android: 'monospace',
                    default: 'monospace',
                  }),
                  fontSize: 12,
                  color: colors.onSurface,
                }}
                selectable
              >
                {historyModal?.content || 'No output'}
              </Text>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Add to Channel Modal */}
      <Modal visible={addChannelOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAddChannelOpen(false)}>
        <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: Platform.OS === 'android' ? insets.top : 8, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={[styles.header, { borderBottomColor: colors.outline }]}>
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}>
              Add to channel
            </Text>
            <Pressable onPress={() => setAddChannelOpen(false)} style={styles.iconBtn}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <BuzzSectionGroup>
              {unjoinedChannels.map((ch, idx) => (
                <TouchableOpacity
                  key={ch.id}
                  onPress={() => void handleAddToChannel(ch.id)}
                  style={[
                    styles.row,
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.outline,
                    },
                  ]}
                >
                  <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}>
                    #{ch.name}
                  </Text>
                  <Ionicons name="add" size={20} color={colors.tertiary} />
                </TouchableOpacity>
              ))}
            </BuzzSectionGroup>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    height: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { padding: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollContent: {
    padding: buzzGrid.gutter,
    gap: buzzGrid.xs,
    paddingBottom: 40,
  },
  hero: {
    alignItems: 'center',
    gap: 10,
    paddingBottom: 6,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  actionTiles: {
    flexDirection: 'row',
    gap: 8,
    width: '100%',
    marginTop: 6,
  },
  tile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 12,
    borderRadius: 16,
  },
  tabBar: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 14,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    minHeight: 52,
  },
  emptyRow: {
    padding: 18,
    alignItems: 'center',
  },
  sessionCard: {
    padding: 14,
    gap: 10,
  },
  sessionBtns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: buzzRadii.pill,
  },
  input: {
    height: 44,
    borderRadius: buzzRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  textarea: {
    minHeight: 140,
    borderRadius: buzzRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
});
