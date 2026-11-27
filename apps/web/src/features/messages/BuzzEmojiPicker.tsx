/**
 * Composer & reaction emoji picker backed by Buzz's real emoji-mart + @emoji-mart/data
 * inside Buzz's PopoverRoot / PopoverTrigger / PopoverPopup.
 * Thinly adapted from references/buzz-app/src/bundled/emoji/EmojiPicker.tsx & emoji-mart.ts.
 */
import data from '@emoji-mart/data';
import { Picker } from 'emoji-mart';
import { useEffect, useRef, useState } from 'react';
import { SmileyIcon, SmileyPlusIcon } from '../../design-system/icons/index';
import { IconButton } from '../../design-system/ui/IconButton';
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from '../../design-system/ui/Popover';
import styles from './EmojiPicker.module.css';

export function BuzzEmojiPicker({
  disabled = false,
  reaction = false,
  onSelect,
}: {
  disabled?: boolean;
  reaction?: boolean;
  onSelect: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!open || !host) return;
    const mode =
      document.documentElement.dataset.colorMode === 'dark' ? 'dark' : 'light';

    const picker = new Picker({
      data,
      theme: mode,
      previewPosition: 'none',
      skinTonePosition: 'search',
      perLine: 8,
      maxFrequentRows: 2,
      onEmojiSelect: (emoji: { native?: string }) => {
        if (emoji.native) {
          onSelectRef.current(emoji.native);
          setOpen(false);
        }
      },
    }) as unknown as HTMLElement;

    host.replaceChildren(picker);
    return () => {
      host.replaceChildren();
    };
  }, [open, host]);

  return (
    <fieldset className={styles.emojiPicker} data-open={open || undefined} aria-label="Emoji picker">
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <IconButton
              hint="familiar"
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={reaction ? 'Add reaction' : 'Insert emoji'}
              title={reaction ? 'Add reaction' : 'Emoji'}
              onMouseDown={(event) => {
                if (!reaction) event.preventDefault();
              }}
              icon={
                reaction ? (
                  <SmileyPlusIcon size={16} aria-hidden="true" />
                ) : (
                  <SmileyIcon size={16} aria-hidden="true" />
                )
              }
            />
          }
        />
        <PopoverPopup
          side="top"
          align="start"
          padding="none"
          aria-label="Emoji picker"
        >
          <div className={styles.emojiContent}>
            <div className={styles.emojiMart}>
              <div ref={setHost} />
            </div>
          </div>
        </PopoverPopup>
      </PopoverRoot>
    </fieldset>
  );
}
