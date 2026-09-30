import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, qs } from '../../lib/api';
import { toast } from '../../ui';
import type { CheckinResponse, History, Overview, Place, PlaceDetail } from './types';

export const OVERVIEW_KEY = ['locator', 'overview'] as const;

export function useOverview() {
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api.get<Overview>('/locator') });
}

export function useHistory(userId: number | null, days = 7) {
  return useQuery({
    queryKey: ['locator', 'history', userId, days],
    queryFn: () => api.get<History>(`/locator/history/${userId}${qs({ days })}`),
    enabled: !!userId,
  });
}

export function usePlaceDetail(id: number | null) {
  return useQuery({
    queryKey: ['locator', 'place', id],
    queryFn: () => api.get<PlaceDetail>(`/locator/places/${id}`),
    enabled: !!id,
  });
}

export type PlaceInput = Pick<Place, 'name' | 'icon' | 'color' | 'lat' | 'lng' | 'radius' | 'notify'> & { address: string | null };

/** Create / update / delete places with optimistic cache updates. */
export function usePlaceMutations() {
  const qc = useQueryClient();
  const patchOverview = (fn: (o: Overview) => Overview) => {
    const prev = qc.getQueryData<Overview>(OVERVIEW_KEY);
    if (prev) qc.setQueryData(OVERVIEW_KEY, fn(prev));
    return prev;
  };
  const rollback = (prev: Overview | undefined) => prev && qc.setQueryData(OVERVIEW_KEY, prev);
  const settle = () => qc.invalidateQueries({ queryKey: ['locator'] });

  const create = useMutation({
    mutationFn: (input: PlaceInput) => api.post<Place>('/locator/places', input),
    onSuccess: (place) => {
      patchOverview((o) => ({ ...o, places: [...o.places.filter((p) => p.id !== place.id), place].sort((a, b) => a.name.localeCompare(b.name)) }));
    },
    onSettled: settle,
  });

  const update = useMutation({
    mutationFn: ({ id, ...input }: Partial<PlaceInput> & { id: number }) => api.patch<Place>(`/locator/places/${id}`, input),
    onMutate: ({ id, ...input }) => ({ prev: patchOverview((o) => ({ ...o, places: o.places.map((p) => (p.id === id ? { ...p, ...input } : p)) })) }),
    onError: (e, _v, c) => {
      rollback(c?.prev);
      toast.error(errorMessage(e));
    },
    onSettled: settle,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/locator/places/${id}`),
    onMutate: (id) => ({ prev: patchOverview((o) => ({ ...o, places: o.places.filter((p) => p.id !== id) })) }),
    onError: (e, _v, c) => {
      rollback(c?.prev);
      toast.error(errorMessage(e));
    },
    onSettled: settle,
  });

  return { create, update, remove };
}

export function useSharingMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sharing: boolean) => api.patch<{ sharing: boolean; changed_at: string }>('/locator/settings', { sharing }),
    onMutate: (sharing) => {
      const prev = qc.getQueryData<Overview>(OVERVIEW_KEY);
      if (prev) {
        qc.setQueryData<Overview>(OVERVIEW_KEY, {
          ...prev,
          me: { ...prev.me, sharing, changed_at: new Date().toISOString() },
          members: prev.members.map((m) => (m.id === prev.me.user_id ? { ...m, sharing } : m)),
        });
      }
      return { prev };
    },
    onError: (e, _v, c) => {
      if (c?.prev) qc.setQueryData(OVERVIEW_KEY, c.prev);
      toast.error(errorMessage(e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['locator'] }),
  });
}

export function useCheckinMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { lat: number; lng: number; accuracy?: number | null; note?: string | null; battery?: number | null }) =>
      api.post<CheckinResponse>('/locator/checkins', { ...body, source: 'checkin' }),
    onSuccess: (res) => {
      const prev = qc.getQueryData<Overview>(OVERVIEW_KEY);
      if (prev) qc.setQueryData<Overview>(OVERVIEW_KEY, { ...prev, members: prev.members.map((m) => (m.id === res.member.id ? res.member : m)) });
      qc.invalidateQueries({ queryKey: ['locator'] });
    },
  });
}

/** Re-render periodically so "5 min ago" labels stay fresh. */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Battery level 0–100 when the browser exposes it (Chromium), else null. */
export async function readBattery(): Promise<number | null> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
    if (!nav.getBattery) return null;
    const b = await nav.getBattery();
    return Math.round(b.level * 100);
  } catch {
    return null;
  }
}

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

/** One-shot browser geolocation with friendly error messages. */
export function getPosition(timeout = 15000): Promise<GeoFix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser can’t share its location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null }),
      (err) => reject(new Error(geoErrorMessage(err))),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

export function geoErrorMessage(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) return 'Location permission is blocked. Allow location for this site in your browser settings.';
  if (err.code === err.TIMEOUT) return 'Finding your location took too long. Try again, or pick the spot on the map.';
  return 'Your location isn’t available right now. Try again, or pick the spot on the map.';
}
