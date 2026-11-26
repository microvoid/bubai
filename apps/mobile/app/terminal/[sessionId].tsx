import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BuzzAvatar } from '@/components/BuzzAvatar';
import { BuzzBadge } from '@/components/BuzzComponents';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

// Dynamically resolve WebView so pre-linked native binaries degrade cleanly without crashing.
let NativeWebView: React.ComponentType<{
  ref?: React.Ref<unknown>;
  source: { uri: string };
  style?: unknown;
  containerStyle?: unknown;
  originWhitelist?: string[];
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  allowsInlineMediaPlayback?: boolean;
  sharedCookiesEnabled?: boolean;
  onError?: (e: { nativeEvent: { description?: string; code?: number } }) => void;
  onHttpError?: (e: { nativeEvent: { statusCode?: number; url?: string } }) => void;
  onLoadEnd?: (e: { nativeEvent: { url?: string; title?: string } }) => void;
}> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  NativeWebView = require('react-native-webview').WebView;
} catch {
  NativeWebView = null;
}

const TOUCH_KEYS: Array<{ label: string; key: string; code: string; ctrl?: boolean }> = [
  { label: 'Esc', key: 'Escape', code: 'Escape' },
  { label: 'Ctrl+C', key: 'c', code: 'KeyC', ctrl: true },
  { label: 'Tab', key: 'Tab', code: 'Tab' },
  { label: '↑', key: 'ArrowUp', code: 'ArrowUp' },
  { label: '↓', key: 'ArrowDown', code: 'ArrowDown' },
  { label: 'Enter', key: 'Enter', code: 'Enter' },
];

export default function TerminalScreen() {
  const { sessionId: rawSid, agentId: rawAgentId } = useLocalSearchParams<{
    sessionId: string;
    agentId?: string;
  }>();
  const initialSessionId = Array.isArray(rawSid) ? rawSid[0] : rawSid || '';
  const initialAgentId = Array.isArray(rawAgentId) ? rawAgentId[0] : rawAgentId;

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const { client, participants, sessions, refreshBootstrap } = useBubai();

  const [sessionId, setSessionId] = useState(initialSessionId);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [linkLoaded, setLinkLoaded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyText, setHistoryText] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [webError, setWebError] = useState<string | null>(null);
  const webViewRef = useRef<{ injectJavaScript?: (script: string) => void } | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === sessionId),
    [sessionId, sessions],
  );
  const resolvedAgentId = activeSession?.larkAppId || initialAgentId;
  const agent = useMemo(
    () => participants.find((p) => p.role === 'agent' && p.id === resolvedAgentId),
    [participants, resolvedAgentId],
  );
  const siblingSessions = useMemo(
    () =>
      resolvedAgentId
        ? sessions.filter((s) => s.larkAppId === resolvedAgentId)
        : activeSession
          ? [activeSession]
          : [],
    [activeSession, resolvedAgentId, sessions],
  );

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (switcherOpen) {
        setSwitcherOpen(false);
        return true;
      }
      if (showHistory) {
        setShowHistory(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [showHistory, switcherOpen]);

  useEffect(() => {
    if (!client || !sessionId) return;
    setLinkLoaded(false);
    setTerminalUrl(null);
    void client
      .getTerminalWriteLink(sessionId)
      .then((res) => {
        setTerminalUrl(res.url || null);
      })
      .catch(() => {
        setTerminalUrl(null);
      })
      .finally(() => setLinkLoaded(true));
  }, [client, sessionId]);

  const handleToggleHistory = async () => {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setShowHistory(true);
    if (!client) return;
    setHistoryText('Loading session history…');
    try {
      const data = await client.getSessionHistory(sessionId);
      setHistoryText(JSON.stringify(data, null, 2));
    } catch (err) {
      setHistoryText(err instanceof Error ? err.message : '无法加载历史');
    }
  };

  const handleSessionOp = async (op: 'restart' | 'close' | 'resume') => {
    if (!client) return;
    setBusyOp(op);
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await client.sessionAction(sessionId, op);
      void refreshBootstrap();
    } finally {
      setBusyOp(null);
    }
  };

  const sendTouchKey = (spec: (typeof TOUCH_KEYS)[number]) => {
    void Haptics.selectionAsync();
    const js = `
      (function() {
        var el = document.activeElement || document.querySelector('textarea, canvas, body');
        if (!el) return;
        var ev = new KeyboardEvent('keydown', {
          key: ${JSON.stringify(spec.key)},
          code: ${JSON.stringify(spec.code)},
          ctrlKey: ${Boolean(spec.ctrl)},
          bubbles: true,
          cancelable: true
        });
        el.dispatchEvent(ev);
      })();
      true;
    `;
    webViewRef.current?.injectJavaScript?.(js);
  };

  const sessionState = (activeSession?.state || activeSession?.status || 'active').toLowerCase();
  const isLive = sessionState !== 'closed' && sessionState !== 'offline';

  return (
    <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: insets.top }]}>
      {/* Semantic Top Header */}
      <View style={[styles.header, { borderBottomColor: colors.outline }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>

        <View style={styles.identity}>
          {agent && (
            <Pressable
              onPress={() => router.push(`/agent/${encodeURIComponent(agent.id)}`)}
              style={styles.agentBtn}
            >
              <BuzzAvatar
                name={agent.name}
                uri={agent.avatarUrl}
                size={28}
                isAgent
                status={agent.status}
              />
              <Text
                style={[buzzTypography.titleSmall, styles.agentName, { color: colors.onSurface }]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {agent.name}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => siblingSessions.length > 1 && setSwitcherOpen(true)}
            style={[styles.sessionPill, { backgroundColor: colors.surfaceContainerLow }]}
          >
            <Text
              style={[buzzTypography.micro, styles.sessionTitle, { color: colors.onSurface }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {activeSession?.title || sessionId.slice(0, 8)}
            </Text>
            {siblingSessions.length > 1 && (
              <Ionicons name="chevron-down" size={12} color={colors.onSurfaceVariant} />
            )}
          </Pressable>
        </View>

        <View style={styles.actions}>
          <Pressable onPress={() => void handleToggleHistory()} style={styles.iconBtn}>
            <Ionicons
              name={showHistory ? 'terminal-outline' : 'time-outline'}
              size={20}
              color={colors.onSurface}
            />
          </Pressable>
          <Pressable
            disabled={busyOp !== null}
            onPress={() => void handleSessionOp('restart')}
            style={styles.iconBtn}
          >
            <Ionicons name="refresh-outline" size={20} color={colors.onSurface} />
          </Pressable>
        </View>
      </View>

      {/* Framed Dark Terminal Stage */}
      <View style={styles.stage}>
        <View style={[styles.frame, { borderColor: colors.outline }]}>
          <View style={styles.viewport}>
            {showHistory ? (
              <ScrollView contentContainerStyle={{ padding: 14 }}>
                <Text style={styles.historyText} selectable>
                  {historyText || 'Loading…'}
                </Text>
              </ScrollView>
            ) : !linkLoaded ? (
              <View style={styles.placeholder}>
                <ActivityIndicator color="#9ca3af" />
                <Text style={styles.placeholderText}>正在连接 Botmux 终端代理…</Text>
              </View>
            ) : terminalUrl && NativeWebView ? (
              <View style={{ flex: 1, backgroundColor: '#0d1016' }}>
                <NativeWebView
                  ref={webViewRef}
                  source={{ uri: terminalUrl }}
                  originWhitelist={['*']}
                  containerStyle={{ flex: 1, backgroundColor: '#0d1016' }}
                  style={{ flex: 1, backgroundColor: '#0d1016' }}
                  javaScriptEnabled
                  domStorageEnabled
                  sharedCookiesEnabled
                  allowsInlineMediaPlayback
                  onError={(e) => {
                    const desc = e.nativeEvent?.description || 'WebView load failed';
                    setWebError(desc);
                  }}
                  onLoadEnd={(e) => {
                    setWebError(null);
                    const loadedUrl = e.nativeEvent?.url || '';
                    // Work around react-native-webview Fabric race on iOS where initial mount loads about:blank.
                    if (
                      Platform.OS === 'ios' &&
                      terminalUrl &&
                      (!loadedUrl || loadedUrl === 'about:blank')
                    ) {
                      webViewRef.current?.injectJavaScript?.(
                        `window.location.replace(${JSON.stringify(terminalUrl)}); true;`,
                      );
                    }
                  }}
                />
                {webError && (
                  <View style={[styles.placeholder, StyleSheet.absoluteFillObject, { backgroundColor: '#0d1016' }]}>
                    <Ionicons name="warning-outline" size={24} color="#f59e0b" />
                    <Text style={styles.placeholderText}>{webError}</Text>
                  </View>
                )}
              </View>
            ) : (
              <View style={styles.placeholder}>
                <Ionicons name="terminal-outline" size={28} color="#9ca3af" />
                <Text style={styles.placeholderText}>
                  {terminalUrl
                    ? '当前二进制尚未链接 WebView 原生模块，可在系统浏览器打开代理终端。'
                    : '当前会话终端不可用。'}
                </Text>
                {terminalUrl && (
                  <Pressable
                    onPress={() => void Linking.openURL(terminalUrl)}
                    style={[styles.openBrowserBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[buzzTypography.label, { color: colors.onPrimary }]}>
                      Open Terminal in Browser
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>

          {/* Status Footer */}
          <View style={styles.statusBar}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: isLive ? '#22c55e' : '#6b7280' },
                ]}
              />
              <Text style={styles.statusText}>
                {busyOp ? `${busyOp}…` : sessionState}
              </Text>
              {!!activeSession?.workingDir && (
                <Text style={styles.dirText} numberOfLines={1}>
                  {activeSession.workingDir}
                </Text>
              )}
            </View>
            <Text style={styles.sidText}>{sessionId.slice(0, 8)}</Text>
          </View>
        </View>
      </View>

      {/* Mobile Touch Shortcut Bar */}
      <View
        style={[
          styles.shortcutBar,
          {
            backgroundColor: colors.surfaceContainerLow,
            borderTopColor: colors.outline,
            paddingBottom: Math.max(insets.bottom, 8),
          },
        ]}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.shortcutScroll}
        >
          {TOUCH_KEYS.map((spec) => (
            <Pressable
              key={spec.label}
              onPress={() => sendTouchKey(spec)}
              style={({ pressed }) => [
                styles.keyBtn,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.outline,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text style={[buzzTypography.label, { color: colors.onSurface }]}>
                {spec.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Session Switcher Modal */}
      <Modal
        visible={switcherOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSwitcherOpen(false)}
      >
        <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: Platform.OS === 'android' ? insets.top : 8 }]}>
          <View style={[styles.header, { borderBottomColor: colors.outline }]}>
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}>
              Switch Session ({siblingSessions.length})
            </Text>
            <Pressable onPress={() => setSwitcherOpen(false)} style={styles.iconBtn}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: buzzGrid.gutter, paddingBottom: Math.max(insets.bottom, 20), gap: 10 }}>
            {siblingSessions.map((s) => {
              const st = (s.state || s.status || 'active').toLowerCase();
              return (
                <TouchableOpacity
                  key={s.sessionId}
                  onPress={() => {
                    setSessionId(s.sessionId);
                    setShowHistory(false);
                    setSwitcherOpen(false);
                  }}
                  style={[
                    styles.switchRow,
                    { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                      {s.title || s.sessionId.slice(0, 8)}
                    </Text>
                    <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                      {s.sessionId}
                    </Text>
                  </View>
                  <BuzzBadge label={st} tone={st !== 'closed' ? 'success' : 'neutral'} />
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    height: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { padding: 6 },
  identity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    overflow: 'hidden',
  },
  agentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
  },
  agentName: {
    flexShrink: 1,
    minWidth: 0,
  },
  sessionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: buzzRadii.pill,
    flexShrink: 1,
    maxWidth: 112,
    minWidth: 0,
  },
  sessionTitle: {
    flexShrink: 1,
    minWidth: 0,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  stage: {
    flex: 1,
    padding: 10,
  },
  frame: {
    flex: 1,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#0d1016',
    overflow: 'hidden',
  },
  viewport: {
    flex: 1,
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
  },
  placeholderText: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 13,
    textAlign: 'center',
  },
  openBrowserBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: buzzRadii.pill,
    marginTop: 6,
  },
  historyText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11.5,
    lineHeight: 17,
    color: 'rgba(240,244,248,0.9)',
  },
  statusBar: {
    height: 30,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '600',
  },
  dirText: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    flex: 1,
  },
  sidText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  shortcutBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  shortcutScroll: {
    paddingHorizontal: 12,
    gap: 8,
  },
  keyBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: buzzRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
