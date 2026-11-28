import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts } from 'expo-font';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { notificationDestination } from '@/services/notificationRoute';
import { Stack, useRouter, useNavigationContainerRef } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BubaiProvider, useBubai } from '@/store/BubaiProvider';
import { BuzzThemeProvider, useBuzzTheme } from '@/theme/ThemeProvider';

Notifications.setNotificationHandler({handleNotification: async () => ({
  shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
})});

function RootNavigator() {
  const { mode, colors } = useBuzzTheme();
  const { hydrated, instance, authRequired, authToken, activeOrgId, switchOrganization } = useBubai();
  const router = useRouter();
  const navigation = useNavigationContainerRef();
  const [ready, setReady] = useState(navigation.isReady());
  useEffect(() => {
    const markReady = () => setReady(navigation.isReady());
    const unsubscribe = navigation.addListener('ready', markReady);
    markReady();
    return unsubscribe;
  }, [navigation, hydrated]);
  const [response, setResponse] = useState<Notifications.NotificationResponse | null>(null);
  const handled = useRef<string | null>(null);
  const switching = useRef(false);
  const [switchAttempt, setSwitchAttempt] = useState(0);
  const latest = useRef(response);
  latest.current = response;
  useEffect(() => {
    let active = true;
    let received = false;
    const listener = Notifications.addNotificationResponseReceivedListener(next => {
      received = true;
      setResponse(next);
    });
    void Notifications.getLastNotificationResponseAsync().then(last => {
      if (active && !received) setResponse(last);
    }).catch(() => {});
    return () => { active = false; listener.remove(); };
  }, []);
  useEffect(() => {
    if (!response || !ready || !hydrated || !instance || (authRequired && !authToken) || switching.current) return;
    const request = response.notification.request;
    if (handled.current === request.identifier) return;

    const finish = () => {
      handled.current = request.identifier;
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    };
    const destination = notificationDestination(request.content.data);
    if (!destination || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
      finish();
      return;
    }
    if (destination.organizationId && destination.organizationId !== activeOrgId) {
      if (!authToken) {
        finish();
        Alert.alert('无法打开通知', '请先登录通知所属的社区。');
        return;
      }
      switching.current = true;
      void switchOrganization(destination.organizationId).then(() => {
        // The old screen belongs to a different workspace. Back should return to the new home.
        if (latest.current === response && router.canDismiss()) router.dismissAll();
      }).catch(() => {
        if (latest.current !== response) return;
        finish();
        Alert.alert('无法打开通知', '无法切换到这条通知所属的社区，请检查网络和社区访问权限。');
      }).finally(() => {
        switching.current = false;
        setSwitchAttempt(attempt => attempt + 1);
      });
      return;
    }
    finish();
    router.push(destination.route);
  }, [response, ready, hydrated, instance, authRequired, authToken, activeOrgId, switchOrganization, switchAttempt, router]);
  if (!hydrated) return null;
  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.surface },
        }}
      >
        <Stack.Protected guard={Boolean(instance) && (!authRequired || Boolean(authToken))}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="channel/[id]" />
        <Stack.Screen name="thread/[channelId]/[rootId]" />
        <Stack.Screen name="agent/[id]" />
        <Stack.Screen name="search" />
        <Stack.Screen
          name="terminal/[sessionId]"
          options={{
            presentation: 'fullScreenModal',
            animation: 'slide_from_bottom',
          }}
        />
        </Stack.Protected>
        <Stack.Screen
          name="connect"
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsReady,fontError]=useFonts({Inter:require("../assets/fonts/InterVariable.ttf")});
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  if (!fontsReady && !fontError) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <BuzzThemeProvider>
          <BubaiProvider>
            <RootNavigator />
          </BubaiProvider>
        </BuzzThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider></GestureHandlerRootView>
  );
}
