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
  invite_code: string;
  role: Role;
  nickname: string | null;
  member_count: number;
  created_at: string;
}

export interface Family {
  id: number;
  name: string;
  invite_code: string;
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
