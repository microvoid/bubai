import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import {
  buzzAccentChoices,
  getBuzzAccent,
  getBuzzColors,
  type BuzzColorScheme,
  type ThemeMode,
} from '@buzz-botmux/design-tokens';

export type ThemePreference = 'system' | ThemeMode;

const THEME_PREF_KEY = 'bubai.theme.mode';
const ACCENT_PREF_KEY = 'bubai.theme.accent';

interface BuzzThemeContextValue {
  preference: ThemePreference;
  mode: ThemeMode;
  colors: BuzzColorScheme;
  accentId: string;
  accent: { fill: string; foreground: string };
  setPreference: (next: ThemePreference) => void;
  setAccentId: (next: string) => void;
}

const BuzzThemeContext = createContext<BuzzThemeContextValue | null>(null);

export function BuzzThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [accentId, setAccentIdState] = useState<string>(buzzAccentChoices[1].id);

  useEffect(() => {
    void Promise.all([
      SecureStore.getItemAsync(THEME_PREF_KEY).catch(() => null),
      SecureStore.getItemAsync(ACCENT_PREF_KEY).catch(() => null),
    ]).then(([savedMode, savedAccent]) => {
      if (savedMode === 'light' || savedMode === 'dark' || savedMode === 'system') {
        setPreferenceState(savedMode);
      }
      if (savedAccent) {
        setAccentIdState(savedAccent);
      }
    });
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    void SecureStore.setItemAsync(THEME_PREF_KEY, next).catch(() => {});
  }, []);

  const setAccentId = useCallback((next: string) => {
    setAccentIdState(next);
    void SecureStore.setItemAsync(ACCENT_PREF_KEY, next).catch(() => {});
  }, []);

  const mode: ThemeMode =
    preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

  const value = useMemo<BuzzThemeContextValue>(
    () => ({
      preference,
      mode,
      colors: getBuzzColors(mode),
      accentId,
      accent: getBuzzAccent(accentId, mode),
      setPreference,
      setAccentId,
    }),
    [accentId, mode, preference, setAccentId, setPreference],
  );

  return <BuzzThemeContext.Provider value={value}>{children}</BuzzThemeContext.Provider>;
}

export function useBuzzTheme(): BuzzThemeContextValue {
  const ctx = useContext(BuzzThemeContext);
  if (!ctx) throw new Error('useBuzzTheme must be used inside BuzzThemeProvider');
  return ctx;
}
