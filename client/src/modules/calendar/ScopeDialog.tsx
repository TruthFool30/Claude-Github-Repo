import { useEffect, useState } from 'react';
import { CalendarClock, CalendarDays, CalendarRange, Check, Repeat } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button, Modal } from '../../ui';
import type { Scope } from './types';

export interface ScopeRequest {
  kind: 'edit' | 'delete';
  allowThis: boolean;
  title: string;
  resolve: (s: Scope | null) => void;
}

/** "This event / This and following / All events" chooser for recurring events. */
export function ScopeDialog({ req, onDone }: { req: ScopeRequest | null; onDone: () => void }) {
  const [scope, setScope] = useState<Scope>('this');
  useEffect(() => {
    if (req) setScope(req.allowThis ? 'this' : 'following');
  }, [req]);
  const finish = (s: Scope | null) => {
    req?.resolve(s);
    onDone();
  };
  const del = req?.kind === 'delete';
  const options: Array<{ value: Scope; label: string; hint: string; icon: typeof CalendarDays }> = [
    ...(req?.allowThis ? [{ value: 'this' as Scope, label: 'This event', hint: 'Only this day', icon: CalendarDays }] : []),
    { value: 'following', label: 'This and following events', hint: 'From this day on', icon: CalendarRange },
    {
      value: 'all',
      label: 'All events',
      hint: del ? 'Every occurrence in the series' : 'Every occurrence — days changed individually keep their changes when possible',
      icon: CalendarClock,
    },
  ];
  return (
    <Modal
      open={!!req}
      onClose={() => finish(null)}
      size="sm"
      title={del ? 'Delete recurring event' : 'Save recurring event'}
      description={req?.title}
      icon={
        <span className="flex size-10 items-center justify-center rounded-2xl bg-primary-soft text-primary-soft-fg">
          <Repeat size={19} />
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant={del ? 'danger' : 'primary'} onClick={() => finish(scope)} data-testid="scope-confirm">
            {del ? 'Delete' : 'Save'}
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label={del ? 'Which events to delete' : 'Which events to change'} className="space-y-2">
        {options.map((o) => {
          const on = scope === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setScope(o.value)}
              onDoubleClick={() => finish(o.value)}
              className={cn(
                'flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
                on ? 'border-primary bg-primary-soft/60' : 'border-border hover:border-border-strong hover:bg-surface-2',
              )}
            >
              <o.icon size={19} className={on ? 'text-primary' : 'text-muted'} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-fg">{o.label}</span>
                <span className="block text-[13px] text-muted">{o.hint}</span>
              </span>
              <span className={cn('flex size-5 items-center justify-center rounded-full border-2', on ? 'border-primary bg-primary-solid text-white' : 'border-border-strong')}>
                {on && <Check size={12} strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
