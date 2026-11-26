import {
  BubaiClient,
  normalizeServerUrl,
  type BootstrapPayload,
  type BotmuxPendingAsk,
  type BotmuxSession,
  type Channel,
  type InstanceInfo,
  type MessageAttachment,
  type Participant,
  type ServerWsEvent,
  type WsConnectionState,
} from '@buzz-botmux/chat-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

const SERVER_URL_KEY = 'bubai.server.url';
const USER_ID_KEY = 'bubai.user.id';
const DEFAULT_SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ||
  (Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://127.0.0.1:4000');

interface BubaiContextValue {
  hydrated: boolean;
  serverUrl: string | null;
  currentUserId: string;
  client: BubaiClient | null;
  wsState: WsConnectionState;
  instance: InstanceInfo | null;
  channels: Channel[];
  participants: Participant[];
  sessions: BotmuxSession[];
  asks: BotmuxPendingAsk[];
  botmuxConnected: boolean;
  isLoading: boolean;
  error: string | null;
  connectToServer: (rawUrl: string) => Promise<InstanceInfo>;
  disconnectServer: () => Promise<void>;
  setCurrentUserId: (userId: string) => void;
  refreshBootstrap: () => Promise<void>;
  answerAsk: (ask: BotmuxPendingAsk, optionKey: string) => Promise<void>;
  sendWsMessage: (payload: {
    channelId: string;
    content: string;
    threadId?: string;
    replyToId?: string;
    attachments?: MessageAttachment[];
  }) => boolean;
  subscribeWsEvents: (listener: (event: ServerWsEvent) => void) => () => void;
  clearChannelUnread: (channelId: string) => void;
}

const BubaiContext = createContext<BubaiContextValue | null>(null);

export function BubaiProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [currentUserId, setCurrentUserIdState] = useState<string>('u-owner');
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [wsState, setWsState] = useState<WsConnectionState>('closed');
  const wsHandleRef = useRef<ReturnType<BubaiClient['connectWebSocket']> | null>(null);
  const wsListenersRef = useRef(new Set<(event: ServerWsEvent) => void>());

  useEffect(() => {
    void Promise.all([
      SecureStore.getItemAsync(SERVER_URL_KEY).catch(() => null),
      SecureStore.getItemAsync(USER_ID_KEY).catch(() => null),
    ]).then(([savedUrl, savedUser]) => {
      if (savedUrl) {
        try {
          setServerUrl(normalizeServerUrl(savedUrl));
        } catch {
          setServerUrl(DEFAULT_SERVER_URL);
        }
      } else {
        setServerUrl(DEFAULT_SERVER_URL);
      }
      if (savedUser) setCurrentUserIdState(savedUser);
      setHydrated(true);
    });
  }, []);

  const client = useMemo(
    () => (serverUrl ? new BubaiClient({ baseUrl: serverUrl }) : null),
    [serverUrl],
  );

  const bootstrapQueryKey = useMemo(
    () => ['bootstrap', serverUrl, currentUserId] as const,
    [serverUrl, currentUserId],
  );

  const bootstrapQuery = useQuery<BootstrapPayload>({
    queryKey: bootstrapQueryKey,
    enabled: hydrated && Boolean(client),
    queryFn: async () => {
      if (!client) throw new Error('Not connected');
      const [inst, data] = await Promise.all([
        client.getInstance().catch(() => null),
        client.bootstrap(currentUserId),
      ]);
      if (inst) setInstance(inst);
      return data;
    },
    retry: 1,
    staleTime: 10_000,
  });

  // WebSocket live subscription + AppState foreground resume
  useEffect(() => {
    if (!client || !hydrated) return;

    const handleEvent = (event: ServerWsEvent) => {
      for (const listener of wsListenersRef.current) {
        try {
          listener(event);
        } catch {
          // ignore listener errors
        }
      }
      queryClient.setQueryData<BootstrapPayload>(bootstrapQueryKey, (prev) => {
        if (!prev) return prev;
        switch (event.type) {
          case 'presence.updated':
            return { ...prev, participants: event.payload.participants };
          case 'sessions.updated':
            return { ...prev, sessions: event.payload.sessions };
          case 'asks.updated':
            return { ...prev, asks: event.payload.asks };
          case 'channel.created': {
            if (prev.channels.some((c) => c.id === event.payload.id)) return prev;
            return { ...prev, channels: [...prev.channels, event.payload] };
          }
          case 'channel.updated':
            return {
              ...prev,
              channels: prev.channels.map((c) =>
                c.id === event.payload.id ? { ...c, ...event.payload } : c,
              ),
            };
          case 'message.created':
            if (event.payload.threadId) return prev;
            return {
              ...prev,
              channels: prev.channels.map((c) =>
                c.id === event.payload.channelId
                  ? { ...c, unreadCount: (c.unreadCount || 0) + 1 }
                  : c,
              ),
            };
          default:
            return prev;
        }
      });
    };

    const handle = client.connectWebSocket({
      userId: currentUserId,
      onEvent: handleEvent,
      onStateChange: setWsState,
    });
    wsHandleRef.current = handle;

    let lastAppState: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (lastAppState !== 'active' && nextState === 'active') {
        handle.reconnectNow();
        void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      }
      lastAppState = nextState;
    });

    let wasConnected: boolean | null = null;
    const netSub = Network.addNetworkStateListener((state) => {
      const nowConnected = Boolean(state.isConnected && state.isInternetReachable !== false);
      if (wasConnected === false && nowConnected) {
        handle.reconnectNow();
        void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      }
      wasConnected = nowConnected;
    });

    return () => {
      sub.remove();
      netSub.remove();
      handle.close();
      wsHandleRef.current = null;
    };
  }, [bootstrapQueryKey, client, currentUserId, hydrated, queryClient]);

  const connectToServer = useCallback(async (rawUrl: string): Promise<InstanceInfo> => {
    const normalized = normalizeServerUrl(rawUrl);
    const probeClient = new BubaiClient({ baseUrl: normalized });
    const info = await probeClient.getInstance();
    await SecureStore.setItemAsync(SERVER_URL_KEY, normalized).catch(() => {});
    setInstance(info);
    setServerUrl(normalized);
    return info;
  }, []);

  const disconnectServer = useCallback(async () => {
    await SecureStore.deleteItemAsync(SERVER_URL_KEY).catch(() => {});
    setServerUrl(null);
    setInstance(null);
  }, []);

  const setCurrentUserId = useCallback((userId: string) => {
    setCurrentUserIdState(userId);
    void SecureStore.setItemAsync(USER_ID_KEY, userId).catch(() => {});
  }, []);

  const refreshBootstrap = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
  }, [bootstrapQueryKey, queryClient]);

  const answerAsk = useCallback(
    async (ask: BotmuxPendingAsk, optionKey: string) => {
      if (!client) return;
      await client.answerAsk({
        askId: ask.askId,
        larkAppId: ask.larkAppId,
        selections: [[optionKey]],
        by: currentUserId,
      });
      await refreshBootstrap();
    },
    [client, currentUserId, refreshBootstrap],
  );

  const sendWsMessage = useCallback(
    (payload: {
      channelId: string;
      content: string;
      threadId?: string;
      replyToId?: string;
      attachments?: MessageAttachment[];
    }): boolean => {
      const handle = wsHandleRef.current;
      if (!handle) return false;
      return handle.send({
        type: 'message.send',
        payload: {
          channelId: payload.channelId,
          senderId: currentUserId,
          content: payload.content,
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
          ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
          ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
        },
      });
    },
    [currentUserId],
  );

  const subscribeWsEvents = useCallback((listener: (event: ServerWsEvent) => void) => {
    wsListenersRef.current.add(listener);
    return () => {
      wsListenersRef.current.delete(listener);
    };
  }, []);

  const clearChannelUnread = useCallback(
    (channelId: string) => {
      queryClient.setQueryData<BootstrapPayload>(bootstrapQueryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          channels: prev.channels.map((c) =>
            c.id === channelId ? { ...c, unreadCount: 0 } : c,
          ),
        };
      });
      if (client) {
        void client.markChannelRead(channelId, currentUserId).catch(() => {});
      }
    },
    [bootstrapQueryKey, client, currentUserId, queryClient],
  );

  const data = bootstrapQuery.data;
  const value = useMemo<BubaiContextValue>(
    () => ({
      hydrated,
      serverUrl,
      currentUserId,
      client,
      wsState,
      instance,
      channels: data?.channels ?? [],
      participants: data?.participants ?? [],
      sessions: data?.sessions ?? [],
      asks: data?.asks ?? [],
      botmuxConnected: Boolean(data?.botmuxStatus?.authenticated ?? instance?.botmux?.authenticated),
      isLoading: bootstrapQuery.isLoading,
      error: bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : null,
      connectToServer,
      disconnectServer,
      setCurrentUserId,
      refreshBootstrap,
      answerAsk,
      sendWsMessage,
      subscribeWsEvents,
      clearChannelUnread,
    }),
    [
      answerAsk,
      bootstrapQuery.error,
      bootstrapQuery.isLoading,
      clearChannelUnread,
      client,
      connectToServer,
      currentUserId,
      data,
      disconnectServer,
      hydrated,
      instance,
      refreshBootstrap,
      sendWsMessage,
      serverUrl,
      setCurrentUserId,
      subscribeWsEvents,
      wsState,
    ],
  );

  return <BubaiContext.Provider value={value}>{children}</BubaiContext.Provider>;
}

export function useBubai(): BubaiContextValue {
  const ctx = useContext(BubaiContext);
  if (!ctx) throw new Error('useBubai must be used inside BubaiProvider');
  return ctx;
}
