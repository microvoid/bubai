/**
 * Cross-platform Buzz Design Tokens extracted from
 * references/buzz/mobile/lib/shared/theme/{color_scheme,grid,chat_colors,avatar_shape}.dart
 * and apps/web/src/shared/styles/tokens.css.
 */

export type ThemeMode = 'light' | 'dark';

export interface BuzzColorScheme {
  brightness: ThemeMode;
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  success: string;
  warning: string;
  surface: string;
  onSurface: string;
  onSurfaceVariant: string;
  outline: string;
  outlineVariant: string;
  inverseSurface: string;
  onInverseSurface: string;
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
  receivedBubble: string;
  scrim: string;
}

export const lightColorScheme: BuzzColorScheme = {
  brightness: 'light',
  primary: '#262626',
  onPrimary: '#FFFFFF',
  primaryContainer: '#F0F0F0',
  onPrimaryContainer: '#0A0A0A',
  secondary: '#646464',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#F0F0F0',
  onSecondaryContainer: '#0A0A0A',
  tertiary: '#0B5FA8',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#E6F4FE',
  onTertiaryContainer: '#113264',
  error: '#CE2C31',
  onError: '#FFFFFF',
  errorContainer: '#FEEBEC',
  onErrorContainer: '#641723',
  success: '#18794E',
  warning: '#AD5700',
  surface: '#FFFFFF',
  onSurface: '#0A0A0A',
  onSurfaceVariant: '#646464',
  outline: '#E8E8E8',
  outlineVariant: '#E8E8E8',
  inverseSurface: '#262626',
  onInverseSurface: '#FFFFFF',
  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#F5F5F6',
  surfaceContainer: '#F0F0F0',
  surfaceContainerHigh: '#E8E8E8',
  surfaceContainerHighest: '#F5F5F6',
  receivedBubble: '#F3F3F4',
  scrim: 'rgba(0, 0, 0, 0.45)',
};

export const darkColorScheme: BuzzColorScheme = {
  brightness: 'dark',
  primary: '#FFFFFF',
  onPrimary: '#000000',
  primaryContainer: '#282828',
  onPrimaryContainer: '#FFFFFF',
  secondary: '#C7C7C7',
  onSecondary: '#000000',
  secondaryContainer: '#282828',
  onSecondaryContainer: '#FFFFFF',
  tertiary: '#83C4FF',
  onTertiary: '#000000',
  tertiaryContainer: '#0D2847',
  onTertiaryContainer: '#C2E6FF',
  error: '#FF9592',
  onError: '#191111',
  errorContainer: '#3B1219',
  onErrorContainer: '#FFD1D9',
  success: '#3DD68C',
  warning: '#FFCA16',
  surface: '#000000',
  onSurface: '#FFFFFF',
  onSurfaceVariant: '#C7C7C7',
  outline: '#1A1A1A',
  outlineVariant: '#282828',
  inverseSurface: '#C7C7C7',
  onInverseSurface: '#000000',
  surfaceContainerLowest: '#000000',
  surfaceContainerLow: '#101010',
  surfaceContainer: '#1A1A1A',
  surfaceContainerHigh: '#282828',
  surfaceContainerHighest: '#282828',
  receivedBubble: '#292929',
  scrim: 'rgba(0, 0, 0, 0.65)',
};

export interface BuzzAccentChoice {
  id: string;
  name: string;
  light: string;
  dark: string;
  onLight: string;
  onDark: string;
}

export const buzzAccentChoices: readonly BuzzAccentChoice[] = [
  { id: 'neutral', name: 'Gray', light: '#525252', dark: '#C7C7C7', onLight: '#FFFFFF', onDark: '#000000' },
  { id: '#d7d72e', name: 'Chartreuse', light: '#D7D72E', dark: '#D7D72E', onLight: '#000000', onDark: '#000000' },
  { id: '#f97316', name: 'Flame', light: '#D93A0C', dark: '#D93A0C', onLight: '#FFFFFF', onDark: '#FFFFFF' },
  { id: '#ec4899', name: 'Magenta', light: '#CC1F7A', dark: '#CC1F7A', onLight: '#FFFFFF', onDark: '#FFFFFF' },
  { id: '#c0a2f1', name: 'Iris', light: '#6C4EF0', dark: '#6C4EF0', onLight: '#FFFFFF', onDark: '#FFFFFF' },
  { id: '#3b82f6', name: 'Cobalt', light: '#2B4FE0', dark: '#2B4FE0', onLight: '#FFFFFF', onDark: '#FFFFFF' },
  { id: '#22c55e', name: 'Jade', light: '#0B8467', dark: '#0B8467', onLight: '#FFFFFF', onDark: '#FFFFFF' },
] as const;

/** Buzz Mobile spacing grid (references/buzz/mobile/lib/shared/theme/grid.dart). */
export const buzzGrid = {
  quarter: 2,
  half: 4,
  xxs: 8,
  twelve: 12,
  xs: 16,
  gutter: 20,
  sm: 24,
  md: 32,
  lg: 40,
  xl: 48,
  xxl: 64,
  xxxl: 80,
  inventoryIconSize: 20,
  inventoryLabelGap: 8,
  inventorySectionTopInset: 18,
  inventoryRowInset: 11,
} as const;

export const buzzRadii = {
  xs: 6,
  sm: 10,
  md: 14,
  card: 20,
  sheet: 24,
  pill: 999,
} as const;

export const buzzTypography = {
  largeTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, letterSpacing: -0.4 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' as const, letterSpacing: -0.2 },
  titleSmall: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' as const },
  bodySmall: { fontSize: 13.5, lineHeight: 19, fontWeight: '400' as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const },
} as const;

/**
 * Exact Buzz agent squircle SVG path in a 0..100 coordinate box
 * (matches _agentSquirclePath in references/buzz/mobile/lib/shared/widgets/avatar_shape.dart).
 */
export const BUZZ_AGENT_SQUIRCLE_SVG_PATH =
  'M 50 0 C 93 0 100 7 100 50 C 100 93 93 100 50 100 C 7 100 0 93 0 50 C 0 7 7 0 50 0 Z';

export function getBuzzColors(mode: ThemeMode): BuzzColorScheme {
  return mode === 'dark' ? darkColorScheme : lightColorScheme;
}

export function getBuzzAccent(accentId: string, mode: ThemeMode): { fill: string; foreground: string } {
  const match =
    buzzAccentChoices.find((c) => c.id === accentId || c.name.toLowerCase() === accentId.toLowerCase()) ??
    buzzAccentChoices[1];
  return mode === 'dark'
    ? { fill: match.dark, foreground: match.onDark }
    : { fill: match.light, foreground: match.onLight };
}
