import { useRef, useState, type ReactNode } from 'react';
import { Popover } from '../../ui';
import { cn } from '../../lib/cn';
import { EMOJI_SET } from './parts';

/** Grid of emoji inside a popover anchored to a trigger. */
export function EmojiPicker({
  onPick, trigger, align = 'end', label = 'Choose an emoji', keepOpen,
}: {
  onPick: (emoji: string) => void;
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog' }) => ReactNode;
  align?: 'start' | 'end';
  label?: string;
  keepOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={anchor} className="inline-flex">
        {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'dialog' })}
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} align={align} role="dialog" aria-label={label} className="w-[296px] p-2">
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI_SET.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={e}
              onClick={() => {
                onPick(e);
                if (!keepOpen) setOpen(false);
              }}
              className={cn('flex size-9 items-center justify-center rounded-lg text-[21px] transition hover:scale-110 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
            >
              {e}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
