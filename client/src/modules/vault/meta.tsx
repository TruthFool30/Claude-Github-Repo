import type { LucideIcon } from 'lucide-react';
import {
  Baby, Briefcase, Car, CreditCard, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Folder,
  GraduationCap, HeartPulse, House, IdCard, KeyRound, Landmark, PawPrint, Plane, Presentation, Scale, ShieldCheck, Siren,
  StickyNote, UserRound, Users, Wifi, Wrench,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ContactCategory, DocKind, FolderIcon, NoteKind } from './api';
import { cn } from '../../lib/cn';
import { initials } from '../../lib/format';

export const ACCENT = '#978365';

export const CATEGORIES: Record<ContactCategory, { label: string; plural: string; icon: LucideIcon; color: string }> = {
  emergency: { label: 'Emergency services', plural: 'Emergency services', icon: Siren, color: '#E5484D' },
  medical: { label: 'Medical', plural: 'Medical', icon: HeartPulse, color: '#D6409F' },
  school: { label: 'School', plural: 'School', icon: GraduationCap, color: '#0090FF' },
  childcare: { label: 'Childcare', plural: 'Childcare', icon: Baby, color: '#8E4EC6' },
  family: { label: 'Family & friends', plural: 'Family & friends', icon: Users, color: '#F76B15' },
  home: { label: 'Home services', plural: 'Home services', icon: Wrench, color: '#12A594' },
  pets: { label: 'Pets', plural: 'Pets', icon: PawPrint, color: '#30A46C' },
  work: { label: 'Work', plural: 'Work', icon: Briefcase, color: '#5B5BD6' },
  other: { label: 'Other', plural: 'Other', icon: UserRound, color: '#978365' },
};
export const CATEGORY_ORDER = Object.keys(CATEGORIES) as ContactCategory[];

export const FOLDER_ICONS: Record<FolderIcon, { label: string; icon: LucideIcon }> = {
  folder: { label: 'Folder', icon: Folder },
  medical: { label: 'Medical', icon: HeartPulse },
  school: { label: 'School', icon: GraduationCap },
  insurance: { label: 'Insurance', icon: ShieldCheck },
  home: { label: 'Home', icon: House },
  travel: { label: 'Travel', icon: Plane },
  car: { label: 'Car', icon: Car },
  finance: { label: 'Finance', icon: Landmark },
  kids: { label: 'Kids', icon: Baby },
  pets: { label: 'Pets', icon: PawPrint },
  legal: { label: 'Legal', icon: Scale },
  work: { label: 'Work', icon: Briefcase },
};

export const NOTE_KINDS: Record<NoteKind, { label: string; icon: LucideIcon; color: string; template: Array<{ label: string; secret: boolean }> }> = {
  wifi: { label: 'Wi-Fi', icon: Wifi, color: '#0090FF', template: [{ label: 'Network', secret: false }, { label: 'Password', secret: true }] },
  insurance: { label: 'Insurance', icon: ShieldCheck, color: '#30A46C', template: [{ label: 'Provider', secret: false }, { label: 'Policy / member ID', secret: true }, { label: 'Phone', secret: false }] },
  medical: { label: 'Medical', icon: HeartPulse, color: '#E5484D', template: [{ label: 'Blood type', secret: false }, { label: 'Allergies', secret: false }, { label: 'Medication', secret: false }] },
  id: { label: 'ID & passports', icon: IdCard, color: '#8E4EC6', template: [{ label: 'Document number', secret: true }, { label: 'Expires', secret: false }] },
  bank: { label: 'Bank', icon: CreditCard, color: '#12A594', template: [{ label: 'Bank', secret: false }, { label: 'Account number', secret: true }] },
  code: { label: 'Codes & PINs', icon: KeyRound, color: '#F76B15', template: [{ label: 'Code', secret: true }] },
  vehicle: { label: 'Vehicle', icon: Car, color: '#5B5BD6', template: [{ label: 'Plate', secret: false }, { label: 'VIN', secret: true }] },
  other: { label: 'Other', icon: StickyNote, color: '#978365', template: [{ label: '', secret: false }] },
};
export const NOTE_KIND_ORDER = Object.keys(NOTE_KINDS) as NoteKind[];

export const DOC_KINDS: Record<DocKind, { label: string; icon: LucideIcon; color: string }> = {
  pdf: { label: 'PDF', icon: FileText, color: '#E5484D' },
  image: { label: 'Image', icon: FileImage, color: '#8E4EC6' },
  text: { label: 'Text', icon: FileText, color: '#5B5BD6' },
  doc: { label: 'Document', icon: FileText, color: '#0090FF' },
  sheet: { label: 'Spreadsheet', icon: FileSpreadsheet, color: '#30A46C' },
  slides: { label: 'Slides', icon: Presentation, color: '#F76B15' },
  archive: { label: 'Archive', icon: FileArchive, color: '#978365' },
  audio: { label: 'Audio', icon: FileAudio, color: '#D6409F' },
  video: { label: 'Video', icon: FileVideo, color: '#12A594' },
  other: { label: 'File', icon: File, color: '#8d90a0' },
};

/** Soft tinted surface for an accent color (works in both themes). */
export const tint = (color: string, pct = 14): CSSProperties => ({
  backgroundColor: `color-mix(in oklab, ${color} ${pct}%, transparent)`,
  color: `color-mix(in oklab, ${color} 62%, var(--fg))`,
});

/** Rounded tile with an icon or initials on a tinted accent. */
export function Tile({
  color, icon: Icon, text, size = 44, className, rounded = 'rounded-2xl',
}: { color: string; icon?: LucideIcon; text?: string; size?: number; className?: string; rounded?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 select-none items-center justify-center font-bold', rounded, className)}
      style={{ ...tint(color, 16), width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {text !== undefined ? initials(text) : Icon ? <Icon size={Math.round(size * 0.46)} /> : null}
    </span>
  );
}

export const telHref = (n: string) => `tel:${n.replace(/[^+0-9*#,]/g, '')}`;
export const smsHref = (n: string) => `sms:${n.replace(/[^+0-9]/g, '')}`;
export const mapHref = (address: string) => `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`;

/** Days until a YYYY-MM-DD date (negative when past). */
export function daysUntil(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 864e5);
}

export function expiryLabel(date: string): { text: string; tone: 'danger' | 'warning' | 'neutral' } {
  const n = daysUntil(date);
  if (n < 0) return { text: n === -1 ? 'Expired yesterday' : `Expired ${-n} days ago`, tone: 'danger' };
  if (n === 0) return { text: 'Expires today', tone: 'danger' };
  if (n === 1) return { text: 'Expires tomorrow', tone: 'danger' };
  if (n <= 30) return { text: `Expires in ${n} days`, tone: n <= 7 ? 'danger' : 'warning' };
  return { text: `Expires ${date}`, tone: 'neutral' };
}

/** Very short expiry label for tight spaces (tiles). */
export function expiryShort(date: string): string {
  const n = daysUntil(date);
  if (n < 0) return 'Expired';
  if (n === 0) return 'Due today';
  return `${n}d left`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
