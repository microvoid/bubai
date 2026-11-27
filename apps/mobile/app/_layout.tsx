import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { notificationRoute } from '@/services/notificationRoute';
import { Stack, useRouter, useNavigationContainerRef } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BubaiProvider, useBubai } from '@/store/BubaiProvider';
import { BuzzThemeProvider, useBuzzTheme } from '@/theme/ThemeProvider';

Notifications.setNotificationHandler({handleNotification: async () => ({
  shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
})});

function RootNavigator() {
  const { mode, colors } = useBuzzTheme();
  const { hydrated, instance, authRequired, authToken } = useBubai();
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
    if (!response || !ready || !hydrated || !instance || (authRequired && !authToken)) return;
    const request = response.notification.request;
    if (handled.current === request.identifier) return;
    handled.current = request.identifier;
    const target = notificationRoute(request.content.data);
    if (target && response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) router.push(target);
    void Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }, [response, ready, hydrated, instance, authRequired, authToken, router]);
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

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <BuzzThemeProvider>
          <BubaiProvider>
            <RootNavigator />
          </BubaiProvider>
        </BuzzThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
