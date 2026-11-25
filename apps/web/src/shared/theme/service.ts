/**
 * Ported from references/buzz-app/src/shared/theme/service.ts.
 * Owns color mode, accent palette, bubble contrast (color-level: touch | high),
 * message width, font scale, and message density with localStorage persistence.
 */
import { useSyncExternalStore } from 'react';
import {
  ACCENT_KEY,
  CONTRAST_KEY,
  DEFAULT_ACCENT,
  LEGACY_BUBBLE_KEY,
  parseAccent,
  parseContrast,
  parseLegacyBubbleColor,
  type Accent,
  type Contrast,
} from './accent';

export type ColorMode = 'light' | 'dark';
export type ColorModePreference = ColorMode | 'system';
export const APPEARANCE_KEY = 'buzz-appearance.v1';
const LEGACY_THEME_KEY = 'buzz-theme-mode';

export type MessageWidth = 'narrow' | 'wide';
export const MESSAGE_WIDTH_KEY = 'buzz-message-width.v1';
export const parseMessageWidth = (value: unknown): MessageWidth =>
  value === 'wide' ? 'wide' : 'narrow';

export const FONT_SCALE_KEY = 'buzz-font-scale.v1';
export const MIN_FONT_SCALE = 0.8;
export const MAX_FONT_SCALE = 2;
export function parseFontScale(value: unknown): number {
  const number =
    typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' &&
    Number.isFinite(number) &&
    number >= MIN_FONT_SCALE &&
    number <= MAX_FONT_SCALE
    ? Math.round(number * 10) / 10
    : 1;
}

export const parseColorModePreference = (
  value: unknown,
): ColorModePreference =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'dark';

export type MessageDensity = 'default' | 'compact';
export const DENSITY_KEY = 'buzz-message-density.v1';
export const parseMessageDensity = (value: unknown): MessageDensity =>
  value === 'compact' ? 'compact' : 'default';

export interface AppearanceSnapshot {
  readonly preference: ColorModePreference;
  readonly mode: ColorMode;
  readonly messageWidth: MessageWidth;
  readonly fontScale: number;
  readonly accent: Accent;
  readonly contrast: Contrast;
  readonly density: MessageDensity;
}

export function createAppearance(
  host: Window | undefined = typeof window === 'undefined' ? undefined : window,
) {
  const systemScheme = host?.matchMedia?.('(prefers-color-scheme: dark)');
  const resolvedMode = (preference: ColorModePreference): ColorMode =>
    preference === 'system'
      ? systemScheme?.matches
        ? 'dark'
        : 'light'
      : preference;

  let state: AppearanceSnapshot = {
    preference: 'dark',
    mode: 'dark',
    messageWidth: 'narrow',
    fontScale: 1,
    accent: DEFAULT_ACCENT,
    contrast: 'low',
    density: 'default',
  };

  let disposed = false;
  let paletteGuard = 0;
  const listeners = new Set<() => void>();

  const apply = () => {
    if (!host) return;
    const root = host.document.documentElement;
    const nextColorLevel = state.contrast === 'low' ? 'touch' : state.contrast;
    const changingPalette =
      root.dataset.colorMode &&
      (root.dataset.colorMode !== state.mode ||
        root.dataset.accent !== state.accent ||
        root.dataset.colorLevel !== nextColorLevel);
    const guard = changingPalette ? ++paletteGuard : undefined;
    if (guard) root.dataset.paletteChanging = '';

    root.dataset.colorMode = state.mode;
    root.classList.toggle('dark', state.mode === 'dark');
    root.classList.toggle('light', state.mode === 'light');
    root.dataset.accent = state.accent;
    root.dataset.colorLevel = nextColorLevel;
    root.dataset.messageDensity = state.density;
    root.style.setProperty(
      '--buzz-message-width',
      state.messageWidth === 'wide' ? '78rem' : '52rem',
    );
    root.style.setProperty('--buzz-text-scale', String(state.fontScale));

    if (guard) {
      void root.offsetHeight;
      host.requestAnimationFrame(() =>
        host.requestAnimationFrame(() => {
          if (guard === paletteGuard) delete root.dataset.paletteChanging;
        }),
      );
    }
  };

  const notify = () => {
    apply();
    for (const listener of listeners) listener();
  };

  const restoreAll = () => {
    try {
      const savedMode =
        host?.localStorage.getItem(APPEARANCE_KEY) ??
        host?.localStorage.getItem(LEGACY_THEME_KEY);
      const preference = parseColorModePreference(savedMode);
      const savedAccent = host?.localStorage.getItem(ACCENT_KEY);
      const accent =
        savedAccent != null
          ? parseAccent(savedAccent)
          : parseLegacyBubbleColor(
              host?.localStorage.getItem(LEGACY_BUBBLE_KEY),
            );
      const contrast = parseContrast(host?.localStorage.getItem(CONTRAST_KEY));
      const messageWidth = parseMessageWidth(
        host?.localStorage.getItem(MESSAGE_WIDTH_KEY),
      );
      const fontScale = parseFontScale(
        host?.localStorage.getItem(FONT_SCALE_KEY),
      );
      const density = parseMessageDensity(
        host?.localStorage.getItem(DENSITY_KEY),
      );
      state = {
        preference,
        mode: resolvedMode(preference),
        accent,
        contrast,
        messageWidth,
        fontScale,
        density,
      };
    } catch {
      // keep defaults
    }
    notify();
  };

  const onSystemSchemeChange = () => {
    if (disposed || state.preference !== 'system') return;
    const mode = resolvedMode('system');
    if (mode === state.mode) return;
    state = { ...state, mode };
    notify();
  };

  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === APPEARANCE_KEY ||
      event.key === LEGACY_THEME_KEY ||
      event.key === ACCENT_KEY ||
      event.key === LEGACY_BUBBLE_KEY ||
      event.key === CONTRAST_KEY ||
      event.key === MESSAGE_WIDTH_KEY ||
      event.key === FONT_SCALE_KEY ||
      event.key === DENSITY_KEY
    ) {
      restoreAll();
    }
  };

  restoreAll();
  host?.addEventListener('storage', onStorage);
  systemScheme?.addEventListener('change', onSystemSchemeChange);

  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMode(preference: ColorModePreference) {
      if (disposed) return;
      try {
        host?.localStorage.setItem(APPEARANCE_KEY, preference);
      } catch {
        // ignore storage errors
      }
      state = { ...state, preference, mode: resolvedMode(preference) };
      notify();
    },
    setAccent(value: Accent) {
      if (disposed) return;
      const accent = parseAccent(value);
      try {
        host?.localStorage.setItem(ACCENT_KEY, accent);
      } catch {
        // ignore
      }
      state = { ...state, accent };
      notify();
    },
    setContrast(value: Contrast) {
      if (disposed) return;
      const contrast = parseContrast(value);
      try {
        host?.localStorage.setItem(CONTRAST_KEY, contrast);
      } catch {
        // ignore
      }
      state = { ...state, contrast };
      notify();
    },
    setMessageWidth(value: MessageWidth) {
      if (disposed) return;
      const messageWidth = parseMessageWidth(value);
      try {
        host?.localStorage.setItem(MESSAGE_WIDTH_KEY, messageWidth);
      } catch {
        // ignore
      }
      state = { ...state, messageWidth };
      notify();
    },
    setDensity(value: MessageDensity) {
      if (disposed) return;
      const density = parseMessageDensity(value);
      try {
        host?.localStorage.setItem(DENSITY_KEY, density);
      } catch {
        // ignore
      }
      state = { ...state, density };
      notify();
    },
    dispose() {
      disposed = true;
      host?.removeEventListener('storage', onStorage);
      systemScheme?.removeEventListener('change', onSystemSchemeChange);
      listeners.clear();
    },
  };
}

export type Appearance = ReturnType<typeof createAppearance>;

export const appearance = createAppearance();

export function useAppearance(): AppearanceSnapshot {
  return useSyncExternalStore(
    appearance.subscribe,
    appearance.snapshot,
    appearance.snapshot,
  );
}
