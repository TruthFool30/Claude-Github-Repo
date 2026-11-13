import { Link } from 'react-router';
import { ChevronRight, Sparkles } from 'lucide-react';
import { moduleMeta } from '../../layout/moduleMeta';
import { useAuth } from '../../lib/auth';
import { firstName, fmtDateTime, fmtRelative } from '../../lib/format';
import type { Activity } from '../../lib/types';
import { Avatar, Card } from '../../ui';

/** Activity verbs written by background jobs, without a person (budget's automatic goal contributions and the goal they complete). */
const SYSTEM_VERBS = new Set(['auto_saved', 'goal_reached']);

/** A run of consecutive activity entries from other modules, shown as one compact card. */
export function ActivityCard({ items }: { items: Activity[] }) {
  const { user } = useAuth();
  const modules = [...new Set(items.map((a) => a.module))];
  const heading =
    modules.length === 1 ? `${moduleMeta(modules[0]).label} update${items.length === 1 ? '' : 's'}` : 'Family updates';
  return (
    <Card padding="none" className="overflow-hidden">
      <section aria-label={heading}>
        <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-subtle sm:px-5">
          <Sparkles size={13} /> {heading}
        </div>
        <ul className="pb-1.5">
          {items.map((a) => {
            const meta = moduleMeta(a.module);
            const Icon = meta.icon;
            // Rows Hearth writes itself (automatic savings) read as a sentence with the module icon; a member
            // who has since been removed reads "A former member …".
            const system = !a.user && SYSTEM_VERBS.has(a.verb);
            const actor = a.user ? (a.user.id === user?.id ? 'You' : firstName(a.user.name)) : 'A former member';
            const content = (
              <>
                <span className="relative mr-1.5 shrink-0">
                  {a.user ? <Avatar user={a.user} size="md" /> : system ? (
                    <span className="flex size-9 items-center justify-center rounded-full" style={{ backgroundColor: `color-mix(in oklab, ${meta.accent} 16%, var(--surface))`, color: meta.accent }} aria-hidden>
                      <Icon size={16} strokeWidth={2.25} />
                    </span>
                  ) : <span className="block size-9 rounded-full bg-surface-3" />}
                  {!system && <span
                    className="absolute -bottom-1.5 -right-2.5 flex size-[22px] items-center justify-center rounded-full ring-[2.5px] ring-surface"
                    style={{ backgroundColor: `color-mix(in oklab, ${meta.accent} 22%, var(--surface))`, color: meta.accent }}
                    aria-hidden
                  >
                    <Icon size={11} strokeWidth={2.5} />
                  </span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] leading-snug text-fg">
                    {system ? a.summary.charAt(0).toUpperCase() + a.summary.slice(1) : <><span className="font-semibold">{actor}</span> <span className="text-muted">{a.summary}</span></>}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-subtle">
                    <span className="font-medium" style={{ color: `color-mix(in oklab, ${meta.accent} 70%, var(--fg))` }}>{meta.label}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={a.created_at} title={fmtDateTime(a.created_at)}>{fmtRelative(a.created_at)}</time>
                  </span>
                </span>
              </>
            );
            return (
              <li key={a.id}>
                {a.link ? (
                  <Link to={a.link} className="group flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none sm:px-5">
                    {content}
                    <ChevronRight size={16} className="shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-2 sm:px-5">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </Card>
  );
}
