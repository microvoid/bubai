import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function ConnectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const { serverUrl, connectToServer } = useBubai();
  const defaultFallbackUrl =
    Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://127.0.0.1:4000';
  const [inputUrl, setInputUrl] = useState(serverUrl || defaultFallbackUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await connectToServer(inputUrl);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof Error ? err.message : '无法连接到 Bubai 服务端');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.surface,
          paddingTop: Platform.OS === 'android' ? insets.top : 12,
          paddingBottom: Math.max(insets.bottom, 16),
        },
      ]}
    >
      <KeyboardAvoidingView
        style={styles.inner}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={[styles.closeBtn, { backgroundColor: colors.surfaceContainerLow }]}
          >
            <Ionicons name="close" size={20} color={colors.onSurface} />
          </Pressable>
        </View>

        <View style={styles.hero}>
          <View style={[styles.logoBox, { backgroundColor: colors.primary }]}>
            <Ionicons name="sparkles" size={28} color={colors.onPrimary} />
          </View>
          <Text style={[buzzTypography.largeTitle, { color: colors.onSurface }]}>
            Connect to Bubai
          </Text>
          <Text
            style={[
              buzzTypography.bodySmall,
              { color: colors.onSurfaceVariant, textAlign: 'center' },
            ]}
          >
            输入你的 Bubai 服务端地址（与 Web 端相同，支持局域网、Tailscale 或公网域名）。
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
            SERVER URL
          </Text>
          <TextInput
            value={inputUrl}
            onChangeText={setInputUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://bubai.example.com"
            placeholderTextColor={colors.onSurfaceVariant}
            style={[
              styles.input,
              buzzTypography.body,
              {
                backgroundColor: colors.surfaceContainerLow,
                borderColor: error ? colors.error : colors.outline,
                color: colors.onSurface,
              },
            ]}
            editable={!busy}
            returnKeyType="go"
            onSubmitEditing={() => void handleConnect()}
          />

          {error && (
            <Text style={[buzzTypography.bodySmall, { color: colors.error }]}>{error}</Text>
          )}

          <Pressable
            disabled={busy || !inputUrl.trim()}
            onPress={() => void handleConnect()}
            style={({ pressed }) => [
              styles.primaryBtn,
              {
                backgroundColor: colors.primary,
                opacity: busy || !inputUrl.trim() ? 0.5 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {busy ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={[buzzTypography.titleSmall, { color: colors.onPrimary }]}>
                Connect
              </Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  inner: {
    flex: 1,
    paddingHorizontal: buzzGrid.gutter,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingVertical: buzzGrid.twelve,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    alignItems: 'center',
    gap: buzzGrid.twelve,
    marginTop: buzzGrid.md,
    marginBottom: buzzGrid.md,
  },
  logoBox: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  form: {
    gap: buzzGrid.twelve,
  },
  input: {
    height: 48,
    borderRadius: buzzRadii.md,
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  primaryBtn: {
    height: 50,
    borderRadius: buzzRadii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: buzzGrid.xxs,
  },
});
