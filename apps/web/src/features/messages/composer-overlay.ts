/**
 * Ported directly from references/buzz-app/src/features/messages/composer-overlay.ts
 */
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

export type ComposerHandle = Readonly<{
  dock(): HTMLElement | null;
  attach(dock: HTMLElement): () => void;
  subscribe(listener: () => void): () => void;
}>;

export function createComposerHandle(): ComposerHandle {
  let current: HTMLElement | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    dock: () => current,
    attach: (dock) => {
      current = dock;
      changed();
      return () => {
        if (current !== dock) return;
        current = null;
        changed();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ComposerView = Readonly<{
  handle: ComposerHandle;
  rootId?: string | undefined;
  shown: boolean;
  local?: boolean | undefined;
}>;

const ComposerScope = createContext<ComposerView | undefined>(undefined);
export const useComposerScope = () => useContext(ComposerScope);

export function ComposerScopeProvider({
  rootId,
  shown = true,
  local,
  children,
}: {
  rootId?: string | undefined;
  shown?: boolean | undefined;
  local?: boolean | undefined;
  children: ReactNode;
}) {
  const [handle] = useState(createComposerHandle);
  const value = useMemo(
    () => ({ handle, rootId, shown, local }),
    [handle, rootId, shown, local],
  );
  return createElement(ComposerScope.Provider, { value }, children);
}

export type ComposerOverlayHost = Readonly<{
  dock: HTMLElement;
  composer: HTMLElement;
}>;

export function composerHost(
  handle: ComposerHandle | undefined,
): ComposerOverlayHost | null {
  const dock = handle?.dock();
  if (!dock?.isConnected || !dock.getClientRects().length) return null;
  const composer = dock.querySelector<HTMLElement>(
    ':scope > [data-message-composer]',
  );
  return composer ? { dock, composer } : null;
}

const noSubscription = () => () => {};

export function useComposerDock(handle: ComposerHandle | undefined) {
  return useSyncExternalStore(
    handle?.subscribe ?? noSubscription,
    () => handle?.dock() ?? null,
    () => handle?.dock() ?? null,
  );
}

export function useComposerDockRef() {
  const handle = useComposerScope()?.handle;
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      return handle?.attach(element);
    },
    [handle],
  );
}
