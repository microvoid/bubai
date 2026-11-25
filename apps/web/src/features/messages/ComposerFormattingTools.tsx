/**
 * Ported from references/buzz-app/src/features/messages/ComposerFormattingTools.tsx
 * and composer-dom.ts.
 */
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from 'motion/react';
import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  CodeBlockIcon,
  CodeIcon,
  DetectiveIcon,
  LinkIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  QuotesIcon,
  TextAaIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  XIcon,
} from '../../design-system/icons/index';
import { IconButton } from '../../design-system/ui/IconButton';
import { formatBinding, isApplePlatform } from '../shortcuts/format';
import styles from './ComposerFormattingTools.module.css';

export const inlineFormats = [
  {
    mark: 'bold',
    label: 'Bold',
    binding: { key: 'b', mod: true as const, shift: false },
  },
  {
    mark: 'italic',
    label: 'Italic',
    binding: { key: 'i', mod: true as const, shift: false },
  },
  {
    mark: 'strike',
    label: 'Strikethrough',
    binding: { key: 'x', mod: true as const, shift: true },
  },
  {
    mark: 'spoiler',
    label: 'Spoiler',
    binding: { key: 'p', mod: true as const, shift: true },
  },
  {
    mark: 'code',
    label: 'Code',
    binding: { key: 'e', mod: true as const, shift: false },
  },
] as const;

export const blockFormats = [
  {
    mark: 'code_block',
    label: 'Code block',
    binding: { key: 'c', mod: true as const, alt: true as const, shift: false },
  },
  {
    mark: 'bullet_list',
    label: 'Bullet list',
    binding: { key: '8', mod: true as const, shift: true },
  },
  {
    mark: 'ordered_list',
    label: 'Ordered list',
    binding: { key: '7', mod: true as const, shift: true },
  },
  {
    mark: 'blockquote',
    label: 'Quote',
    binding: { key: 'b', mod: true as const, shift: true },
  },
] as const;

export type InlineFormat = (typeof inlineFormats)[number]['mark'];
export type BlockFormat = (typeof blockFormats)[number]['mark'];
export type ComposerFormat = InlineFormat | BlockFormat;
export const composerFormats = [...inlineFormats, ...blockFormats];
export const linkBinding = { key: 'k', mod: true as const, shift: false };

const reveal = { duration: 0.14, ease: [0.23, 1, 0.32, 1] } as const;
const options = [
  ['Bold', TextBIcon],
  ['Italic', TextItalicIcon],
  ['Strikethrough', TextStrikethroughIcon],
  ['Code', CodeIcon],
  ['Code block', CodeBlockIcon],
  ['Link', LinkIcon],
  ['Bullet list', ListBulletsIcon],
  ['Ordered list', ListNumbersIcon],
  ['Quote', QuotesIcon],
  ['Spoiler', DetectiveIcon],
] as const;

const ToolGroup = forwardRef<HTMLDivElement, ComponentProps<typeof motion.div>>(
  function ToolGroup(props, ref) {
    const present = useIsPresent();
    return (
      <motion.div
        {...props}
        ref={ref}
        inert={!present}
        aria-hidden={!present || undefined}
      />
    );
  },
);

export function ComposerFormattingTools({
  children,
  disabled,
  singleRow,
  activeFormats,
  toggleFormat,
  editLink,
  trailing,
  persistent = false,
}: {
  children: ReactNode;
  persistent?: boolean;
  trailing?: ReactNode;
  disabled: boolean;
  singleRow?: boolean;
  activeFormats: readonly ComposerFormat[];
  toggleFormat(format: ComposerFormat): void;
  editLink(): void;
}) {
  const [toggled, setOpen] = useState(false);
  const open = persistent || toggled;
  const reduceMotion = useReducedMotion();
  const [keyboardToggle, setKeyboardToggle] = useState(false);
  const instant = reduceMotion || keyboardToggle;
  const openToggle = useRef<HTMLButtonElement>(null);
  const closedToggle = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useLayoutEffect(() => {
    if (restoreFocus.current) {
      (open ? openToggle : closedToggle).current?.focus();
      restoreFocus.current = false;
    }
  }, [open]);

  const change = (next: boolean, keyboard: boolean) => {
    restoreFocus.current = keyboard;
    setKeyboardToggle(keyboard);
    setOpen(next);
  };

  const transition = instant ? { duration: 0 } : reveal;
  const faded = { opacity: 0, scale: instant ? 1 : 0.95 };

  const formatToggle = (
    <IconButton
      hint="familiar"
      ref={closedToggle}
      size="sm"
      variant="ghost"
      aria-label="Toggle formatting"
      aria-pressed={open}
      title="Formatting"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => change(!open, event.detail === 0)}
      icon={<TextAaIcon size={16} />}
    />
  );

  return (
    <div
      className={styles.tools}
      data-formatting-open={open || undefined}
      data-single-row={singleRow || undefined}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {open ? (
          <ToolGroup
            key="formatting"
            className={styles.expanded}
            initial={false}
            animate={{}}
            exit={{ opacity: 0 }}
            transition={transition}
          >
            {!persistent && (
              <motion.div
                className={styles.close}
                initial={instant ? false : faded}
                animate={{ opacity: 1, scale: 1 }}
                exit={faded}
                transition={transition}
              >
                <IconButton
                  hint="familiar"
                  ref={openToggle}
                  size="sm"
                  variant="subtle"
                  aria-label="Close formatting"
                  title="Close formatting"
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => change(false, event.detail === 0)}
                  icon={<XIcon size={16} />}
                />
                <div className={styles.divider} aria-hidden="true" />
              </motion.div>
            )}
            <motion.div
              className={styles.scroll}
              initial={instant ? false : faded}
              animate={{ opacity: 1, scale: 1 }}
              exit={faded}
              transition={transition}
            >
              <fieldset className={styles.options} aria-label="Formatting options">
                {options.map(([label, Icon]) => {
                  const format = composerFormats.find((item) => item.label === label);
                  const isLink = label === 'Link';
                  const binding = format?.binding ?? (isLink ? linkBinding : undefined);
                  const active = format ? activeFormats.includes(format.mark) : false;
                  const apple = isApplePlatform(navigator.platform);
                  return (
                    <IconButton
                      hint="familiar"
                      key={label}
                      size="sm"
                      aria-label={label}
                      title={
                        binding
                          ? `${label} (${formatBinding(binding, apple).text})`
                          : label
                      }
                      aria-pressed={active}
                      variant={active ? 'subtle' : 'ghost'}
                      onClick={
                        format
                          ? () => toggleFormat(format.mark)
                          : isLink
                            ? editLink
                            : undefined
                      }
                      disabled={disabled}
                      onMouseDown={(event) => event.preventDefault()}
                      icon={<Icon size={16} />}
                    />
                  );
                })}
              </fieldset>
            </motion.div>
          </ToolGroup>
        ) : (
          <ToolGroup
            key="ingress"
            className={styles.ingress}
            initial={instant ? false : { opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: instant ? 0 : -12 }}
            transition={transition}
          >
            {children}
            <motion.div
              className={styles.fixed}
              initial={instant ? false : { x: -8, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: instant ? 0 : -8, opacity: 0 }}
              transition={transition}
            >
              {formatToggle}
            </motion.div>
            {trailing}
          </ToolGroup>
        )}
      </AnimatePresence>
    </div>
  );
}
