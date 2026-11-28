import { VoiceShortcut } from './VoiceShortcut';
import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { NavigationGlass } from './NavigationGlass';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBubai } from '@/store/BubaiProvider';
import { useActivity } from '@/store/useActivity';
import { useBuzzTheme } from '@/theme/ThemeProvider';

type Icon = React.ComponentProps<typeof Ionicons>['name'];
function Tool({
  icon,
  label,
  onPress,
  id,
  badge,
  initial,
}: {
  icon: Icon;
  label: string;
  onPress: () => void;
  id?: string;
  badge?: number;
  initial?: string;
}) {
  const { colors } = useBuzzTheme();
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.tool, { opacity: pressed ? 0.55 : 1 }]}
    >
      {initial ? (
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.surfaceContainerHigh,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            style={{ color: colors.onSurface, fontSize: 17, fontWeight: '600' }}
          >
            {initial}
          </Text>
        </View>
      ) : (
        <Ionicons name={icon} size={23} color={colors.onSurface} />
      )}
      {!!badge && (
        <View style={[styles.badge, { backgroundColor: colors.error }]} />
      )}
    </Pressable>
  );
}

export function WorkspaceHeader() {
  const router = useRouter();
  const { colors } = useBuzzTheme();
  const { organizations, activeOrgId, switchOrganization, asks, authToken } =
    useBubai();
  const activity = useActivity();
  const unread =
    asks.length +
    (activity.data?.items.reduce((sum, item) => sum + item.unreadCount, 0) ??
      0);
  const active = organizations.find((org) => org.id === activeOrgId);
  const [menu, setMenu] = useState<'community' | 'more' | null>(null);
  const insets = useSafeAreaInsets();
  function row(label: string, icon: Icon, action: () => void, id?: string) {
    return (
      <Pressable
        key={id ?? label}
        testID={id}
        accessibilityRole="button"
        onPress={() => {
          setMenu(null);
          action();
        }}
        style={({ pressed }) => [
          styles.menuRow,
          { opacity: pressed ? 0.5 : 1 },
        ]}
      >
        <Ionicons name={icon} size={20} color={colors.onSurfaceVariant} />
        <Text style={{ color: colors.onSurface, fontSize: 17, flexShrink: 1 }}>
          {label}
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        testID="community-menu"
        onPress={() => setMenu('community')}
        style={styles.community}
      >
        <Text
          numberOfLines={1}
          style={{
            fontSize: 24,
            fontWeight: '600',
            color: colors.onSurface,
            flexShrink: 1,
          }}
        >
          {active?.name || '消息'}
        </Text>
        <Ionicons
          name="chevron-down"
          size={16}
          color={colors.onSurfaceVariant}
        />
      </Pressable>
      <Tool
        id="activity-tab"
        icon="notifications-outline"
        label={unread ? '动态，有未读' : '动态'}
        badge={unread}
        onPress={() => router.push('/activity')}
      />
      <Tool
        id="workspace-more"
        initial={active?.name && Array.from(active.name)[0]}
        icon="ellipsis-horizontal"
        label="更多"
        onPress={() => setMenu('more')}
      />
      <Modal
        visible={menu !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenu(null)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            accessibilityLabel="关闭菜单"
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
            onPress={() => setMenu(null)}
          />
          <ScrollView
            bounces={false}
            style={{
              flexGrow: 0,
              maxHeight: '80%',
              backgroundColor: colors.surface,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
            }}
            contentContainerStyle={{
              padding: 16,
              paddingBottom: insets.bottom + 16,
            }}
          >
            {menu === 'community' &&
              organizations.map((org) =>
                row(
                  org.name,
                  org.id === activeOrgId
                    ? 'checkmark-circle'
                    : 'people-outline',
                  () => {
                    void switchOrganization(org.id).catch((e) =>
                      Alert.alert('切换失败', String(e)),
                    );
                  },
                  org.id,
                ),
              )}
            {menu === 'more' &&
              row('智能体', 'hardware-chip-outline', () =>
                router.push('/agents'),
              )}
            {menu === 'more' &&
              authToken &&
              row('成员与邀请', 'person-add-outline', () =>
                router.push('./members'),
              )}
            {row(
              '设置',
              'settings-outline',
              () => router.push('/settings'),
              'settings-tab',
            )}
            {row(
              '连接服务器',
              'server-outline',
              () => router.push('/connect'),
              'change-connection',
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

export function WorkspaceDock({ onCreate }: { onCreate: () => void }) {
  const router = useRouter();
  const { colors } = useBuzzTheme();
  const { bottom } = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, { bottom: Math.max(12, bottom) }]}
    >
      {(['search', 'create', 'voice'] as const).map((action) => (
        <View
          key={action}
          style={[
            styles.glass,
            {
              borderColor: colors.outline,
              backgroundColor:
                Platform.OS === 'ios'
                  ? 'transparent'
                  : colors.surfaceContainerLow,
            },
          ]}
        >
          {Platform.OS === 'ios' && (
            <NavigationGlass
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
            />
          )}
          {action === 'voice' ? (
            <VoiceShortcut />
          ) : action === 'search' ? (
            <Tool
              icon="search-outline"
              label="搜索消息"
              onPress={() => router.push('/search')}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={onCreate}
              style={styles.create}
            >
              <Ionicons name="add" size={22} color={colors.onSurface} />
              <Text
                style={{
                  color: colors.onSurface,
                  fontSize: 17,
                  fontWeight: '600',
                }}
              >
                新建
              </Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 60,
  },
  community: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
  },
  tool: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 7,
    right: 9,
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  menuRow: {
    minHeight: 52,
    paddingHorizontal: 12,
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
  },
  dock: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  create: {
    height: 54,
    width: 120,
    flexDirection: 'row',
    gap: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glass: {
    overflow: 'hidden',
    flexDirection: 'row',
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 54,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
