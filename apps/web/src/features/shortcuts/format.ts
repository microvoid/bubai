/** Ported from references/buzz-app/src/features/shortcuts/format.ts */
export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  mod?: boolean;
}

export const isApplePlatform = (platform: string) =>
  /Mac|iPhone|iPad/.test(platform);

export type FormattedBinding = Readonly<{
  parts: readonly string[];
  text: string;
  label: string;
}>;

type Words = readonly [display: string, spoken: string];
const SPECIAL_KEYS: Readonly<Record<string, Words>> = {
  ' ': ['Space', 'Space'],
  enter: ['Enter', 'Enter'],
  escape: ['Escape', 'Escape'],
  tab: ['Tab', 'Tab'],
  backspace: ['Backspace', 'Backspace'],
  delete: ['Delete', 'Delete'],
  home: ['Home', 'Home'],
  end: ['End', 'End'],
  pageup: ['PageUp', 'Page Up'],
  pagedown: ['PageDown', 'Page Down'],
  arrowup: ['↑', 'Up Arrow'],
  arrowdown: ['↓', 'Down Arrow'],
  arrowleft: ['←', 'Left Arrow'],
  arrowright: ['→', 'Right Arrow'],
};

type Modifiers = readonly (readonly ['ctrl' | 'alt' | 'shift' | 'mod', Words])[];
const APPLE_MODIFIERS: Modifiers = [
  ['ctrl', ['⌃', 'Control']],
  ['alt', ['⌥', 'Option']],
  ['shift', ['⇧', 'Shift']],
  ['mod', ['⌘', 'Command']],
];
const OTHER_MODIFIERS: Modifiers = [
  ['mod', ['Ctrl', 'Control']],
  ['alt', ['Alt', 'Alt']],
  ['shift', ['Shift', 'Shift']],
];

export function formatBinding(binding: KeyBinding, apple: boolean): FormattedBinding {
  const normalized = binding.key.toLowerCase();
  const special = Object.hasOwn(SPECIAL_KEYS, normalized)
    ? SPECIAL_KEYS[normalized]
    : undefined;
  const key: Words = special ?? [
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
  ];
  const modifiers = (apple ? APPLE_MODIFIERS : OTHER_MODIFIERS)
    .filter(([flag]) => binding[flag])
    .map(([, words]) => words);
  const parts = [...modifiers, key];
  return Object.freeze({
    parts: Object.freeze(parts.map(([display]) => display)),
    text: parts.map(([display]) => display).join(apple ? '' : '+'),
    label: parts.map(([, spoken]) => spoken).join(' '),
  });
}
