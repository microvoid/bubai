import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Button, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { mobileGetInvite, mobileInviteDecision } from '@/services/auth';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function Invite() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { authToken, serverUrl, reloadAccount, currentUserId } = useBubai();
  const { colors } = useBuzzTheme();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const invite = useQuery({
    queryKey: ['invite', serverUrl, currentUserId, id],
    enabled: Boolean(authToken && serverUrl),
    queryFn: () => mobileGetInvite(serverUrl!, authToken!, id),
  });
  async function decide(accept: boolean) {
    if (!serverUrl || !authToken) return;
    setBusy(true);
    try {
      await mobileInviteDecision(serverUrl, authToken, id, accept);
      await reloadAccount();
      router.replace('/(tabs)');
    } catch (error) {
      Alert.alert('处理邀请失败', String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={{ padding: 20, gap: 12 }}>
      <Text style={{ color: colors.onSurface }}>
        {invite.error?.message || invite.data?.organizationName || '社区邀请'}
      </Text>
      {!authToken ? (
        <Button title="登录后查看邀请" onPress={() => router.push('/connect?resume=1')} />
      ) : (
        <>
          <Button
            title="接受邀请"
            disabled={!invite.data || busy}
            onPress={() => void decide(true)}
          />
          <Button
            title="拒绝邀请"
            disabled={!invite.data || busy}
            onPress={() => void decide(false)}
          />
        </>
      )}
    </SafeAreaView>
  );
}
