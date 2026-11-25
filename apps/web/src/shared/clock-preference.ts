import { useSyncExternalStore } from 'react';

export type HourCycle = 'h12' | 'h23';
export type ClockPreference = {
  hourCycle: 'system' | HourCycle;
  seconds: boolean;
  messageTimestamps: 'show' | 'hide-solo' | 'hide';
  localTimeDetails: boolean;
};

const preferenceKey = 'buzz-clock.v1';
const listeners = new Set<() => void>();
let current: ClockPreference | undefined;
let unsaved = false;

function read(): ClockPreference {
  let saved: Record<string, unknown> = {};
  try {
    saved = Object(JSON.parse(localStorage.getItem(preferenceKey) ?? '{}'));
  } catch {
    // ignore invalid JSON
  }
  const { hourCycle, seconds, messageTimestamps, localTimeDetails } = saved;
  return {
    hourCycle: hourCycle === 'h12' || hourCycle === 'h23' ? hourCycle : 'system',
    seconds: seconds === true,
    messageTimestamps:
      messageTimestamps === 'hide-solo' || messageTimestamps === 'hide'
        ? messageTimestamps
        : 'show',
    localTimeDetails: localTimeDetails !== false,
  };
}

export function clockPreference(): ClockPreference {
  current ??= read();
  return current;
}

export function clockHourCycle(): HourCycle | undefined {
  const { hourCycle } = clockPreference();
  return hourCycle === 'system' ? undefined : hourCycle;
}

function notify() {
  for (const listener of listeners) listener();
}

function storage(event: StorageEvent) {
  if (event.key !== preferenceKey && event.key !== null) return;
  current = undefined;
  unsaved = false;
  notify();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    if (!unsaved) current = undefined;
    window.addEventListener('storage', storage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('storage', storage);
    }
  };
}

function key() {
  const { hourCycle, seconds, messageTimestamps, localTimeDetails } = clockPreference();
  return `${hourCycle} ${seconds} ${messageTimestamps} ${localTimeDetails}`;
}
const pending = () => unsaved;

export function useClockFormat(): void {
  useSyncExternalStore(subscribe, key, key);
}

export function useClockPreference() {
  useClockFormat();
  return {
    ...clockPreference(),
    unsaved: useSyncExternalStore(subscribe, pending, pending),
  };
}

export function setClockPreference(change: Partial<ClockPreference>): void {
  current = { ...clockPreference(), ...change };
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(current));
    unsaved = false;
  } catch {
    unsaved = true;
  }
  notify();
}
