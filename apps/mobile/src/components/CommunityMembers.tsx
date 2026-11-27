import { BuzzButton, BuzzInput } from '@/components/BuzzComponents';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import {
  mobileCancelInvitation,
  mobileCommunityRoster,
  mobileInviteMember,
  mobileRemoveMember,
  mobileSetMemberRole,
} from '../services/auth';
import { useBubai } from '../store/BubaiProvider';
import { useBuzzTheme } from '../theme/ThemeProvider';

export function CommunityMembers() {
  const { serverUrl, authToken, currentUserId, activeOrgId } = useBubai();
  const { colors } = useBuzzTheme();
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const roster = useQuery({
    queryKey: ['community-roster', serverUrl, activeOrgId, currentUserId],
    enabled: expanded && Boolean(serverUrl && authToken && activeOrgId),
    queryFn: () => mobileCommunityRoster(serverUrl!, authToken!, activeOrgId!),
  });
  if (!serverUrl || !authToken || !activeOrgId) return null;
  const role = roster.data?.members.find((m) => m.userId === currentUserId)?.role;
  const canManage = role === 'owner' || role === 'admin';
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await roster.refetch();
    } catch (error) {
      Alert.alert('成员管理失败', String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ padding: 8, gap: 4 }}>
      <BuzzButton
        title={expanded ? '收起社区成员' : '社区成员与邀请'}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && (
        <>
          {roster.error && <Text style={{ color: colors.error }}>{roster.error.message}</Text>}
          {roster.data?.members.map((m) => (
            <View key={m.id}>
              <Text style={{ color: colors.onSurface }}>
                {m.user.name} · {m.role}
              </Text>
              {canManage && currentUserId !== m.userId && m.role !== 'owner' && (
                <>
                  <BuzzButton
                    title={m.role === 'admin' ? '设为成员' : '设为管理员'}
                    disabled={busy}
                    onPress={() =>
                      void run(() =>
                        mobileSetMemberRole(
                          serverUrl,
                          authToken,
                          activeOrgId,
                          m.id,
                          m.role === 'admin' ? 'member' : 'admin',
                        ),
                      )
                    }
                  />
                  <BuzzButton
                    title="移除成员"
                    disabled={busy}
                    onPress={() =>
                      Alert.alert('移除 ' + m.user.name + '？', undefined, [
                        { text: '取消' },
                        {
                          text: '移除',
                          style: 'destructive',
                          onPress: () =>
                            void run(() =>
                              mobileRemoveMember(serverUrl, authToken, activeOrgId, m.id),
                            ),
                        },
                      ])
                    }
                  />
                </>
              )}
            </View>
          ))}
          {canManage && (
            <>
              <BuzzInput
                placeholder="受邀人邮箱"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                style={{ color: colors.onSurface }}
              />
              <BuzzButton
                title="发送邀请"
                disabled={busy || !email.trim()}
                onPress={() =>
                  void run(async () => {
                    await mobileInviteMember(serverUrl, authToken, activeOrgId, email);
                    setEmail('');
                  })
                }
              />
              {roster.data?.invitations
                .filter((i) => i.status === 'pending')
                .map((i) => (
                  <BuzzButton
                    key={i.id}
                    title={'撤销邀请 · ' + i.email}
                    disabled={busy}
                    onPress={() =>
                      void run(() => mobileCancelInvitation(serverUrl, authToken, i.id))
                    }
                  />
                ))}
            </>
          )}
        </>
      )}
    </View>
  );
}
