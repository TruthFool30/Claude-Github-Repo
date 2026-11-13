/** Shared API shapes (snake_case, as returned by the server). */

export type Role = 'admin' | 'member' | 'child';

export interface User {
  id: number;
  name: string;
  email: string | null;
  color: string;
  avatar_url: string | null;
  birthday: string | null;
  phone: string | null;
  created_at: string;
}

export interface Member extends User {
  role: Role;
  nickname: string | null;
  joined_at: string;
  /** Managed member (e.g. a young child) without their own login. */
  managed: boolean;
}

export interface FamilySummary {
  id: number;
  name: string;
  cover_url: string | null;
  currency: string;
  /** null unless you are an admin of this family. */
  invite_code: string | null;
  role: Role;
  nickname: string | null;
  member_count: number;
  created_at: string;
}

export interface Family {
  id: number;
  name: string;
  /** null unless you are an admin of this family. */
  invite_code: string | null;
  cover_url: string | null;
  currency: string;
  created_by: number | null;
  created_at: string;
  role: Role;
  members: Member[];
}

export interface MeResponse {
  user: User;
  families: FamilySummary[];
  active_family_id: number | null;
  /** Your own account only (never part of User, which other members see). */
  two_factor_enabled: boolean;
  recovery_codes_left: number;
}

/** POST /auth/login answer for accounts with two-factor login: send a code to /auth/login/2fa. */
export interface TwoFactorChallenge {
  two_factor_required: true;
  ticket: string;
}

export interface Activity {
  id: number;
  family_id: number;
  user_id: number | null;
  module: string;
  verb: string;
  entity_id: number | null;
  summary: string;
  link: string | null;
  created_at: string;
  user: User | null;
}

export interface Notification {
  id: number;
  user_id: number;
  family_id: number;
  module: string | null;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface SearchResult {
  module: string;
  title: string;
  subtitle?: string | null;
  link: string;
  avatar?: Pick<User, 'id' | 'name' | 'color' | 'avatar_url'>;
}

/** Anything Avatar can render. */
export interface AvatarUser {
  name: string;
  color?: string | null;
  avatar_url?: string | null;
}

/** SSE envelope delivered by /api/stream. */
export interface LiveEvent<P = unknown> {
  type: string;
  payload: P;
  at: string;
}
