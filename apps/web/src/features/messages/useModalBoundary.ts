/** Ported from references/buzz-app/src/features/messages/useModalBoundary.ts */
import { useEffect, useRef, type RefObject } from 'react';
import { behindActiveOverlay } from '../../design-system/overlayLayer';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

const available = (target: HTMLElement | undefined) =>
  !!target?.isConnected &&
  !target.closest('[hidden], [inert], [aria-hidden="true"]');

export function useModalBoundary(
  backdrop: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null>,
  close: () => void,
  restoreFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(close);
  const openerRef = useRef<HTMLElement | undefined>(undefined);
  closeRef.current = close;

  useEffect(() => {
    const container = backdrop.current;
    if (!container) return;
    const active = document.activeElement;
    if (!container.contains(active)) {
      openerRef.current = active instanceof HTMLElement ? active : undefined;
    }
    const opener = openerRef.current;
    const siblings = [...document.body.children].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== container,
    );
    const previous = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    for (const element of siblings) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    initialFocus.current?.focus({ preventScroll: true });

    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      if (
        event.defaultPrevented ||
        behindActiveOverlay(initialFocus.current ?? container)
      )
        return;
      const popup =
        event.target instanceof Element
          ? event.target.closest('[role="alertdialog"], [role="dialog"]')
          : null;
      if (popup && !container.contains(popup)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      const focusable = [
        ...container.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter(
        (element) =>
          !element.hidden &&
          !element.closest('[inert]') &&
          element.getClientRects().length > 0,
      );
      if (!focusable.length) {
        event.preventDefault();
        initialFocus.current?.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const currentActive = document.activeElement;
      const outsideTabStops =
        !container.contains(currentActive) ||
        (currentActive === initialFocus.current &&
          !focusable.some((element) => element === currentActive));
      if (
        outsideTabStops ||
        (event.shiftKey && currentActive === first) ||
        (!event.shiftKey && currentActive === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };

    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null)
          state.element.removeAttribute('aria-hidden');
        else state.element.setAttribute('aria-hidden', state.ariaHidden);
      }
      const target = restoreFocus?.current ?? opener;
      if (
        available(target) &&
        (document.activeElement === document.body ||
          container.contains(document.activeElement))
      ) {
        requestAnimationFrame(() => {
          if (available(target)) target?.focus({ preventScroll: true });
        });
      }
    };
  }, [backdrop, initialFocus, restoreFocus]);
}
