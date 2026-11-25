/**
 * Ported from references/buzz-app/src/features/messages/ComposerSheet.tsx
 * (omitting onboarding IntroSpotlight only).
 */
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { spring } from 'motion';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { XIcon } from '../../design-system/icons/index';
import { DialogBarMaterial } from '../../design-system/ui/DialogBarMaterial';
import { IconButton } from '../../design-system/ui/IconButton';
import { useFinalFocusUnlessMoved } from '../../design-system/ui/finalFocus';
import type { ComposerOverlayHost } from './composer-overlay';
import styles from './ComposerSheet.module.css';
import messageStyles from './Messages.module.css';

function dockGeometry(dock: HTMLElement): CSSProperties {
  const box = dock.getBoundingClientRect();
  const outer = dock.parentElement?.closest<HTMLElement>(
    '[data-details-sheet-surface]',
  );
  const pane =
    dock.closest<HTMLElement>('[data-overlay-boundary]') ??
    dock.parentElement?.parentElement ??
    dock.parentElement ??
    dock;
  const viewTop = outer
    ? outer.getBoundingClientRect().top + outer.clientTop
    : pane.getBoundingClientRect().top;
  return {
    '--composer-height': `${box.height}px`,
    '--dock-bottom': `${box.bottom}px`,
    '--view-top': `${viewTop}px`,
  } as CSSProperties;
}

function scrimGeometry(dock: HTMLElement): CSSProperties {
  const pane =
    dock.closest<HTMLElement>('[data-overlay-boundary]') ??
    dock.parentElement ??
    dock;
  const surface =
    pane.closest<HTMLElement>('[data-buzz-surface][data-joined]') ??
    pane.closest<HTMLElement>('[data-buzz-surface]') ??
    pane;
  const box = surface.getBoundingClientRect();
  const style = getComputedStyle(surface);
  const clip = (
    pane.closest<HTMLElement>('[data-overlay-boundary]') ?? pane
  ).getBoundingClientRect();
  const inset = (distance: number, border: string) =>
    distance <= Number.parseFloat(border) ? 0 : distance;
  return {
    '--scrim-top': `${box.top}px`,
    '--scrim-left': `${box.left}px`,
    '--scrim-width': `${box.width}px`,
    '--scrim-height': `${box.height}px`,
    '--scrim-radius': style.borderRadius,
    '--scrim-inset': [
      inset(clip.top - box.top, style.borderTopWidth),
      inset(box.right - clip.right, style.borderRightWidth),
      inset(box.bottom - clip.bottom, style.borderBottomWidth),
      inset(clip.left - box.left, style.borderLeftWidth),
    ]
      .map((value) => `${value}px`)
      .join(' '),
  } as CSSProperties;
}

function useDockGeometry(dock: HTMLElement, mounted: boolean) {
  const measure = () => ({
    sheet: dockGeometry(dock),
    scrim: dock.parentElement?.closest('[data-details-sheet-surface]')
      ? {}
      : scrimGeometry(dock),
  });
  const [style, setStyle] = useState(measure);
  useLayoutEffect(() => {
    if (!mounted) return;
    const update = () => setStyle(measure());
    update();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(dock);
    if (dock.parentElement) observer?.observe(dock.parentElement);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [dock, mounted]);
  return style;
}

const immediate = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
  document.documentElement.hasAttribute('data-keyboard-navigation');

function token(element: Element, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}
const milliseconds = (value: string) =>
  value.endsWith('ms')
    ? Number.parseFloat(value)
    : Number.parseFloat(value) * 1000;

function useGrowth() {
  const last = useRef<{ open: boolean; animation?: Animation }>(undefined);
  return useCallback((element: HTMLElement, open: boolean, mounting = false) => {
    if (mounting) last.current = undefined;
    const previous = last.current;
    if (previous?.open === open) return;
    const painted = getComputedStyle(element);
    const shownClip = painted.clipPath;
    previous?.animation?.cancel();
    last.current = { open };
    if (typeof element.animate !== 'function' || immediate()) return;
    const radius = painted.borderRadius;
    const composerHeight = Number.parseFloat(
      token(element, '--composer-height', '0px'),
    );
    const gap = token(element, '--sheet-gap', '8px');
    const composerRadius = token(element, '--composer-radius', radius);
    const folded = `inset(max(0px, calc(100% - ${composerHeight}px - ${gap})) ${gap} ${gap} round ${composerRadius})`;
    const expanded = `inset(0px 0px 0px round ${radius})`;
    const duration = milliseconds(
      token(
        element,
        open ? '--duration-settle' : '--duration-fast',
        open ? '220ms' : '150ms',
      ),
    );
    const from = previous
      ? shownClip === 'none'
        ? expanded
        : shownClip
      : folded;
    const curve = spring({ duration, bounce: 0.25, keyframes: [0, 1] });
    const springEasing = curve
      .toString()
      .slice(curve.toString().indexOf(' ') + 1);
    last.current.animation = element.animate(
      [{ clipPath: from }, { clipPath: open ? expanded : folded }],
      {
        duration,
        easing:
          open && CSS.supports('animation-timing-function', springEasing)
            ? springEasing
            : token(
                element,
                '--easing-enter',
                'cubic-bezier(0.23, 1, 0.32, 1)',
              ),
        fill: open ? 'none' : 'forwards',
      },
    );
  }, []);
}

export function useComposerHandoff(
  sheet: HTMLElement | null,
  source: HTMLElement,
  open: boolean,
  enabled: boolean,
) {
  const interrupted = useRef<{
    target: HTMLElement;
    opacity: string;
    sourceOpacity: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!sheet || !enabled) return;
    let animations: Animation[] = [];
    let started = false;
    let editor: HTMLElement | null = null;
    const start = () => {
      const target = sheet.querySelector<HTMLElement>(
        '[data-message-composer]',
      );
      if (!target || started) return;
      started = true;
      editor = target;
      if (immediate() || typeof target.animate !== 'function') {
        if (open) source.dataset.composerCovered = '';
        return;
      }
      const options: KeyframeAnimationOptions = {
        duration: milliseconds(
          token(sheet, open ? '--duration-settle' : '--duration-fast', '220ms'),
        ),
        easing: token(
          sheet,
          '--easing-enter',
          'cubic-bezier(0.23, 1, 0.32, 1)',
        ),
        fill: 'both',
      };
      const prior =
        interrupted.current?.target === target ? interrupted.current : null;
      interrupted.current = null;
      const incoming = target.animate(
        [
          { opacity: prior?.opacity ?? (open ? 0 : 1) },
          { opacity: open ? 1 : 0 },
        ],
        options,
      );
      const outgoing = source.animate(
        [
          { opacity: prior?.sourceOpacity ?? (open ? 1 : 0) },
          { opacity: open ? 0 : 1 },
        ],
        options,
      );
      animations = [incoming, outgoing];
      incoming.onfinish = () => {
        if (!open) return;
        source.dataset.composerCovered = '';
        for (const animation of animations) animation.cancel();
      };
    };
    start();
    const observer = new MutationObserver(start);
    if (!started) observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      interrupted.current =
        editor && animations.some((item) => item.playState === 'running')
          ? {
              target: editor,
              opacity: getComputedStyle(editor).opacity,
              sourceOpacity: getComputedStyle(source).opacity,
            }
          : null;
      for (const animation of animations) animation.cancel();
      delete source.dataset.composerCovered;
    };
  }, [sheet, source, open, enabled]);
}

export function SheetHeader({
  title,
  description,
  leading,
  closeLabel,
  headerActions,
  material,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  closeLabel: string;
  headerActions?: ReactNode;
  material: boolean;
}) {
  return (
    <header className={`buzz-dialog-header ${styles.header}`}>
      {material && <DialogBarMaterial className={styles.headerMaterial} />}
      <div className={styles.byline}>
        {leading}
        <BaseDialog.Title className={`text-label ${styles.name}`}>
          {title}
        </BaseDialog.Title>
        {description && (
          <BaseDialog.Description
            className={`buzz-dialog-description ${styles.time}`}
          >
            {description}
          </BaseDialog.Description>
        )}
      </div>
      <div className="buzz-dialog-header-actions">
        {headerActions}
        <BaseDialog.Close
          render={
            <IconButton
              aria-label={closeLabel}
              variant="glass"
              shape="round"
              size="compact"
              icon={<XIcon size={16} aria-hidden="true" />}
            />
          }
        />
      </div>
    </header>
  );
}

export function SheetRoot({
  open,
  onOpenChange,
  onClosed,
  finalFocus,
  popup,
  backdrop,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onClosed(): void;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  popup: RefObject<HTMLElement | null>;
  backdrop: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (
          !next &&
          (details.reason === 'focus-out' ||
            (details.reason === 'outside-press' &&
              details.event?.target !== backdrop.current))
        ) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        onClosed();
        const active = document.activeElement;
        if (active === document.body || popup.current?.contains(active))
          finalFocus?.current?.focus({ preventScroll: true });
      }}
    >
      {children}
    </BaseDialog.Root>
  );
}

export function ComposerSheet({
  open,
  onOpenChange,
  host,
  title,
  description,
  leading,
  closeLabel = 'Close',
  finalFocus,
  children,
  containsComposer = false,
  readerOnly = false,
  tall = false,
  onClosed,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  host: ComposerOverlayHost;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  closeLabel?: string;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
  containsComposer?: boolean;
  readerOnly?: boolean;
  tall?: boolean;
  onClosed?: (() => void) | undefined;
}) {
  const { composer, dock } = host;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const style = useDockGeometry(dock, mounted);
  useCoveredComposer(composer, mounted, containsComposer, readerOnly);
  useComposerHandoff(surface, composer, open, containsComposer);
  const popup = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const grown = useRef<HTMLDivElement | null>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const grow = useGrowth();
  const setPopup = useCallback((element: HTMLDivElement | null) => {
    if (element && element !== grown.current) {
      grown.current = element;
      setSurface(element);
      grow(element, true, true);
    }
    popup.current = element;
    focus.ref(element);
  }, [focus.ref, grow]);

  useLayoutEffect(() => {
    if (popup.current) grow(popup.current, open);
  });

  return (
    <SheetRoot
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => {
        setMounted(false);
        onClosed?.();
      }}
      finalFocus={finalFocus}
      popup={popup}
      backdrop={backdrop}
    >
      <BaseDialog.Portal
        container={dock}
        className={messageStyles.detailsSheetLayer}
        data-details-sheet=""
      >
        <BaseDialog.Backdrop
          ref={backdrop}
          forceRender
          className={styles.scrim}
          data-panel={readerOnly || undefined}
          style={style.scrim}
        />
        <BaseDialog.Popup
          ref={setPopup}
          className={styles.sheet}
          data-details-sheet-surface=""
          data-contained-composer={containsComposer || undefined}
          data-reader-only={readerOnly || undefined}
          data-tall={tall || undefined}
          data-height="content"
          style={style.sheet}
          initialFocus={containsComposer ? false : popup}
          finalFocus={focus.finalFocus}
        >
          <div className={styles.content}>
            <SheetHeader
              title={title}
              description={description}
              leading={leading}
              closeLabel={closeLabel}
              material={containsComposer || readerOnly}
            />
            <div className={`buzz-dialog-body ${styles.body}`}>
              <div className={styles.reader}>{children}</div>
            </div>
          </div>
          {!containsComposer && !readerOnly && (
            <div className={styles.composerSpace} aria-hidden="true" />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </SheetRoot>
  );
}

export function useCoveredComposer(
  composer: HTMLElement,
  mounted: boolean,
  containsComposer: boolean,
  readerOnly: boolean,
) {
  useLayoutEffect(() => {
    if (!mounted || (!containsComposer && !readerOnly)) return;
    if (readerOnly) composer.dataset.composerCovered = '';
    const inert = composer.inert;
    composer.inert = true;
    return () => {
      composer.inert = inert;
      if (readerOnly) delete composer.dataset.composerCovered;
    };
  }, [composer, mounted, containsComposer, readerOnly]);
}
