import type { Role } from '../../lib/types';

export type PlaceIconKey = 'home' | 'school' | 'work' | 'sport' | 'shop' | 'park' | 'gym' | 'health' | 'food' | 'heart' | 'star' | 'pin';

export interface Place {
  id: number;
  family_id: number;
  name: string;
  icon: PlaceIconKey;
  color: string;
  lat: number;
  lng: number;
  radius: number;
  address: string | null;
  notify: boolean;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface PlaceBrief {
  id: number;
  name: string;
  icon: PlaceIconKey;
  color: string;
}

export interface MemberLocation {
  checkin_id: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  source: 'checkin' | 'live';
  note: string | null;
  battery: number | null;
  created_at: string;
  updated_at: string;
  place: PlaceBrief | null;
  since: string | null;
  nearest: (PlaceBrief & { meters: number }) | null;
}

export interface LocMember {
  id: number;
  name: string;
  color: string;
  avatar_url: string | null;
  role: Role;
  sharing: boolean;
  sharing_changed_at: string | null;
  location: MemberLocation | null;
}

export interface LocEvent {
  id: number;
  family_id: number;
  user_id: number;
  place_id: number | null;
  place_name: string;
  place_icon: PlaceIconKey;
  kind: 'arrived' | 'left';
  checkin_id: number | null;
  created_at: string;
  user?: { id: number; name: string; color: string; avatar_url: string | null };
}

export interface Overview {
  me: { user_id: number; sharing: boolean; changed_at: string | null };
  members: LocMember[];
  places: Place[];
  recent: LocEvent[];
}

export interface Checkin {
  id: number;
  user_id: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  place_id: number | null;
  source: 'checkin' | 'live';
  note: string | null;
  battery: number | null;
  created_at: string;
  updated_at: string;
}

export interface Visit {
  place_id: number | null;
  place: PlaceBrief | null;
  lat: number;
  lng: number;
  start: string;
  end: string;
  points: number;
  checkin_ids: number[];
  note: string | null;
  checked_in: boolean;
}

export interface History {
  user_id: number;
  days: number;
  sharing: boolean;
  hidden: boolean;
  checkins: Checkin[];
  visits: Visit[];
  events: LocEvent[];
  stats: { checkins: number; places_visited: number; meters: number };
}

export interface PlaceDetail extends Place {
  events: LocEvent[];
}

export interface CheckinResponse {
  checkin: Checkin;
  transitions: LocEvent[];
  merged: boolean;
  member: LocMember;
}

export interface LatLng {
  lat: number;
  lng: number;
}
