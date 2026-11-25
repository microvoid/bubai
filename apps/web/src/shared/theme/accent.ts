/** Ported from references/buzz-app/src/shared/theme/accent.ts & tokens/brand.ts */
import type { CSSProperties } from 'react';

export const ACCENTS = [
  'bee',
  'magenta',
  'iris',
  'cobalt',
  'citrus',
  'mono',
] as const;

export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = 'citrus';
export const ACCENT_KEY = 'buzz-accent.v1';
export const LEGACY_BUBBLE_KEY = 'buzz-bubble-color.v1';

export function parseAccent(value: unknown): Accent {
  if (
    value === 'chartreuse' ||
    value === 'lime' ||
    value === 'pear' ||
    value === 'jade'
  )
    return 'citrus';
  if (value === 'flame') return 'bee';
  if (value === 'gray') return 'mono';
  return ACCENTS.includes(value as Accent) ? (value as Accent) : DEFAULT_ACCENT;
}

const LEGACY_BUBBLE_ACCENTS: Readonly<Record<string, Accent>> = {
  blue: 'cobalt',
  cyan: 'cobalt',
  indigo: 'cobalt',
  green: 'citrus',
  orange: 'bee',
  pink: 'magenta',
  red: 'magenta',
  lilac: 'iris',
  purple: 'iris',
};

export function parseLegacyBubbleColor(value: unknown): Accent {
  return (
    (typeof value === 'string' ? LEGACY_BUBBLE_ACCENTS[value] : undefined) ??
    DEFAULT_ACCENT
  );
}

export type Contrast = 'low' | 'high';
export const CONTRAST_KEY = 'buzz-contrast.v1';
export const parseContrast = (value: unknown): Contrast =>
  value === 'high' ? 'high' : 'low';

export const accentButtonStyle = {
  '--affordance-prominent': 'var(--affordance-accent-prominent)',
  '--affordance-prominent-hover': 'var(--affordance-accent-prominent-hover)',
  '--affordance-prominent-pressed': 'var(--affordance-accent-prominent-pressed)',
  '--text-on-prominent': 'var(--text-on-accent)',
} as CSSProperties;
