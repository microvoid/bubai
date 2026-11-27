import { coalescedRefresh } from './coalescedRefresh';
import { checkSessionResponse, onSessionExpired } from '@/services/sessionExpiry';
import { registerDevice, unregisterDevice } from '@/services/pushNotifications';
import {
  BubaiClient,
  normalizeServerUrl,
  findMentionedNonMemberAgents,
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
import { Alert, AppState, Platform, type AppStateStatus } from 'react-native';
import {
  mobileCreateOrganization,
  mobileGetSession,
  mobileListOrganizations,
  mobileSendEmailOtp,
  mobileSetActiveOrganization,
  mobileSignInWithEmailOtp,
  mobileSignInWithPassword,
  mobileSignOut,
  mobileSignUpWithPassword,
  type MobileAuthOrg,
  type MobileAuthUser,
} from '@/services/auth';

const SERVER_URL_KEY = 'bubai.server.url';
const AUTH_TOKEN_KEY = 'bubai.auth.token';
function tokenKey(url: string) {
  const encoded = Array.from(normalizeServerUrl(url), c => c.codePointAt(0)!.toString(16)).join('.');
  return `${AUTH_TOKEN_KEY}.${encoded}`;
}
const DEFAULT_SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ||
  (Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://127.0.0.1:4000');

interface BubaiContextValue {
  hydrated: boolean;
  serverUrl: string | null;
  authToken: string | null;
  authUser: MobileAuthUser | null;
  authRequired: boolean;
  organizations: MobileAuthOrg[];
  activeOrgId: string | null;
  currentUserId: string;
  client: BubaiClient | null;
  wsState: WsConnectionState;
  instance: InstanceInfo | null;
  sidebarGroups: NonNullable<BootstrapPayload['sidebarGroups']>;
  channels: Channel[];
  participants: Participant[];
  sessions: BotmuxSession[];
  asks: BotmuxPendingAsk[];
  botmuxConnected: boolean;
  isLoading: boolean;
  error: string | null;
  connectToServer: (rawUrl: string) => Promise<InstanceInfo & { signedIn: boolean }>;
  disconnectServer: () => Promise<void>;
  sendEmailOtp: (email: string) => Promise<void>;
  signInWithOtp: (email: string, otp: string) => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUpWithPassword: (email: string, password: string, name: string) => Promise<boolean>;
  reloadAccount: () => Promise<void>;
  switchOrganization: (orgId: string) => Promise<void>;
  enableNotifications: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshBootstrap: () => Promise<void>;
  answerAsk: (ask: BotmuxPendingAsk, optionKey: string) => Promise<void>;
  sendTyping: (channelId: string) => void;
  sendWsMessage: (payload: {
    channelId: string;
    content: string;
    threadId?: string;
    replyToId?: string;
    attachments?: MessageAttachment[];
  }) => Promise<void>;
  subscribeWsEvents: (listener: (event: ServerWsEvent) => void) => () => void;
  markThreadRead: (channelId: string, rootId: string) => void;
  clearChannelUnread: (channelId: string) => void;
}

const BubaiContext = createContext<BubaiContextValue | null>(null);

export function BubaiProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<MobileAuthUser | null>(null);
  const [organizations, setOrganizations] = useState<MobileAuthOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [wsState, setWsState] = useState<WsConnectionState>('closed');
  const wsHandleRef = useRef<ReturnType<BubaiClient['connectWebSocket']> | null>(null);
  const wsListenersRef = useRef(new Set<(event: ServerWsEvent) => void>());

  const authRevision = useRef(0);
  const selectedUrl = useRef<string | null>(null);
  const activeCredentials = useRef({ serverUrl, authToken });
  activeCredentials.current = { serverUrl, authToken };
  const [sessionError, setSessionError] = useState<string | null>(null);
  const retrySession = useRef(false);
  retrySession.current = Boolean(sessionError);
  const hydrateSessionAndOrgs = useCallback(async (url: string, token: string) => {
    if (selectedUrl.current !== url) return null;
    const revision = ++authRevision.current;
    setSessionError(null);
    const session = await mobileGetSession(url, token);
    if (revision !== authRevision.current) return null;
    if (!session) {
      setAuthToken(null);
      setAuthUser(null);
      setOrganizations([]);
      setActiveOrgId(null);
      await SecureStore.deleteItemAsync(tokenKey(url)).catch(() => {});
      return null;
    }
    setAuthToken(token);
    setAuthUser(session.user);
    let orgs = await mobileListOrganizations(url, token);
    if (revision !== authRevision.current) return null;
    let resolvedOrgId = session.activeOrganizationId;
    if (orgs.length === 0) {
      const created = await mobileCreateOrganization(url, token, `${session.user.name}'s Community`).catch(
        () => null,
      );
      if (created) orgs = [created];
    }
    if (!resolvedOrgId && orgs[0]?.id) {
      await mobileSetActiveOrganization(url, token, orgs[0].id).catch(() => {});
      resolvedOrgId = orgs[0].id;
    }
    if (revision !== authRevision.current) return null;
    setOrganizations(orgs);
    setActiveOrgId(resolvedOrgId);
    return session;
  }, []);

  useEffect(() => {
    void SecureStore.getItemAsync(SERVER_URL_KEY).catch(() => null).then(async (savedUrl) => {
      let resolvedUrl = DEFAULT_SERVER_URL;
      if (savedUrl) {
        try {
          resolvedUrl = normalizeServerUrl(savedUrl);
        } catch {
          resolvedUrl = DEFAULT_SERVER_URL;
        }
      }
      selectedUrl.current = resolvedUrl;
      setServerUrl(resolvedUrl);
      const savedToken = await SecureStore.getItemAsync(tokenKey(resolvedUrl));
      if (savedToken) {
        setAuthToken(savedToken);
        await hydrateSessionAndOrgs(resolvedUrl, savedToken).catch(error => setSessionError(String(error)));
      }
    }).catch(error => setSessionError(String(error))).finally(() => setHydrated(true));
  }, [hydrateSessionAndOrgs]);

  const currentUserId = authUser?.id || (instance?.authRequired ? '' : 'u-owner');
  const authRequired = Boolean(instance?.authRequired);
  const canQueryWorkspace = hydrated && Boolean(instance) && Boolean(serverUrl) && (!authRequired || Boolean(authToken));

  useEffect(() => onSessionExpired((serverUrl, authToken) => {
        const active = activeCredentials.current;
        if (selectedUrl.current === serverUrl &&
            active.serverUrl === serverUrl && active.authToken === authToken) {
          activeCredentials.current = { serverUrl, authToken: null };
          ++authRevision.current;
          setAuthToken(null);
          setAuthUser(null);
          setOrganizations([]);
          setActiveOrgId(null);
          queryClient.clear();
          void SecureStore.deleteItemAsync(tokenKey(serverUrl)).catch(() => {});
          Alert.alert('登录已过期', '请重新登录以继续。');
        }
  }), [queryClient]);

  const client = useMemo(() => {
    if (!serverUrl) return null;
    return new BubaiClient({
      baseUrl: serverUrl, token: authToken || undefined,
      fetchImpl: async (url, init) => {
        const res = await fetch(url, init);
        checkSessionResponse(res.status, serverUrl, authToken);
        return res;
      },
    });
  }, [authToken, queryClient, serverUrl]);

  const discovery = useQuery({
    queryKey: ['instance', serverUrl],
    enabled: hydrated && Boolean(client),
    queryFn: () => client!.getInstance(),
  });
  useEffect(() => {
    if (discovery.data) setInstance(discovery.data);
  }, [discovery.data]);

  const bootstrapQueryKey = useMemo(
    () => ['bootstrap', serverUrl, currentUserId, activeOrgId, Boolean(authToken)] as const,
    [activeOrgId, authToken, currentUserId, serverUrl],
  );

  const bootstrapQuery = useQuery<BootstrapPayload>({
    queryKey: bootstrapQueryKey,
    enabled: canQueryWorkspace && Boolean(client),
    queryFn: async () => {
      if (!client) throw new Error('Not connected');
      return client.bootstrap(currentUserId);
    },
    retry: 1,
    staleTime: 10_000,
  });

  const refreshWorkspaceSoon = useRef<() => void>(() => {});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    refreshWorkspaceSoon.current = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({queryKey: bootstrapQueryKey});
        void queryClient.invalidateQueries({queryKey: ['activity', serverUrl, activeOrgId, currentUserId]});
      }, 350);
    };
    return () => { clearTimeout(timer); refreshWorkspaceSoon.current = () => {}; };
  }, [queryClient, bootstrapQueryKey, serverUrl, activeOrgId, currentUserId]);

  // WebSocket live subscription + AppState foreground resume
  useEffect(() => {
    if (!client || !canQueryWorkspace) return;

    const handleEvent = (event: ServerWsEvent) => {
      if (event.type === 'message.created' || event.type === 'channel.members.updated') {
        refreshWorkspaceSoon.current();
      }
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
          case 'channel.deleted':
            return { ...prev, channels: prev.channels.filter(c => c.id !== event.payload.id) };
          default:
            return prev;
        }
      });
    };

    const handle = client.connectWebSocket({
      userId: currentUserId,
      onEvent: handleEvent,
      onStateChange: state => {
        setWsState(state);
        if (state === 'open') {
          void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
          if (authToken && retrySession.current) void hydrateSessionAndOrgs(client.baseUrl, authToken).catch(error => setSessionError(String(error)));
        }
      },
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
  }, [bootstrapQueryKey, canQueryWorkspace, client, currentUserId, queryClient, authToken, authUser, hydrateSessionAndOrgs, serverUrl, activeOrgId]);

  const connectToServer = useCallback(async (rawUrl: string): Promise<InstanceInfo & { signedIn: boolean }> => {
    const normalized = normalizeServerUrl(rawUrl);
    const revision = ++authRevision.current;
    const probeClient = new BubaiClient({ baseUrl: normalized });
    const info = await probeClient.getInstance();
    const token = await SecureStore.getItemAsync(tokenKey(normalized));
    if (authRevision.current !== revision) throw new Error('服务器选择已更新');
    selectedUrl.current = normalized;
    SecureStore.setItem(SERVER_URL_KEY, normalized);
    setAuthToken(token);
    setAuthUser(null);
    setOrganizations([]);
    setActiveOrgId(null);
    setSessionError(null);
    setInstance(info);
    setServerUrl(normalized);
    const session = token ? await hydrateSessionAndOrgs(normalized, token) : null;
    return { ...info, signedIn: Boolean(session) };
  }, [hydrateSessionAndOrgs]);

  const disconnectServer = useCallback(async () => {
    ++authRevision.current;
    await Promise.all([
      SecureStore.deleteItemAsync(SERVER_URL_KEY).catch(() => {}),
      serverUrl && SecureStore.deleteItemAsync(tokenKey(serverUrl)).catch(() => {}),
    ]);
    selectedUrl.current = null;
    setServerUrl(null);
    setAuthToken(null);
    setAuthUser(null);
    setOrganizations([]);
    setActiveOrgId(null);
    setInstance(null);
  }, [serverUrl]);

  const sendEmailOtp = useCallback(
    async (email: string) => {
      if (!serverUrl) throw new Error('Not connected to server');
      await mobileSendEmailOtp(serverUrl, email);
    },
    [serverUrl],
  );

  const completeMobileLogin = useCallback(
    async (token: string) => {
      if (!serverUrl || serverUrl !== selectedUrl.current) throw new Error('服务器选择已更新');
      await SecureStore.setItemAsync(tokenKey(serverUrl), token).catch(() => {});
      await hydrateSessionAndOrgs(serverUrl, token);
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
    },
    [hydrateSessionAndOrgs, queryClient, serverUrl],
  );

  const signInWithOtp = useCallback(
    async (email: string, otp: string) => {
      if (!serverUrl) throw new Error('Not connected to server');
      const session = await mobileSignInWithEmailOtp(serverUrl, email, otp);
      await completeMobileLogin(session.token);
    },
    [completeMobileLogin, serverUrl],
  );

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      if (!serverUrl) throw new Error('Not connected to server');
      const session = await mobileSignInWithPassword(serverUrl, email, password);
      await completeMobileLogin(session.token);
    },
    [completeMobileLogin, serverUrl],
  );

  const signUpWithPassword = useCallback(
    async (email: string, password: string, name: string) => {
      if (!serverUrl) throw new Error('Not connected to server');
      const session = await mobileSignUpWithPassword(serverUrl, email, password, name);
      if (!session) return false;
      await completeMobileLogin(session.token);
      return true;
    },
    [completeMobileLogin, serverUrl],
  );

  const reloadAccount = useCallback(async () => {
    if (serverUrl && authToken) await hydrateSessionAndOrgs(serverUrl, authToken);
    await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
  }, [serverUrl, authToken, queryClient, hydrateSessionAndOrgs]);
  const switchOrganization = useCallback(
    async (orgId: string) => {
      if (!serverUrl || !authToken) return;
      await mobileSetActiveOrganization(serverUrl, authToken, orgId);
      setActiveOrgId(orgId);
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
    },
    [authToken, queryClient, serverUrl],
  );

  const enableNotifications = useCallback(async () => {
    if (!client || !serverUrl || !authToken) throw new Error('请先登录');
    await registerDevice(client, tokenKey(serverUrl) + '.push');
  }, [serverUrl, authToken, client]);

  const signOut = useCallback(async () => {
    if (client && serverUrl && authToken) {
      await unregisterDevice(client, tokenKey(serverUrl) + '.push');
      await mobileSignOut(serverUrl, authToken);
    }
    ++authRevision.current;
    if (serverUrl) await SecureStore.deleteItemAsync(tokenKey(serverUrl)).catch(() => {});
    setAuthToken(null);
    setAuthUser(null);
    setOrganizations([]);
    setActiveOrgId(null);
    queryClient.clear();
  }, [authToken, client, queryClient, serverUrl]);

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

  const sendTyping = useCallback((channelId: string) => {
    wsHandleRef.current?.send({ type: 'typing.start', payload: { channelId, userId: currentUserId } });
  }, [currentUserId]);
  const outgoingIds = useMemo(() => new Map<string, string>(), [client, currentUserId, activeOrgId]);
  const sendWsMessage = useCallback<BubaiContextValue['sendWsMessage']>(async payload => {
    const handle = wsHandleRef.current;
    if (!handle) throw new Error('尚未连接');
    const workspace = queryClient.getQueryData<BootstrapPayload>(bootstrapQueryKey);
    const channel = workspace?.channels.find(ch => ch.id === payload.channelId);
    if (channel?.kind !== 'dm' && channel?.memberIds && workspace && client) {
      const outsiders = findMentionedNonMemberAgents(payload.content, workspace.participants, new Set(channel.memberIds));
      if (outsiders.length) {
        const invite = await new Promise<'invite' | 'send' | 'cancel'>(resolve =>
          Alert.alert('提到了频道外的 Agent', outsiders.map(agent => agent.name).join('、'), [
            { text: '取消', style: 'cancel', onPress: () => resolve('cancel') },
            { text: '仅发送', onPress: () => resolve('send') },
            { text: '邀请并发送', onPress: () => resolve('invite') },
          ], { cancelable: true, onDismiss: () => resolve('cancel') }));
        if (invite === 'cancel') throw new Error('已取消发送');
        if (invite === 'invite') await Promise.all(outsiders.map(agent => client.upsertChannelMember(channel.id, { agentId: agent.id })));
      }
    }
    const key = JSON.stringify(payload);
    const messageId = outgoingIds.get(key) ?? globalThis.expo.uuidv4();
    outgoingIds.set(key, messageId);
    await handle.sendMessage({ ...payload, messageId, senderId: currentUserId });
    outgoingIds.delete(key);
  }, [currentUserId, outgoingIds, client, bootstrapQueryKey, queryClient]);

  const subscribeWsEvents = useCallback((listener: (event: ServerWsEvent) => void) => {
    wsListenersRef.current.add(listener);
    return () => {
      wsListenersRef.current.delete(listener);
    };
  }, []);

  const scheduleRead = useRef<(channelId: string, rootId?: string) => void>(() => {});
  useEffect(() => {
    if (!client) return;
    const reads = coalescedRefresh(async (key: string) => {
      const [channelId, rootId] = JSON.parse(key) as [string, string | null];
      return rootId ? client.markThreadRead(channelId, rootId, currentUserId)
        : client.markChannelRead(channelId, currentUserId);
    }, () => refreshWorkspaceSoon.current());
    scheduleRead.current = (channelId, rootId) => reads.schedule(JSON.stringify([channelId, rootId]));
    return () => { reads.close(); scheduleRead.current = () => {}; };
  }, [client, currentUserId, activeOrgId]);
  const markThreadRead = useCallback((channelId: string, rootId: string) => {
    scheduleRead.current(channelId, rootId);
  }, []);

  const clearChannelUnread = useCallback(
    (channelId: string) => {
      queryClient.setQueryData<BootstrapPayload>(bootstrapQueryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          channels: prev.channels.map((c) =>
            c.id === channelId ? { ...c, unreadCount: 0, markedUnread: false } : c,
          ),
        };
      });
      scheduleRead.current(channelId);
    },
    [bootstrapQueryKey, queryClient],
  );

  const data = bootstrapQuery.data;
  const value = useMemo<BubaiContextValue>(
    () => ({
      hydrated: hydrated && !(serverUrl && !discovery.isError && !instance),
      serverUrl,
      authToken,
      authUser,
      authRequired,
      organizations,
      activeOrgId,
      currentUserId,
      client,
      wsState,
      instance,
      sidebarGroups: data?.sidebarGroups ?? [],
      channels: data?.channels ?? [],
      participants: data?.participants ?? [],
      sessions: data?.sessions ?? [],
      asks: data?.asks ?? [],
      botmuxConnected: Boolean(data?.botmuxStatus?.authenticated ?? instance?.botmux?.authenticated),
      isLoading: bootstrapQuery.isLoading,
      error: sessionError ?? discovery.error?.message ?? (bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : null),
      connectToServer,
      disconnectServer,
      sendEmailOtp,
      signInWithOtp,
      signInWithPassword,
      signUpWithPassword,
      reloadAccount,
      switchOrganization,
      enableNotifications,
      signOut,
      refreshBootstrap,
      answerAsk,
      sendTyping,
      sendWsMessage,
      subscribeWsEvents,
      markThreadRead,
      clearChannelUnread,
    }),
    [
      activeOrgId,
      answerAsk,
      authRequired,
      authToken,
      authUser,
      discovery.isError,
      discovery.error,
      sessionError,
      bootstrapQuery.error,
      bootstrapQuery.isLoading,
      markThreadRead,
      clearChannelUnread,
      client,
      connectToServer,
      currentUserId,
      data,
      disconnectServer,
      hydrated,
      instance,
      organizations,
      refreshBootstrap,
      sendEmailOtp,
      sendTyping,
      sendWsMessage,
      serverUrl,
      signInWithOtp,
      signInWithPassword,
      enableNotifications,
      signOut,
      signUpWithPassword,
      subscribeWsEvents,
      reloadAccount,
      switchOrganization,
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
