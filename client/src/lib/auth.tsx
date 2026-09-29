import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, UNAUTHORIZED_EVENT } from './api';
import { onLiveReconnect, startLive, stopLive, subscribeLive, matchesPrefix } from './live';
import type { Family, FamilySummary, MeResponse, Member, Role, User } from './types';

export interface AuthState {
  /** null when signed out. */
  user: User | null;
  /** Active family (with members) or null when the user has none yet. */
  family: Family | null;
  members: Member[];
  families: FamilySummary[];
  role: Role | null;
  isAdmin: boolean;
  /** true until the first /auth/me (and /family) response arrives. */
  loading: boolean;
  refresh: () => Promise<void>;
  switchFamily: (familyId: number) => Promise<void>;
  login: (email: string, password: string) => Promise<MeResponse>;
  register: (input: { name: string; email: string; password: string; family_name?: string }) => Promise<MeResponse>;
  logout: () => Promise<void>;
  /** Replace cached /auth/me data (e.g. after PATCH /auth/me). */
  setMe: (me: MeResponse) => void;
}

const AuthContext = createContext<AuthState | null>(null);
export const ME_KEY = ['auth', 'me'] as const;
export const FAMILY_KEY = ['family'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const meQuery = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<MeResponse>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
  const me = meQuery.data ?? null;
  const activeFamilyId = me?.active_family_id ?? null;

  const familyQuery = useQuery({
    queryKey: FAMILY_KEY,
    queryFn: () => api.get<Family>('/family'),
    enabled: !!activeFamilyId,
    staleTime: 60_000,
  });

  // Realtime lifecycle follows the session.
  const signedIn = !!me?.user;
  useEffect(() => {
    if (!signedIn) {
      stopLive();
      return;
    }
    startLive();
    const offReconnect = onLiveReconnect(() => qc.invalidateQueries());
    const offFamily = subscribeLive((event) => {
      if (matchesPrefix(event.type, 'family')) {
        qc.invalidateQueries({ queryKey: FAMILY_KEY });
        qc.invalidateQueries({ queryKey: ME_KEY });
      }
    });
    return () => {
      offReconnect();
      offFamily();
    };
  }, [signedIn, qc]);

  // Any 401 from a non-auth API call means the session is gone.
  useEffect(() => {
    const onUnauthorized = () => {
      qc.setQueryData(ME_KEY, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ME_KEY }),
      qc.invalidateQueries({ queryKey: FAMILY_KEY }),
    ]);
  }, [qc]);

  const setMe = useCallback((next: MeResponse) => qc.setQueryData(ME_KEY, next), [qc]);

  const afterSignIn = useCallback(
    (res: MeResponse) => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
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
    qc.setQueryData(ME_KEY, null);
  }, [qc]);

  const switchFamily = useCallback(
    async (familyId: number) => {
      await api.post(`/families/${familyId}/activate`);
      // Every cached query belongs to the previous family: drop them all and refetch.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      await qc.invalidateQueries({ queryKey: ME_KEY });
    },
    [qc],
  );

  const family = activeFamilyId && familyQuery.data?.id === activeFamilyId ? familyQuery.data : null;
  const loading = meQuery.isPending || (!!activeFamilyId && !family && familyQuery.isPending && !familyQuery.isError);

  const value = useMemo<AuthState>(
    () => ({
      user: me?.user ?? null,
      family,
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
    }),
    [me, family, loading, refresh, switchFamily, login, register, logout, setMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** { user, family, members, families, role, isAdmin, loading, refresh, switchFamily, login, register, logout, setMe } */
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
