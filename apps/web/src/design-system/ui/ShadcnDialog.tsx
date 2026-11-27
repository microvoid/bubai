/**
 * shadcn/ui (new-york) Dialog built on @radix-ui/react-dialog.
 * Adapted from references/buzz/desktop/src/shared/ui/dialog.tsx with
 * Base UI nested-overlay interoperability (emoji picker, menus, mentions).
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as React from 'react';
import { XIcon } from '../icons/index';
import styles from './ShadcnDialog.module.css';

const NESTED_OVERLAY_SELECTOR =
  '.buzz-popover-popup, .buzz-menu-popup, .buzz-select-popup, [data-buzz-ui]';
const ACTIVE_NESTED_POPOVER_SELECTOR =
  '.buzz-popover-popup, .buzz-menu-popup, .buzz-select-popup, [data-mention]';

function isInsideNestedOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(NESTED_OVERLAY_SELECTOR));
}

function joinClasses(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(' ');
}

const DialogContext = React.createContext<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}>({ open: false });

export function Dialog({
  open = false,
  onOpenChange,
  modal = false,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  return (
    <DialogContext.Provider value={{ open, onOpenChange }}>
      <DialogPrimitive.Root
        open={open}
        onOpenChange={onOpenChange}
        modal={modal}
        {...props}
      >
        {children}
      </DialogPrimitive.Root>
    </DialogContext.Provider>
  );
}

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, onClick, ...props }, ref) => {
  const { open, onOpenChange } = React.useContext(DialogContext);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="dialog-overlay"
      data-state={open ? 'open' : 'closed'}
      className={joinClasses(styles.overlay, className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onOpenChange?.(false);
        }
      }}
      {...props}
    />
  );
});
DialogOverlay.displayName = 'DialogOverlay';

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  overlayClassName?: string;
  showCloseButton?: boolean;
  closeLabel?: string;
}

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(
  (
    {
      className,
      overlayClassName,
      children,
      showCloseButton = false,
      closeLabel = 'Close',
      onPointerDownOutside,
      onInteractOutside,
      onEscapeKeyDown,
      ...props
    },
    ref,
  ) => (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <div className={styles.positioner}>
        <DialogPrimitive.Content
          ref={ref}
          className={joinClasses(styles.content, className)}
          onPointerDownOutside={(event) => {
            if (isInsideNestedOverlay(event.target)) {
              event.preventDefault();
              return;
            }
            onPointerDownOutside?.(event);
          }}
          onInteractOutside={(event) => {
            if (isInsideNestedOverlay(event.target)) {
              event.preventDefault();
              return;
            }
            onInteractOutside?.(event);
          }}
          onEscapeKeyDown={(event) => {
            if (document.querySelector(ACTIVE_NESTED_POPOVER_SELECTOR)) {
              event.preventDefault();
              return;
            }
            onEscapeKeyDown?.(event);
          }}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close
              className={styles.closeButton}
              aria-label={closeLabel}
              style={{ position: 'absolute', top: '0.75rem', right: '0.75rem' }}
            >
              <XIcon size={16} aria-hidden="true" />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  ),
);
DialogContent.displayName = 'DialogContent';

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <header className={joinClasses(styles.header, className)} {...props} />;
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={joinClasses(styles.footer, className)} {...props} />;
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={joinClasses(styles.title, className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={joinClasses(styles.description, className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

export { styles as shadcnDialogStyles };
