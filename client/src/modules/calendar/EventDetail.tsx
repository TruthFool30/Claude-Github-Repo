import { Bell, Cake, Clock, Copy, Download, ExternalLink, MapPin, Pencil, Repeat, StickyNote, Trash2, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth';
import { readableOn } from '../../lib/color';
import { firstName } from '../../lib/format';
import { Avatar, Badge, Button, Menu, Modal } from '../../ui';
import { describeRrule, downloadIcs, fmtWhen, mapsUrl, occStart, reminderLabel } from './lib';
import type { Occurrence } from './types';

interface Props {
  occ: Occurrence | null;
  onClose: () => void;
  onEdit: (o: Occurrence) => void;
  onDuplicate: (o: Occurrence) => void;
  onDelete: (o: Occurrence) => void;
}

function Row({ icon: Icon, children, label }: { icon: typeof Clock; children: ReactNode; label: string }) {
  return (
    <div className="flex gap-3.5 py-2.5">
      <Icon size={18} className="mt-0.5 shrink-0 text-muted" aria-label={label} />
      <div className="min-w-0 flex-1 text-[15px] text-fg">{children}</div>
    </div>
  );
}

export function EventDetail({ occ, onClose, onEdit, onDuplicate, onDelete }: Props) {
  const { members, familyId } = useAuth();
  const o = occ;
  const when = o ? fmtWhen(o) : null;
  const people = o ? (o.attendees.map((id) => members.find((m) => m.id === id)).filter(Boolean) as typeof members) : [];
  const { bg, fg } = readableOn(o?.color);
  const isEvent = o?.kind === 'event';

  return (
    <Modal
      open={!!o}
      onClose={onClose}
      size="md"
      title={o?.title}
      icon={
        o && (
          <span className="flex size-10 items-center justify-center rounded-2xl" style={{ backgroundColor: bg, color: fg }} aria-hidden>
            {o.kind === 'birthday' ? <Cake size={20} /> : <span className="text-[15px] font-bold">{occStart(o).getDate()}</span>}
          </span>
        )
      }
      footer={
        o && isEvent ? (
          o.can_edit ? (
            <>
              <Menu
                label="More event actions"
                align="start"
                className="flex-none! sm:mr-auto"
                items={[
                  { label: 'Duplicate', icon: Copy, onSelect: () => onDuplicate(o) },
                  { label: 'Export to calendar (.ics)', icon: Download, onSelect: () => o.event_id && downloadIcs(o.event_id, o.title, familyId) },
                ]}
              />
              <Button variant="secondary" icon={Trash2} onClick={() => onDelete(o)} className="text-danger">
                Delete
              </Button>
              <Button icon={Pencil} onClick={() => onEdit(o)}>
                Edit
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" icon={Copy} onClick={() => onDuplicate(o)}>
                Duplicate
              </Button>
              <Button variant="secondary" icon={Download} onClick={() => o.event_id && downloadIcs(o.event_id, o.title, familyId)}>
                Export
              </Button>
            </>
          )
        ) : undefined
      }
    >
      {o && when && (
        <div className="divide-y divide-border">
          <div className="flex flex-wrap items-center gap-2 pb-3">
            {o.recurring && isEvent && (
              <Badge tone="primary">
                <Repeat size={11} /> Repeats
              </Badge>
            )}
            {o.exception && <Badge tone="warning">Changed for this day</Badge>}
            {o.kind === 'birthday' && <Badge color={o.color}>Birthday</Badge>}
            {!o.can_edit && isEvent && <Badge tone="neutral">View only</Badge>}
          </div>
          <Row icon={Clock} label="When">
            <div className="font-semibold">{when.primary}</div>
            {when.secondary && <div className="text-sm text-muted">{when.secondary}</div>}
          </Row>
          {o.kind === 'birthday' && (
            <Row icon={Cake} label="Birthday">
              {o.age ? (
                <>
                  Turns <strong>{o.age}</strong> — don't forget the cake! 🎂
                </>
              ) : (
                'Happy birthday!'
              )}
            </Row>
          )}
          {o.recurring && isEvent && (
            <Row icon={Repeat} label="Repeats">
              {describeRrule(o.rrule, occStart(o))}
            </Row>
          )}
          {o.location && (
            <Row icon={MapPin} label="Location">
              <a
                href={mapsUrl(o.location)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
              >
                {o.location}
                <ExternalLink size={13} aria-hidden />
                <span className="sr-only">(opens map in a new tab)</span>
              </a>
            </Row>
          )}
          {people.length > 0 && isEvent && (
            <Row icon={Users} label="Who">
              <ul className="flex flex-wrap gap-2">
                {people.map((m) => (
                  <li key={m.id} className="inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm font-medium" style={{ backgroundColor: `color-mix(in oklab, ${m.color} 14%, var(--surface))` }}>
                    <Avatar user={m} size="sm" />
                    {m.nickname || firstName(m.name)}
                  </li>
                ))}
              </ul>
            </Row>
          )}
          {o.reminders.length > 0 && isEvent && (
            <Row icon={Bell} label="Reminders">
              {o.reminders.map((m) => reminderLabel(m, o.all_day)).join(' · ')}
            </Row>
          )}
          {o.notes && (
            <Row icon={StickyNote} label="Notes">
              <p className="whitespace-pre-wrap break-words leading-relaxed">{o.notes}</p>
            </Row>
          )}
          {isEvent && o.creator_name && (
            <p className="pt-3 text-[13px] text-muted">Added by {firstName(o.creator_name)}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
