/**
 * shadcn/ui Base UI Drawer built on @base-ui/react/drawer.
 * Mirrors https://ui.shadcn.com/docs/components/base/drawer including
 * Non-Modal (modal={false}) and Snap Points (snapPoints / snapPoint /
 * onSnapPointChange / data-expanded) with Base UI nested-overlay interop.
 */
import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import * as React from 'react';
import styles from './ShadcnDrawer.module.css';

export type DrawerSnapPoint = DrawerPrimitive.Root.SnapPoint;

const NESTED_OVERLAY_SELECTOR =
  '.buzz-popover-popup, .buzz-menu-popup, .buzz-select-popup, [data-mention], [data-buzz-ui]';
const ACTIVE_NESTED_POPOVER_SELECTOR =
  '.buzz-popover-popup, .buzz-menu-popup, .buzz-select-popup, [data-mention]';

function isInsideNestedOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(NESTED_OVERLAY_SELECTOR));
}

function joinClasses(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(' ');
}

function mergeClassName<State>(
  base: string,
  extra?: string | ((state: State) => string | undefined),
): string | ((state: State) => string) {
  if (typeof extra === 'function') {
    return (state: State) => joinClasses(base, extra(state));
  }
  return joinClasses(base, extra);
}

const DrawerContext = React.createContext<{
  modal: boolean | 'trap-focus';
}>({ modal: true });

export interface DrawerProps extends DrawerPrimitive.Root.Props {}

export function Drawer({
  modal = true,
  onOpenChange,
  children,
  ...props
}: DrawerProps) {
  return (
    <DrawerContext.Provider value={{ modal }}>
      <DrawerPrimitive.Root
        modal={modal}
        onOpenChange={(nextOpen, eventDetails) => {
          if (!nextOpen) {
            if (
              eventDetails.reason === 'escape-key' &&
              document.querySelector(ACTIVE_NESTED_POPOVER_SELECTOR)
            ) {
              eventDetails.cancel();
              return;
            }
            if (
              (eventDetails.reason === 'outside-press' ||
                eventDetails.reason === 'focus-out') &&
              isInsideNestedOverlay(eventDetails.event?.target ?? null)
            ) {
              eventDetails.cancel();
              return;
            }
          }
          onOpenChange?.(nextOpen, eventDetails);
        }}
        {...props}
      >
        {children}
      </DrawerPrimitive.Root>
    </DrawerContext.Provider>
  );
}

export const DrawerTrigger = DrawerPrimitive.Trigger;
export const DrawerPortal = DrawerPrimitive.Portal;
export const DrawerClose = DrawerPrimitive.Close;

export const DrawerBackdrop = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Backdrop
    ref={ref}
    className={mergeClassName(styles.backdrop, className)}
    {...props}
  />
));
DrawerBackdrop.displayName = 'DrawerBackdrop';

export interface DrawerContentProps
  extends React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Popup> {
  viewportClassName?: string;
  viewportStyle?: React.CSSProperties;
  backdropClassName?: string;
  showHandle?: boolean;
  onHandleDoubleClick?: () => void;
}

export const DrawerContent = React.forwardRef<HTMLDivElement, DrawerContentProps>(
  (
    {
      className,
      viewportClassName,
      viewportStyle,
      backdropClassName,
      showHandle = true,
      onHandleDoubleClick,
      children,
      ...props
    },
    ref,
  ) => {
    const { modal } = React.useContext(DrawerContext);
    return (
      <DrawerPrimitive.Portal>
        {modal !== false ? <DrawerBackdrop className={backdropClassName} /> : null}
        <DrawerPrimitive.Viewport
          data-non-modal={modal === false ? '' : undefined}
          className={joinClasses(styles.viewport, viewportClassName)}
          style={viewportStyle}
        >
          <DrawerPrimitive.Popup
            ref={ref}
            data-slot="drawer-content"
            className={mergeClassName(styles.popup, className)}
            {...props}
          >
            {showHandle ? (
              <div
                className={styles.handleRow}
                data-drawer-handle=""
                onDoubleClick={onHandleDoubleClick}
                title="Drag to resize or double-click to expand"
              >
                <span className={styles.handleBar} aria-hidden="true" />
              </div>
            ) : null}
            <DrawerPrimitive.Content className={styles.innerContent}>
              {children}
            </DrawerPrimitive.Content>
          </DrawerPrimitive.Popup>
        </DrawerPrimitive.Viewport>
      </DrawerPrimitive.Portal>
    );
  },
);
DrawerContent.displayName = 'DrawerContent';

export function DrawerHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <header className={joinClasses(styles.header, className)} {...props} />;
}

export function DrawerFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={joinClasses(styles.footer, className)} {...props} />;
}

export const DrawerTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Title
    ref={ref}
    className={mergeClassName(styles.title, className)}
    {...props}
  />
));
DrawerTitle.displayName = 'DrawerTitle';

export const DrawerDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Description
    ref={ref}
    className={mergeClassName(styles.description, className)}
    {...props}
  />
));
DrawerDescription.displayName = 'DrawerDescription';

export { styles as shadcnDrawerStyles };
