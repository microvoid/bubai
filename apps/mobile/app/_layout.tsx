import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BubaiProvider } from '@/store/BubaiProvider';
import { BuzzThemeProvider, useBuzzTheme } from '@/theme/ThemeProvider';

function RootNavigator() {
  const { mode, colors } = useBuzzTheme();
  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.surface },
        }}
      >
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
