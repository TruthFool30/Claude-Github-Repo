import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, FAMILY_LOST_EVENT, setApiFamily, UNAUTHORIZED_EVENT } from './api';
import { onLiveReconnect, startLive, stopLive, subscribeLive, matchesPrefix } from './live';
import type { Family, FamilySummary, MeResponse, Member, Role, User } from './types';
import { toast } from '../ui/toast';

export interface AuthState {
  /** null when signed out. */
  user: User | null;
  /** This tab's active family (with members), or null when the user has none yet. */
  family: Family | null;
  /** Id of this tab's active family (available before `family` has loaded). */
  familyId: number | null;
  members: Member[];
  families: FamilySummary[];
  role: Role | null;
  isAdmin: boolean;
  /** true until the first /auth/me (and /family) response arrives. */
  loading: boolean;
  refresh: () => Promise<void>;
  /** Switch THIS TAB to another family (also becomes the default for new tabs). */
  switchFamily: (familyId: number) => Promise<void>;
  login: (email: string, password: string) => Promise<MeResponse>;
  register: (input: { name: string; email: string; password: string; family_name?: string }) => Promise<MeResponse>;
  logout: () => Promise<void>;
  /** Replace cached /auth/me data (e.g. after PATCH /auth/me). */
  setMe: (me: MeResponse) => void;
  /** Call before leaving/deleting a family yourself so no "you were removed" toast is shown. */
  /** Mark an exit you are about to cause (leave/delete) so no "you were removed" toast shows. Returns an undo for when the request fails. */
  expectFamilyExit: (familyId: number) => () => void;
  /**
   * After you left/deleted a family: cancels in-flight queries, moves this tab to another family
   * right away (no burst of requests for the old one) and refreshes the session.
   */
  forgetFamily: (familyId: number) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
export const ME_KEY = ['auth', 'me'] as const;
export const FAMILY_KEY = ['family'] as const;
const TAB_KEY = 'hearth-tab-family';

const readTabFamily = (): number | null => {
  try {
    const v = Number(sessionStorage.getItem(TAB_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

const notAuthQuery = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== 'auth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [tabFamily, setTabFamily] = useState<number | null>(readTabFamily);

  const meQuery = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        const res = await api.get<MeResponse | { user: null }>('/auth/me');
        return res.user ? (res as MeResponse) : null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
  const me = meQuery.data ?? null;

  // This tab's family: its own choice when still valid, else the session default, else the first.
  const activeFamilyId = useMemo(() => {
    if (!me) return null;
    if (tabFamily && me.families.some((f) => f.id === tabFamily)) return tabFamily;
    if (me.active_family_id && me.families.some((f) => f.id === me.active_family_id)) return me.active_family_id;
    return me.families[0]?.id ?? null;
  }, [me, tabFamily]);

  // Every API request from this tab carries X-Family-Id (set synchronously so the very first
  // queries of a render already use it).
  setApiFamily(activeFamilyId);

  // Only touch the stored tab family once the session has loaded: clearing it while /auth/me is
  // still pending would make a quick reload fall back to another tab's family.
  const meLoaded = meQuery.isSuccess;
  useEffect(() => {
    if (!meLoaded) return;
    try {
      if (activeFamilyId) sessionStorage.setItem(TAB_KEY, String(activeFamilyId));
      else if (me && me.families.length === 0) sessionStorage.removeItem(TAB_KEY);
    } catch {
      /* ignore */
    }
  }, [activeFamilyId, meLoaded, me]);

  const familyQuery = useQuery({
    queryKey: FAMILY_KEY,
    queryFn: () => api.get<Family>('/family'),
    enabled: !!activeFamilyId,
    staleTime: 60_000,
  });

  // Remember family names + why we lost one, for a friendly message.
  const knownFamilies = useRef(new Map<number, string>());
  me?.families.forEach((f) => knownFamilies.current.set(f.id, f.name));
  const lastRemoval = useRef<{ familyId: number; reason?: string } | null>(null);
  const expectedExit = useRef(new Set<number>());

  /**
   * Synchronously forget a family in this tab: cancel in-flight non-auth queries (so their
   * NOT_MEMBER rejections are ignored and no error state flashes), drop it from the cached
   * session and move the tab (and the X-Family-Id header) to the next family.
   */
  const dropFamilyLocally = useCallback(
    (familyId: number) => {
      const current = qc.getQueryData<MeResponse | null>(ME_KEY);
      // Already dropped (e.g. the realtime `family.removed` beat the HTTP response): do nothing,
      // in particular don't cancel the refetches the first drop started for the next family.
      if (!current || !current.families.some((f) => f.id === familyId)) return;
      void qc.cancelQueries({ predicate: notAuthQuery });
      const families = current.families.filter((f) => f.id !== familyId);
      const next = families[0]?.id ?? null;
      setApiFamily(next);
      setTabFamily(next);
      qc.setQueryData(ME_KEY, {
        ...current,
        families,
        active_family_id: current.active_family_id === familyId ? next : current.active_family_id,
      });
    },
    [qc],
  );

  // Active family changed for ANY reason (switch, removal, deletion): drop every cached
  // non-auth query so nothing from the previous family can leak into this one.
  const prevFamily = useRef<number | null>(activeFamilyId);
  useEffect(() => {
    const prev = prevFamily.current;
    prevFamily.current = activeFamilyId;
    if (prev === activeFamilyId || prev === null) return;
    qc.resetQueries({ predicate: notAuthQuery });
    const stillMember = me?.families.some((f) => f.id === prev);
    if (!stillMember && me) {
      const name = knownFamilies.current.get(prev) ?? 'the family';
      if (expectedExit.current.has(prev)) {
        expectedExit.current.delete(prev);
      } else {
        const reason = lastRemoval.current?.familyId === prev ? lastRemoval.current.reason : undefined;
        toast.warning(reason === 'deleted' ? `${name} was deleted` : `You were removed from ${name}`, {
          description: activeFamilyId ? 'Switched to your other family.' : undefined,
        });
      }
    }
  }, [activeFamilyId, me, qc]);

  // Realtime lifecycle follows the session and this tab's family.
  const signedIn = !!me?.user;
  useEffect(() => {
    if (!signedIn) {
      stopLive();
      return;
    }
    startLive(activeFamilyId);
  }, [signedIn, activeFamilyId]);

  useEffect(() => {
    if (!signedIn) return;
    const offReconnect = onLiveReconnect(() => qc.invalidateQueries());
    const offFamily = subscribeLive((event) => {
      if (event.type === 'family.removed') {
        const p = event.payload as { family_id: number; reason?: string };
        lastRemoval.current = { familyId: p.family_id, reason: p.reason };
        if (p.family_id === prevFamily.current) {
          // Move this tab first so no request goes out with the removed family's id.
          dropFamilyLocally(p.family_id);
          qc.invalidateQueries({ queryKey: ME_KEY });
          return;
        }
      }
      if (matchesPrefix(event.type, 'family')) {
        qc.invalidateQueries({ queryKey: FAMILY_KEY });
        qc.invalidateQueries({ queryKey: ME_KEY });
      }
    });
    return () => {
      offReconnect();
      offFamily();
    };
  }, [signedIn, qc, dropFamilyLocally]);

  // 401 from a non-auth call: session gone. 403 NOT_MEMBER: this tab's family is gone.
  useEffect(() => {
    const onUnauthorized = () => {
      stopLive();
      qc.setQueryData(ME_KEY, null);
      qc.removeQueries({ predicate: notAuthQuery });
    };
    const onFamilyLost = (e: Event) => {
      const lost = (e as CustomEvent<{ familyId: number | null }>).detail?.familyId;
      if (lost && lost === prevFamily.current) dropFamilyLocally(lost);
      qc.invalidateQueries({ queryKey: ME_KEY }); // confirm with the server
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener(FAMILY_LOST_EVENT, onFamilyLost);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener(FAMILY_LOST_EVENT, onFamilyLost);
    };
  }, [qc, dropFamilyLocally]);

  const refresh = useCallback(async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ME_KEY }), qc.invalidateQueries({ queryKey: FAMILY_KEY })]);
  }, [qc]);

  const setMe = useCallback((next: MeResponse) => qc.setQueryData(ME_KEY, next), [qc]);

  const afterSignIn = useCallback(
    (res: MeResponse) => {
      qc.removeQueries({ predicate: notAuthQuery });
      setTabFamily(res.active_family_id);
      qc.setQueryData(ME_KEY, res);
      return res;
    },
    [qc],
  );

  const login = useCallback(
    async (email: string, password: string) => afterSignIn(await api.post<MeResponse>('/auth/login', { email, password })),
    [afterSignIn],
  );

  const register = useCallback(
    async (input: { name: string; email: string; password: string; family_name?: string }) =>
      afterSignIn(await api.post<MeResponse>('/auth/register', input)),
    [afterSignIn],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* already signed out */
    }
    stopLive();
    qc.clear();
    try {
      sessionStorage.removeItem(TAB_KEY);
    } catch {
      /* ignore */
    }
    setTabFamily(null);
    qc.setQueryData(ME_KEY, null);
  }, [qc]);

  const switchFamily = useCallback(
    async (familyId: number) => {
      // Also make it the default for newly opened tabs; other open tabs keep their own family.
      await api.post(`/families/${familyId}/activate`);
      setTabFamily(familyId);
      await qc.invalidateQueries({ queryKey: ME_KEY });
    },
    [qc],
  );

  const expectFamilyExit = useCallback((familyId: number) => {
    expectedExit.current.add(familyId);
    return () => {
      expectedExit.current.delete(familyId);
    };
  }, []);

  const forgetFamily = useCallback(
    async (familyId: number) => {
      expectedExit.current.add(familyId);
      dropFamilyLocally(familyId);
      await qc.invalidateQueries({ queryKey: ME_KEY });
    },
    [qc, dropFamilyLocally],
  );

  const family = activeFamilyId && familyQuery.data?.id === activeFamilyId ? familyQuery.data : null;
  const loading = meQuery.isPending || (!!activeFamilyId && !family && familyQuery.isPending && !familyQuery.isError);

  const value = useMemo<AuthState>(
    () => ({
      user: me?.user ?? null,
      family,
      familyId: activeFamilyId,
      members: family?.members ?? [],
      families: me?.families ?? [],
      role: family?.role ?? null,
      isAdmin: family?.role === 'admin',
      loading,
      refresh,
      switchFamily,
      login,
      register,
      logout,
      setMe,
      expectFamilyExit,
      forgetFamily,
    }),
    [me, family, activeFamilyId, loading, refresh, switchFamily, login, register, logout, setMe, expectFamilyExit, forgetFamily],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** { user, family, familyId, members, families, role, isAdmin, loading, refresh, switchFamily, login, register, logout, setMe } */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Look up a family member by id (null-safe). */
export function useMember(userId: number | null | undefined): Member | null {
  const { members } = useAuth();
  return useMemo(() => members.find((m) => m.id === userId) ?? null, [members, userId]);
}
