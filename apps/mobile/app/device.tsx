import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Button, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { mobileDeviceDecision } from '@/services/auth';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function Device() {
  const { user_code = '' } = useLocalSearchParams<{ user_code: string }>();
  const [code, setCode] = useState(user_code);
  const [busy, setBusy] = useState(false);
  const { serverUrl, authToken } = useBubai();
  const { colors } = useBuzzTheme();
  const router = useRouter();
  async function decide(approve: boolean) {
    if (!serverUrl || !authToken) return;
    setBusy(true);
    try {
      await mobileDeviceDecision(serverUrl, authToken, code, approve);
      Alert.alert(approve ? '设备已授权' : '已拒绝授权');
      router.replace('/(tabs)');
    } catch (error) {
      Alert.alert('设备授权失败', String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={{ padding: 20, gap: 12 }}>
      <Text style={{ color: colors.onSurface }}>输入你正在登录的 CLI 上显示的设备码</Text>
      <TextInput
        accessibilityLabel="设备码"
        value={code}
        onChangeText={setCode}
        style={{ color: colors.onSurface }}
      />
      {!authToken ? (
        <Button title="登录" onPress={() => router.push('/connect?resume=1')} />
      ) : (
        <>
          <Button
            title="授权此设备"
            disabled={!code.trim() || busy}
            onPress={() => void decide(true)}
          />
          <Button
            title="拒绝授权"
            disabled={!code.trim() || busy}
            onPress={() => void decide(false)}
          />
        </>
      )}
    </SafeAreaView>
  );
}
