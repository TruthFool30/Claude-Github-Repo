import {
  Briefcase, Dumbbell, Heart, House, MapPin, School, ShoppingCart, Star, Stethoscope, Trees, Trophy, UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import type { PlaceIconKey } from './types';

export const PLACE_ICONS: { key: PlaceIconKey; label: string; icon: LucideIcon; color: string }[] = [
  { key: 'home', label: 'Home', icon: House, color: '#5B5BD6' },
  { key: 'school', label: 'School', icon: School, color: '#FFB224' },
  { key: 'work', label: 'Work', icon: Briefcase, color: '#0090FF' },
  { key: 'sport', label: 'Sports', icon: Trophy, color: '#30A46C' },
  { key: 'shop', label: 'Shopping', icon: ShoppingCart, color: '#F76B15' },
  { key: 'park', label: 'Park', icon: Trees, color: '#12A594' },
  { key: 'gym', label: 'Gym', icon: Dumbbell, color: '#E5484D' },
  { key: 'health', label: 'Health', icon: Stethoscope, color: '#D6409F' },
  { key: 'food', label: 'Food', icon: UtensilsCrossed, color: '#978365' },
  { key: 'heart', label: 'Family & friends', icon: Heart, color: '#D6409F' },
  { key: 'star', label: 'Favorite', icon: Star, color: '#8E4EC6' },
  { key: 'pin', label: 'Other', icon: MapPin, color: '#E5484D' },
];

const byKey = new Map(PLACE_ICONS.map((p) => [p.key, p]));
export const placeIcon = (key: string | null | undefined): LucideIcon => byKey.get(key as PlaceIconKey)?.icon ?? MapPin;
export const placeIconMeta = (key: string | null | undefined) => byKey.get(key as PlaceIconKey) ?? PLACE_ICONS[PLACE_ICONS.length - 1];

/** Tinted rounded tile with the place's icon. */
export function PlaceTile({ icon, color, size = 40, className }: { icon: string; color: string; size?: number; className?: string }) {
  const Icon = placeIcon(icon);
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-[30%]', className)}
      style={{
        width: size,
        height: size,
        backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`,
        color,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 22%, transparent)`,
      }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={2.2} />
    </span>
  );
}
