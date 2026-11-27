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

type ConnectStep = 'server' | 'email' | 'otp' | 'password';

export default function ConnectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const {
    serverUrl,
    authUser,
    connectToServer,
    sendEmailOtp,
    signInWithOtp,
    signInWithPassword,
  } = useBubai();
  const defaultFallbackUrl =
    Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://127.0.0.1:4000';
  const [inputUrl, setInputUrl] = useState(serverUrl || defaultFallbackUrl);
  const [step, setStep] = useState<ConnectStep>('server');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await connectToServer(inputUrl);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (info.authRequired && !authUser) {
        setStep('email');
      } else {
        router.replace('/(tabs)');
      }
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof Error ? err.message : '无法连接到 Bubai 服务端');
    } finally {
      setBusy(false);
    }
  };

  const handleSendOtp = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendEmailOtp(email);
      setStep('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithOtp(email, otp);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof Error ? err.message : '验证码无效或已过期');
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithPassword(email, password);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof Error ? err.message : '邮箱或密码错误');
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
          {step !== 'server' ? (
            <Pressable
              onPress={() => {
                setError(null);
                setStep(step === 'otp' ? 'email' : 'server');
              }}
              style={[styles.closeBtn, { backgroundColor: colors.surfaceContainerLow }]}
            >
              <Ionicons name="arrow-back" size={20} color={colors.onSurface} />
            </Pressable>
          ) : (
            <View />
          )}
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
            {step === 'server' ? 'Connect to Bubai' : 'Sign in to Bubai'}
          </Text>
          <Text
            style={[
              buzzTypography.bodySmall,
              { color: colors.onSurfaceVariant, textAlign: 'center' },
            ]}
          >
            {step === 'server'
              ? '输入你的 Bubai 服务端地址（与 Web 端相同，支持局域网、Tailscale 或公网域名）。'
              : step === 'otp'
                ? `已发送 6 位验证码至 ${email}`
                : '登录你的账号以同步 Community 与消息。'}
          </Text>
        </View>

        {step === 'server' && (
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
        )}

        {step === 'email' && (
          <View style={styles.form}>
            <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>EMAIL</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="name@company.com"
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
              onSubmitEditing={() => void handleSendOtp()}
            />
            {error && (
              <Text style={[buzzTypography.bodySmall, { color: colors.error }]}>{error}</Text>
            )}
            <Pressable
              disabled={busy || !email.trim()}
              onPress={() => void handleSendOtp()}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: colors.primary,
                  opacity: busy || !email.trim() ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={[buzzTypography.titleSmall, { color: colors.onPrimary }]}>
                  发送验证码
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                setError(null);
                setStep('password');
              }}
              style={styles.linkBtn}
            >
              <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                使用邮箱密码登录（开发模式）
              </Text>
            </Pressable>
          </View>
        )}

        {step === 'otp' && (
          <View style={styles.form}>
            <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
              6-DIGIT CODE
            </Text>
            <TextInput
              value={otp}
              onChangeText={setOtp}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="123456"
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
              onSubmitEditing={() => void handleVerifyOtp()}
            />
            {error && (
              <Text style={[buzzTypography.bodySmall, { color: colors.error }]}>{error}</Text>
            )}
            <Pressable
              disabled={busy || otp.trim().length < 6}
              onPress={() => void handleVerifyOtp()}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: colors.primary,
                  opacity: busy || otp.trim().length < 6 ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={[buzzTypography.titleSmall, { color: colors.onPrimary }]}>
                  验证并登录
                </Text>
              )}
            </Pressable>
          </View>
        )}

        {step === 'password' && (
          <View style={styles.form}>
            <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>EMAIL</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="name@company.com"
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
            />
            <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
              PASSWORD
            </Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="输入密码"
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
              onSubmitEditing={() => void handlePasswordSignIn()}
            />
            {error && (
              <Text style={[buzzTypography.bodySmall, { color: colors.error }]}>{error}</Text>
            )}
            <Pressable
              disabled={busy || !email.trim() || !password}
              onPress={() => void handlePasswordSignIn()}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: colors.primary,
                  opacity: busy || !email.trim() || !password ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={[buzzTypography.titleSmall, { color: colors.onPrimary }]}>登录</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                setError(null);
                setStep('email');
              }}
              style={styles.linkBtn}
            >
              <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                返回邮箱验证码登录
              </Text>
            </Pressable>
          </View>
        )}
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
    justifyContent: 'space-between',
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
  linkBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
});
