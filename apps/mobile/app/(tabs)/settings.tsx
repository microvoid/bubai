import { buzzAccentChoices, buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BuzzAvatar } from '@/components/BuzzAvatar';
import { BuzzSectionGroup } from '@/components/BuzzComponents';
import { getPushRegistrationState } from '@/services/pushNotifications';
import { useBubai } from '@/store/BubaiProvider';
import { type ThemePreference, useBuzzTheme } from '@/theme/ThemeProvider';

const MODE_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { colors, mode, preference, accentId, setPreference, setAccentId } = useBuzzTheme();
  const {
    serverUrl,
    authUser,
    organizations,
    activeOrgId,
    switchOrganization,
    signOut,
    wsState,
    botmuxConnected,
    participants,
    currentUserId,
    setCurrentUserId,
  } = useBubai();

  const humans = participants.filter((p) => p.role === 'human');

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]} edges={['top']}>
      <View style={styles.topBar}>
        <Text style={[buzzTypography.largeTitle, { color: colors.onSurface }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <BuzzSectionGroup title="Connection">
          <Pressable
            onPress={() => router.push('/connect')}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.75 : 1 }]}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                Bubai Server
              </Text>
              <Text
                style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                numberOfLines={1}
              >
                {serverUrl || 'Not configured'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceVariant} />
          </Pressable>

          <View
            style={[
              styles.row,
              {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.outline,
              },
            ]}
          >
            <Text style={[buzzTypography.bodySmall, { color: colors.onSurface, flex: 1 }]}>
              WebSocket / Botmux
            </Text>
            <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
              {wsState} · {botmuxConnected ? 'Botmux Live' : 'Botmux Offline'}
            </Text>
          </View>
        </BuzzSectionGroup>

        <BuzzSectionGroup title="Appearance">
          <View style={styles.segmentWrap}>
            {MODE_OPTIONS.map((opt) => {
              const selected = preference === opt.id;
              return (
                <Pressable
                  key={opt.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setPreference(opt.id);
                  }}
                  style={[
                    styles.segmentBtn,
                    {
                      backgroundColor: selected ? colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[
                      buzzTypography.label,
                      { color: selected ? colors.onPrimary : colors.onSurfaceVariant },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View
            style={[
              styles.swatchRow,
              {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.outline,
              },
            ]}
          >
            {buzzAccentChoices.map((choice) => {
              const fill = mode === 'dark' ? choice.dark : choice.light;
              const selected = accentId === choice.id;
              return (
                <Pressable
                  key={choice.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setAccentId(choice.id);
                  }}
                  style={[
                    styles.swatch,
                    {
                      backgroundColor: fill,
                      borderColor: selected ? colors.onSurface : 'transparent',
                    },
                  ]}
                />
              );
            })}
          </View>
        </BuzzSectionGroup>

        {authUser && (
          <BuzzSectionGroup title="Account">
            <View style={styles.row}>
              <BuzzAvatar
                name={authUser.name}
                uri={authUser.image || undefined}
                size={36}
                status="online"
                ringColor={colors.surfaceContainerLow}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  style={[buzzTypography.titleSmall, { color: colors.onSurface }]}
                  numberOfLines={1}
                >
                  {authUser.name}
                </Text>
                <Text
                  style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
                  numberOfLines={1}
                >
                  {authUser.email}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => {
                void signOut().then(() => router.push('/connect'));
              }}
              style={[
                styles.row,
                {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: colors.outline,
                },
              ]}
            >
              <Ionicons name="log-out-outline" size={20} color={colors.error} />
              <Text style={[buzzTypography.titleSmall, { color: colors.error, flex: 1 }]}>
                Sign Out
              </Text>
            </Pressable>
          </BuzzSectionGroup>
        )}

        {organizations.length > 0 && (
          <BuzzSectionGroup title="Community">
            {organizations.map((org, idx) => {
              const selected = org.id === activeOrgId;
              return (
                <Pressable
                  key={org.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    void switchOrganization(org.id);
                  }}
                  style={[
                    styles.row,
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.outline,
                    },
                  ]}
                >
                  <Ionicons name="business-outline" size={20} color={colors.onSurfaceVariant} />
                  <Text
                    style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}
                    numberOfLines={1}
                  >
                    {org.name}
                  </Text>
                  {selected && (
                    <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                  )}
                </Pressable>
              );
            })}
          </BuzzSectionGroup>
        )}

        {!authUser && humans.length > 0 && (
          <BuzzSectionGroup title="Active Identity">
            {humans.map((human, idx) => {
              const selected = human.id === currentUserId;
              return (
                <Pressable
                  key={human.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setCurrentUserId(human.id);
                  }}
                  style={[
                    styles.row,
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.outline,
                    },
                  ]}
                >
                  <BuzzAvatar
                    name={human.name}
                    uri={human.avatarUrl}
                    size={34}
                    status={human.status}
                    ringColor={colors.surfaceContainerLow}
                  />
                  <Text
                    style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}
                    numberOfLines={1}
                  >
                    {human.name}
                  </Text>
                  {selected && (
                    <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                  )}
                </Pressable>
              );
            })}
          </BuzzSectionGroup>
        )}
        <BuzzSectionGroup title="Notifications (Phase 2)">
          <Pressable
            onPress={async () => {
              void Haptics.selectionAsync();
              const state = await getPushRegistrationState();
              Alert.alert('Push Notifications', state.detail);
            }}
            style={styles.row}
          >
            <Ionicons name="notifications-outline" size={20} color={colors.onSurfaceVariant} />
            <View style={{ flex: 1 }}>
              <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                Push Notifications
              </Text>
              <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                APNs / FCM registration hook ready
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceVariant} />
          </Pressable>
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
    paddingHorizontal: buzzGrid.gutter,
    paddingTop: buzzGrid.xxs,
    paddingBottom: buzzGrid.twelve,
  },
  content: {
    paddingHorizontal: buzzGrid.gutter,
    paddingBottom: buzzGrid.md,
    gap: buzzGrid.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    minHeight: 52,
  },
  segmentWrap: {
    flexDirection: 'row',
    padding: 6,
    gap: 6,
  },
  segmentBtn: {
    flex: 1,
    height: 36,
    borderRadius: buzzRadii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2.5,
  },
});
