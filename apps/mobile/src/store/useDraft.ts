import * as SecureStore from 'expo-secure-store';
import { useCallback, useMemo, useReducer } from 'react';

export function useDraft(...scope: (string | null)[]) {
  const key =
    'bubai.draft.' +
    Array.from(JSON.stringify(scope), (c) => c.codePointAt(0)!.toString(16)).join('.');
  const state = useMemo(() => ({ value: SecureStore.getItem(key) ?? '' }), [key]);
  const [, render] = useReducer((n) => n + 1, 0);
  const update = useCallback(
    (next: string | ((previous: string) => string)) => {
      const value = typeof next === 'function' ? next(state.value) : next;
      if (value === state.value) return;
      SecureStore.setItem(key, value);
      state.value = value;
      render();
    },
    [state, key],
  );
  return [state.value, update, key] as const;
}
