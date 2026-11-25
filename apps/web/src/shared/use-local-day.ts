import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let current = localDay();
let timer: ReturnType<typeof setTimeout> | undefined;

function localDay() {
  const now = new Date();
  const { timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${timeZone}`;
}

function check() {
  const next = localDay();
  if (next !== current) {
    current = next;
    for (const listener of listeners) listener();
  }
}

function arm() {
  clearTimeout(timer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  timer = setTimeout(() => {
    check();
    arm();
  }, midnight.getTime() - now.getTime());
}

function wake() {
  check();
  arm();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    current = localDay();
    arm();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    }
  };
}

function snapshot() {
  return current;
}

export function useLocalDay() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
