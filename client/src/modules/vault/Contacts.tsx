import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, BookUser, ChevronLeft, ChevronRight, Contact as ContactIcon, Copy, Download, ExternalLink, Globe, Mail, MapPin, MessageSquare, Pencil, Phone,
  Plus, Siren, Star, Trash2, X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useMember } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtRelative, plural } from '../../lib/format';
import { useIsDesktop } from '../../lib/hooks';
import {
  Avatar, Badge, Button, Card, EmptyState, Fab, Field, IconButton, Input, Menu, Modal, Select, Skeleton, SkeletonList, Switch,
  Textarea, toast, useConfirm,
} from '../../ui';
import { keys, useContacts, type Contact, type ContactCategory, type Phone as PhoneT } from './api';
import { ACCENT, CATEGORIES, CATEGORY_ORDER, Tile, copyText, mapHref, smsHref, telHref, tint } from './meta';
import { Chip, SearchField } from './parts';

type Filter = 'all' | 'favorites' | 'sos' | ContactCategory;

const matches = (c: Contact, q: string) => {
  if (!q) return true;
  const hay = [c.name, c.role, c.organization, c.email, c.notes, ...c.phones.map((p) => p.number)].filter(Boolean).join(' ').toLowerCase();
  const digits = q.replace(/\D/g, '');
  return hay.includes(q) || (digits.length >= 3 && c.phones.some((p) => p.number.replace(/\D/g, '').includes(digits)));
};

export default function ContactsSection() {
  const params = useParams();
  const selectedId = Number(params['*']) || null;
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const { data, isLoading, isError, refetch } = useContacts();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);

  const contacts = useMemo(() => data ?? [], [data]);
  const emergency = contacts.filter((c) => c.emergency);
  const q = query.trim().toLowerCase();
  const visible = contacts.filter((c) => matches(c, q) && (filter === 'all' || (filter === 'favorites' ? c.favorite : filter === 'sos' ? c.emergency : c.category === filter)));
  const selected = selectedId ? contacts.find((c) => c.id === selectedId) ?? null : null;

  // Desktop: open the first contact so the detail pane is never empty.
  useEffect(() => {
    if (isDesktop && !selectedId && visible.length && !q && filter === 'all') navigate(`/vault/contacts/${(visible.find((c) => c.favorite) ?? visible[0]).id}`, { replace: true });
  }, [isDesktop, selectedId, visible, q, filter, navigate]);

  const counts = useMemo(() => {
    const m = new Map<Filter, number>();
    for (const c of contacts) m.set(c.category, (m.get(c.category) ?? 0) + 1);
    m.set('favorites', contacts.filter((c) => c.favorite).length);
    m.set('sos', contacts.filter((c) => c.emergency).length);
    return m;
  }, [contacts]);

  if (isLoading) return <ContactsSkeleton />;
  if (isError) {
    return (
      <Card>
        <EmptyState icon={BookUser} accent={ACCENT} title="Couldn't load contacts" description="Check your connection and try again." action={<Button onClick={() => refetch()}>Try again</Button>} />
      </Card>
    );
  }

  const showDetailOnly = !isDesktop && !!selectedId;

  if (!contacts.length) {
    return (
      <>
        <Card>
          <EmptyState
            icon={BookUser}
            accent={ACCENT}
            title="Your family address book"
            description="Keep the doctor, school, babysitter and plumber one tap away — for everyone in the family."
            action={<Button icon={Plus} onClick={() => setEditing('new')}>Add the first contact</Button>}
          />
        </Card>
        <ContactFormModal open={!!editing} contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      </>
    );
  }

  return (
    <div>
      {!showDetailOnly && emergency.length > 0 && <EmergencyStrip contacts={emergency} />}

      <div className="lg:grid lg:grid-cols-[minmax(0,370px)_minmax(0,1fr)] lg:items-start lg:gap-6">
        {!showDetailOnly && (
          <Card padding="none" className="overflow-hidden lg:sticky lg:top-4">
            <div className="flex flex-col gap-3 border-b border-border p-3 sm:p-4">
              <div className="flex items-center gap-2">
                <SearchField value={query} onChange={setQuery} placeholder="Search contacts" label="Search contacts" className="min-w-0 flex-1" />
                <Button icon={Plus} onClick={() => setEditing('new')} className="max-lg:hidden!" aria-label="Add contact">Add</Button>
              </div>
              <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5 scrollbar-none sm:-mx-4 sm:px-4" role="group" aria-label="Filter by category">
                <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={contacts.length}>All</Chip>
                {(counts.get('favorites') ?? 0) > 0 && (
                  <Chip active={filter === 'favorites'} onClick={() => setFilter(filter === 'favorites' ? 'all' : 'favorites')} icon={Star} color="#FFB224" count={counts.get('favorites')}>Favorites</Chip>
                )}
                {(counts.get('sos') ?? 0) > 0 && (
                  <Chip active={filter === 'sos'} onClick={() => setFilter(filter === 'sos' ? 'all' : 'sos')} icon={Siren} color="#E5484D" count={counts.get('sos')}>Emergency</Chip>
                )}
                {CATEGORY_ORDER.filter((c) => counts.get(c)).map((c) => (
                  <Chip key={c} active={filter === c} onClick={() => setFilter(filter === c ? 'all' : c)} icon={CATEGORIES[c].icon} color={CATEGORIES[c].color} count={counts.get(c)}>
                    {CATEGORIES[c].label}
                  </Chip>
                ))}
              </div>
            </div>
            <ContactList contacts={visible} selectedId={selectedId} grouped={!q && filter === 'all'} onClear={() => { setQuery(''); setFilter('all'); }} />
          </Card>
        )}

        {(isDesktop || showDetailOnly) && (
          <div className="min-w-0">
            {selected ? (
              <ContactDetail key={selected.id} contact={selected} onEdit={() => setEditing(selected)} showBack={!isDesktop} />
            ) : selectedId ? (
              <Card>
                <EmptyState compact icon={BookUser} accent={ACCENT} title="Contact not found" description="It may have been deleted." action={<Link to="/vault/contacts" className="font-semibold text-primary">Back to contacts</Link>} />
              </Card>
            ) : (
              <Card className="hidden lg:block">
                <EmptyState compact icon={ContactIcon} accent={ACCENT} title="No contact selected" description="Pick someone from the list to see their details." />
              </Card>
            )}
          </div>
        )}
      </div>

      {!showDetailOnly && <Fab label="Add contact" accent={ACCENT} onClick={() => setEditing('new')} />}
      <ContactFormModal
        open={!!editing}
        contact={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(c, created) => created && navigate(`/vault/contacts/${c.id}`)}
      />
    </div>
  );
}

function ContactsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading contacts">
      <Skeleton className="mb-6 h-36 w-full rounded-2xl" />
      <div className="lg:grid lg:grid-cols-[370px_1fr] lg:gap-6">
        <Card><SkeletonList rows={7} /></Card>
        <Card className="hidden lg:block"><SkeletonList rows={4} /></Card>
      </div>
    </div>
  );
}

function EmergencyStrip({ contacts }: { contacts: Contact[] }) {
  const scroller = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false, page: 0, pages: 1 });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const pages = Math.max(1, Math.ceil(el.scrollWidth / Math.max(1, el.clientWidth)));
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft < max - 4, page: max > 0 ? Math.round((el.scrollLeft / max) * (pages - 1)) : 0, pages });
  }, []);
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, contacts.length]);
  const scrollBy = (dir: number) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <section
      aria-labelledby="vault-emergency"
      className="mb-5 overflow-hidden rounded-2xl border p-3 shadow-card sm:p-4 lg:flex lg:items-center lg:gap-4 lg:py-3"
      style={{
        borderColor: 'color-mix(in oklab, var(--danger) 25%, var(--border))',
        background: 'linear-gradient(135deg, color-mix(in oklab, var(--danger) 10%, var(--surface)) 0%, var(--surface) 70%)',
      }}
    >
      <div className="mb-2.5 flex items-center gap-2.5 lg:mb-0 lg:w-36 lg:shrink-0 lg:flex-col lg:items-start lg:gap-1.5">
        <span className="inline-flex size-8 items-center justify-center rounded-xl bg-danger-solid text-white shadow-xs">
          <Siren size={17} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="vault-emergency" className="text-[15px] font-bold tracking-tight text-fg">Emergency</h2>
          <p className="text-xs text-muted">One tap to call</p>
        </div>
      </div>
      <div className="relative min-w-0 flex-1">
        <ul
          ref={scroller}
          onScroll={measure}
          className="-mx-3 flex snap-x snap-mandatory scroll-px-3 gap-2.5 overflow-x-auto scroll-smooth px-3 sm:scroll-px-4 lg:scroll-px-0 pb-0.5 scrollbar-none sm:-mx-4 sm:px-4 lg:mx-0 lg:px-0"
        >
          {contacts.map((c) => {
            const phone = c.phones[0];
            const cat = CATEGORIES[c.category];
            return (
              <li key={c.id} className="flex w-[16.5rem] shrink-0 snap-start items-center gap-2.5 rounded-2xl border border-border bg-surface p-2.5 shadow-xs">
                <Link to={`/vault/contacts/${c.id}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
                  <Tile color={cat.color} icon={c.category === 'emergency' ? cat.icon : undefined} text={c.category === 'emergency' ? undefined : c.name} size={38} rounded="rounded-xl" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-fg">{c.name}</span>
                    <span className="block truncate text-xs text-muted">{phone?.number ?? c.role ?? 'No number'}</span>
                  </span>
                </Link>
                {phone && (
                  <a
                    href={telHref(phone.number)}
                    aria-label={`Call ${c.name}`}
                    title={`Call ${phone.number}`}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-danger-solid text-white shadow-xs transition hover:bg-danger-solid-hover active:scale-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
                  >
                    <Phone size={17} aria-hidden />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        {/* Edge fades hint that the row scrolls. */}
        <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 -left-3 w-10 bg-gradient-to-r from-[color-mix(in_oklab,var(--danger)_6%,var(--surface))] to-transparent transition-opacity sm:-left-4 lg:left-0', edges.left ? 'opacity-100' : 'opacity-0')} />
        <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 -right-3 w-12 bg-gradient-to-l from-surface to-transparent transition-opacity sm:-right-4 lg:right-0', edges.right ? 'opacity-100' : 'opacity-0')} />
        {edges.left && (
          <span className="absolute left-1 top-1/2 -translate-y-1/2 max-lg:hidden">
            <IconButton icon={ChevronLeft} label="Scroll emergency contacts left" size="sm" variant="secondary" onClick={() => scrollBy(-1)} className="rounded-full! shadow-card" />
          </span>
        )}
        {edges.right && (
          <span className="absolute right-1 top-1/2 -translate-y-1/2 max-lg:hidden">
            <IconButton icon={ChevronRight} label="Scroll emergency contacts right" size="sm" variant="secondary" onClick={() => scrollBy(1)} className="rounded-full! shadow-card" />
          </span>
        )}
        {edges.pages > 1 && (
          <div className="mt-2 flex justify-center gap-1.5 lg:hidden" aria-hidden>
            {Array.from({ length: edges.pages }, (_, i) => (
              <span key={i} className={cn('h-1.5 rounded-full transition-all', i === edges.page ? 'w-4 bg-danger' : 'w-1.5 bg-border-strong')} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ContactList({ contacts, selectedId, grouped, onClear }: { contacts: Contact[]; selectedId: number | null; grouped: boolean; onClear: () => void }) {
  if (!contacts.length) {
    return <EmptyState compact icon={BookUser} accent={ACCENT} title="No matches" description="Try another name, number or category." action={<Button size="sm" variant="secondary" onClick={onClear}>Clear filters</Button>} />;
  }
  const groups: Array<{ key: string; label: string; items: Contact[] }> = [];
  if (grouped) {
    const favs = contacts.filter((c) => c.favorite);
    if (favs.length) groups.push({ key: 'fav', label: 'Favorites', items: favs });
    for (const c of contacts) {
      const letter = /[a-z]/i.test(c.name[0] ?? '') ? c.name[0].toUpperCase() : '#';
      const g = groups.find((x) => x.key === letter) ?? groups[groups.push({ key: letter, label: letter, items: [] }) - 1];
      g.items.push(c);
    }
  } else groups.push({ key: 'all', label: '', items: contacts });

  return (
    <div className="lg:max-h-[calc(100dvh-var(--shell-chrome)-190px)] lg:overflow-y-auto lg:scrollbar-thin">
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={g.label || 'Contacts'}>
          {g.label && (
            <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-border bg-surface-2/90 px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-subtle backdrop-blur">
              {g.key === 'fav' && <Star size={11} className="fill-current text-[#FFB224]" aria-hidden />}
              {g.label}
            </div>
          )}
          <ul className="divide-y divide-border">
            {g.items.map((c) => <ContactRow key={`${g.key}-${c.id}`} c={c} active={c.id === selectedId} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ContactRow({ c, active }: { c: Contact; active: boolean }) {
  const cat = CATEGORIES[c.category];
  const phone = c.phones[0];
  const sub = [c.role, c.role && c.organization && c.role.includes(c.organization) ? null : c.organization].filter(Boolean).join(' · ') || cat.label;
  return (
    <li className={cn('group relative flex items-center gap-3 px-3 py-2.5 transition-colors sm:px-4', active ? 'bg-primary-soft/60' : 'hover:bg-surface-2/70')}>
      {active && <span className="absolute inset-y-2 left-0 w-1 rounded-r-full" style={{ backgroundColor: ACCENT }} aria-hidden />}
      <Link
        to={`/vault/contacts/${c.id}`}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-0.5 after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-4 focus-visible:after:ring-inset focus-visible:after:ring-ring"
      >
        <Tile color={cat.color} icon={c.category === 'emergency' ? cat.icon : undefined} text={c.category === 'emergency' ? undefined : c.name} size={42} rounded="rounded-[14px]" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-fg">{c.name}</span>
            {c.favorite && <Star size={13} className="shrink-0 fill-[#FFB224] text-[#FFB224]" aria-label="Favorite" />}
            {c.emergency && <Siren size={13} className="shrink-0 text-danger" aria-label="Emergency contact" />}
          </span>
          <span className="block truncate text-[13px] text-muted">{sub}</span>
        </span>
      </Link>
      {phone && (
        <a
          href={telHref(phone.number)}
          aria-label={`Call ${c.name} (${phone.number})`}
          title={`Call ${phone.number}`}
          className="relative z-[1] inline-flex size-9 shrink-0 items-center justify-center rounded-full text-success-soft-fg transition hover:bg-success-soft active:scale-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
        >
          <Phone size={17} aria-hidden />
        </a>
      )}
    </li>
  );
}

function vcard(c: Contact) {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name)}`];
  if (c.organization) lines.push(`ORG:${esc(c.organization)}`);
  if (c.role) lines.push(`TITLE:${esc(c.role)}`);
  for (const p of c.phones) lines.push(`TEL;TYPE=${esc(p.label.toUpperCase())}:${p.number}`);
  if (c.email) lines.push(`EMAIL:${c.email}`);
  if (c.address) lines.push(`ADR:;;${esc(c.address)};;;;`);
  if (c.website) lines.push(`URL:${c.website}`);
  if (c.notes) lines.push(`NOTE:${esc(c.notes)}`);
  lines.push('END:VCARD');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/vcard' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${c.name.replace(/[^\w\- ]+/g, '').trim() || 'contact'}.vcf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function ContactDetail({ contact: c, onEdit, showBack }: { contact: Contact; onEdit: () => void; showBack: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const author = useMember(c.created_by);
  const cat = CATEGORIES[c.category];
  const phone = c.phones[0];

  const toggleFavorite = async () => {
    const next = !c.favorite;
    qc.setQueryData<Contact[]>(keys.contacts, (old) => old?.map((x) => (x.id === c.id ? { ...x, favorite: next } : x)));
    try {
      await api.patch(`/vault/contacts/${c.id}`, { favorite: next });
    } catch (e) {
      qc.setQueryData<Contact[]>(keys.contacts, (old) => old?.map((x) => (x.id === c.id ? { ...x, favorite: !next } : x)));
      toast.error(errorMessage(e));
    }
  };

  const remove = async () => {
    const ok = await confirm({ title: `Delete ${c.name}?`, message: 'They will be removed from the family address book for everyone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    const prev = qc.getQueryData<Contact[]>(keys.contacts);
    qc.setQueryData<Contact[]>(keys.contacts, (old) => old?.filter((x) => x.id !== c.id));
    navigate('/vault/contacts', { replace: true });
    try {
      await api.del(`/vault/contacts/${c.id}`);
      toast.success(`${c.name} deleted`);
      qc.invalidateQueries({ queryKey: keys.all });
    } catch (e) {
      qc.setQueryData(keys.contacts, prev);
      toast.error(errorMessage(e));
    }
  };

  const copy = async (text: string, what: string) => ((await copyText(text)) ? toast.success(`${what} copied`) : toast.error('Could not copy'));

  const actions = [
    { label: 'Call', icon: Phone, href: phone ? telHref(phone.number) : null },
    { label: 'Message', icon: MessageSquare, href: phone ? smsHref(phone.number) : null },
    { label: 'Email', icon: Mail, href: c.email ? `mailto:${c.email}` : null },
    { label: 'Directions', icon: MapPin, href: c.address ? mapHref(c.address) : null, external: true },
  ];

  return (
    <Card padding="none" className="overflow-hidden animate-fade-in" aria-labelledby="vault-contact-name">
      <div className="relative px-4 pb-5 pt-4 sm:px-6 sm:pt-5" style={{ background: `linear-gradient(180deg, color-mix(in oklab, ${cat.color} 12%, var(--surface)) 0%, var(--surface) 100%)` }}>
        <div className="flex items-center justify-between gap-2">
          {showBack ? (
            <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate('/vault/contacts')} className="-ml-2">Contacts</Button>
          ) : <span />}
          <div className="flex items-center gap-1">
            <IconButton
              icon={<Star size={19} className={cn(c.favorite && 'fill-[#FFB224] text-[#FFB224]')} aria-hidden />}
              label={c.favorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-pressed={c.favorite}
              onClick={toggleFavorite}
            />
            {c.can_edit && <IconButton icon={Pencil} label="Edit contact" onClick={onEdit} />}
            <Menu
              label="More contact actions"
              items={[
                { label: 'Save to phone (.vcf)', icon: Download, onSelect: () => vcard(c) },
                phone && { label: 'Copy number', icon: Copy, onSelect: () => copy(phone.number, 'Number') },
                c.can_edit && 'divider',
                c.can_edit && { label: 'Delete contact', icon: Trash2, danger: true, onSelect: remove },
              ]}
            />
          </div>
        </div>
        <div className="mt-2 flex flex-col items-center text-center sm:flex-row sm:items-center sm:gap-5 sm:text-left">
          <Tile color={cat.color} icon={c.category === 'emergency' ? cat.icon : undefined} text={c.category === 'emergency' ? undefined : c.name} size={84} rounded="rounded-[26px]" className="shadow-lift" />
          <div className="mt-3 min-w-0 sm:mt-0">
            <h2 id="vault-contact-name" className="text-2xl font-bold tracking-tight text-fg">{c.name}</h2>
            {(c.role || c.organization) && (
              <p className="mt-0.5 text-[15px] text-muted">{[c.role, c.organization && !(c.role ?? '').includes(c.organization) ? c.organization : null].filter(Boolean).join(' · ')}</p>
            )}
            <div className="mt-2 flex flex-wrap justify-center gap-1.5 sm:justify-start">
              <Badge color={cat.color}><cat.icon size={11} aria-hidden /> {cat.label}</Badge>
              {c.emergency && <Badge tone="danger"><Siren size={11} aria-hidden /> Emergency contact</Badge>}
            </div>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-4 gap-2 sm:max-w-md">
          {actions.map((a) =>
            a.href ? (
              <a
                key={a.label}
                href={a.href}
                target={a.external ? '_blank' : undefined}
                rel={a.external ? 'noreferrer' : undefined}
                className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface px-1 py-2.5 text-xs font-semibold text-fg shadow-xs transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-card active:translate-y-0 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
              >
                <span className="inline-flex size-9 items-center justify-center rounded-full" style={tint(a.label === 'Call' ? '#30A46C' : ACCENT, 16)}>
                  <a.icon size={18} aria-hidden />
                </span>
                {a.label}
              </a>
            ) : (
              <span key={a.label} aria-disabled="true" className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-border px-1 py-2.5 text-xs font-semibold text-subtle opacity-60">
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-surface-2"><a.icon size={18} aria-hidden /></span>
                {a.label}
              </span>
            ),
          )}
        </div>
      </div>

      <dl className="divide-y divide-border border-t border-border">
        {c.phones.map((p, i) => (
          <InfoRow key={i} icon={Phone} label={p.label}>
            <a href={telHref(p.number)} className="font-semibold text-fg hover:text-primary">{p.number}</a>
            <span className="ml-auto flex gap-0.5">
              <IconButton size="sm" icon={MessageSquare} label={`Text ${p.number}`} onClick={() => { window.location.href = smsHref(p.number); }} />
              <IconButton size="sm" icon={Copy} label={`Copy ${p.number}`} onClick={() => copy(p.number, 'Number')} />
            </span>
          </InfoRow>
        ))}
        {c.email && (
          <InfoRow icon={Mail} label="Email">
            <a href={`mailto:${c.email}`} className="min-w-0 truncate font-semibold text-fg hover:text-primary">{c.email}</a>
            <IconButton size="sm" className="ml-auto" icon={Copy} label="Copy email" onClick={() => copy(c.email!, 'Email')} />
          </InfoRow>
        )}
        {c.address && (
          <InfoRow icon={MapPin} label="Address">
            <span className="min-w-0 whitespace-pre-line font-medium text-fg">{c.address}</span>
            <a href={mapHref(c.address)} target="_blank" rel="noreferrer" aria-label="Open address in maps" className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
              <ExternalLink size={16} aria-hidden />
            </a>
          </InfoRow>
        )}
        {c.website && (
          <InfoRow icon={Globe} label="Website">
            <a href={c.website} target="_blank" rel="noreferrer" className="min-w-0 truncate font-semibold text-primary hover:underline">{c.website.replace(/^https?:\/\//, '')}</a>
          </InfoRow>
        )}
        {c.notes && (
          <div className="px-4 py-4 sm:px-6">
            <dt className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-subtle">Notes</dt>
            <dd className="whitespace-pre-line rounded-xl bg-surface-2/70 p-3 text-[14px] leading-relaxed text-fg">{c.notes}</dd>
          </div>
        )}
        {!c.phones.length && !c.email && !c.address && !c.website && !c.notes && (
          <div className="px-6 py-8 text-center text-sm text-muted">
            No details yet.{c.can_edit && <> <button type="button" onClick={onEdit} className="font-semibold text-primary">Add a number or email</button></>}
          </div>
        )}
      </dl>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-xs text-subtle sm:px-6">
        {author && <Avatar user={author} size="xs" />}
        <span>
          Added by {author ? firstName(author.name) : 'a former member'} · {fmtRelative(c.created_at)}
          {c.updated_at !== c.created_at && <> · edited {fmtRelative(c.updated_at)}</>}
        </span>
      </div>
    </Card>
  );
}

function InfoRow({ icon: Icon, label, children }: { icon: typeof Phone; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted"><Icon size={17} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <dt className="text-xs font-medium text-subtle">{label}</dt>
        <dd className="flex min-w-0 items-center gap-2 text-[15px]">{children}</dd>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const PHONE_LABELS = ['Mobile', 'Home', 'Work', 'Office', 'After hours', 'Emergency', 'Fax', 'Other'];

interface FormState {
  name: string; category: ContactCategory; role: string; organization: string; phones: PhoneT[]; email: string;
  address: string; website: string; notes: string; favorite: boolean; emergency: boolean;
}
const empty = (): FormState => ({
  name: '', category: 'other', role: '', organization: '', phones: [{ label: 'Mobile', number: '' }], email: '', address: '', website: '', notes: '', favorite: false, emergency: false,
});

export function ContactFormModal({ open, contact, onClose, onSaved }: {
  open: boolean; contact: Contact | null; onClose: () => void; onSaved?: (c: Contact, created: boolean) => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(empty);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<'name' | 'email' | 'form', string>>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setF(contact
      ? {
        name: contact.name, category: contact.category, role: contact.role ?? '', organization: contact.organization ?? '',
        phones: contact.phones.length ? contact.phones : [{ label: 'Mobile', number: '' }], email: contact.email ?? '', address: contact.address ?? '',
        website: contact.website ?? '', notes: contact.notes ?? '', favorite: contact.favorite, emergency: contact.emergency,
      }
      : empty());
  }, [open, contact]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const setPhone = (i: number, patch: Partial<PhoneT>) => set('phones', f.phones.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!f.name.trim()) errs.name = 'Give this contact a name';
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) errs.email = 'That email address looks incomplete';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const body = { ...f, phones: f.phones.filter((p) => p.number.trim()) };
      const saved = contact ? await api.patch<Contact>(`/vault/contacts/${contact.id}`, body) : await api.post<Contact>('/vault/contacts', body);
      qc.setQueryData<Contact[]>(keys.contacts, (old) => {
        if (!old) return old;
        const next = contact ? old.map((x) => (x.id === saved.id ? saved : x)) : [...old, saved];
        return next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      });
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success(contact ? 'Contact updated' : `${saved.name} added`);
      onSaved?.(saved, !contact);
      onClose();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      title={contact ? 'Edit contact' : 'New contact'}
      description={contact ? undefined : 'Shared with everyone in the family.'}
      icon={<Tile color={CATEGORIES[f.category].color} icon={CATEGORIES[f.category].icon} size={40} rounded="rounded-xl" />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form="vault-contact-form" loading={saving}>{contact ? 'Save changes' : 'Add contact'}</Button>
        </>
      }
    >
      <form id="vault-contact-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-fg">{errors.form}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errors.name} className="sm:col-span-2">
            <Input name="name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Dr. Priya Patel" maxLength={120} autoFocus />
          </Field>
          <Field label="Category">
            <Select name="category" value={f.category} onChange={(e) => set('category', e.target.value as ContactCategory)} options={CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORIES[c].label }))} />
          </Field>
          <Field label="Role">
            <Input name="role" value={f.role} onChange={(e) => set('role', e.target.value)} placeholder="Pediatrician, babysitter…" maxLength={80} />
          </Field>
          <Field label="Organization" className="sm:col-span-2">
            <Input name="organization" value={f.organization} onChange={(e) => set('organization', e.target.value)} placeholder="Clinic, school or company" maxLength={120} />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-semibold text-fg">Phone numbers</legend>
          {f.phones.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select aria-label={`Label for phone ${i + 1}`} value={PHONE_LABELS.includes(p.label) ? p.label : 'Other'} onChange={(e) => setPhone(i, { label: e.target.value })} className="w-[8.5rem] shrink-0" options={PHONE_LABELS.map((l) => ({ value: l, label: l }))} />
              <Input aria-label={`Phone number ${i + 1}`} type="tel" inputMode="tel" value={p.number} onChange={(e) => setPhone(i, { number: e.target.value })} placeholder="+1 555 0100" className="min-w-0 flex-1" maxLength={32} />
              <IconButton icon={X} label={`Remove phone ${i + 1}`} size="sm" onClick={() => set('phones', f.phones.filter((_, j) => j !== i))} disabled={f.phones.length === 1 && !p.number} />
            </div>
          ))}
          {f.phones.length < 6 && (
            <Button type="button" variant="ghost" size="sm" icon={Plus} className="self-start" onClick={() => set('phones', [...f.phones, { label: f.phones.length ? 'Work' : 'Mobile', number: '' }])}>
              Add number
            </Button>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" error={errors.email}>
            <Input name="email" type="email" inputMode="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" maxLength={200} />
          </Field>
          <Field label="Website">
            <Input name="website" inputMode="url" value={f.website} onChange={(e) => set('website', e.target.value)} placeholder="example.com" maxLength={300} />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea name="address" rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="Street, city" maxLength={300} />
          </Field>
          <Field label="Notes" className="sm:col-span-2" hint="Opening hours, account numbers, who to ask for…">
            <Textarea name="notes" rows={3} autoGrow value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} />
          </Field>
        </div>
        <div className="flex flex-col gap-1 rounded-2xl border border-border p-1.5">
          <div className="rounded-xl px-2.5 py-2"><Switch checked={f.emergency} onChange={(v) => set('emergency', v)} label="Emergency contact" description="Pinned at the top with a one-tap call button" /></div>
          <div className="rounded-xl px-2.5 py-2"><Switch checked={f.favorite} onChange={(v) => set('favorite', v)} label="Favorite" description="Shown first in the address book" /></div>
        </div>
        <p className="text-xs text-subtle">{plural(f.phones.filter((p) => p.number.trim()).length, 'phone number')} · everyone in the family can see this contact.</p>
      </form>
    </Modal>
  );
}
