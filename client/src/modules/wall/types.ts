import type { Activity, User } from '../../lib/types';

export type Author = Pick<User, 'id' | 'name' | 'color' | 'avatar_url'> & Partial<User>;

export interface WallPhoto {
  id: number;
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface WallReaction {
  emoji: string;
  user_id: number;
  created_at: string;
}

export interface WallComment {
  id: number;
  post_id: number;
  parent_id: number | null;
  user_id: number | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  author: Author | null;
  /** Client-only: optimistic comment not yet confirmed by the server. */
  pending?: boolean;
}

export interface WallPost {
  id: number;
  family_id: number;
  user_id: number | null;
  body: string;
  mood: string | null;
  pinned: boolean;
  pinned_at: string | null;
  pinned_by: number | null;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  author: Author | null;
  photos: WallPhoto[];
  reactions: WallReaction[];
  comments: WallComment[];
  comment_count: number;
}

export type FeedItem =
  | { type: 'post'; key: string; created_at: string; post: WallPost }
  | { type: 'activity'; key: string; created_at: string; activity: Activity };

export interface FeedPage {
  items: FeedItem[];
  pinned?: WallPost[];
  next_cursor: string | null;
}

export type FeedFilter = 'all' | 'posts' | 'photos' | 'activity';

// ---- GET /api/dashboard (every key optional; other modules may not be installed) ----

export interface DashEvent {
  id: number | string;
  title: string;
  start: string;
  end?: string | null;
  all_day?: boolean | number | null;
  color?: string | null;
  location?: string | null;
}

export interface DashItem {
  id: number;
  list_id: number;
  list_name?: string | null;
  text: string;
  due_date?: string | null;
  assignee_id?: number | null;
}

export interface DashMeal {
  slot: string;
  title: string;
  recipe_id?: number | null;
}

export interface Dashboard {
  calendar?: { today?: DashEvent[]; upcoming?: DashEvent[] } | null;
  lists?: { due?: DashItem[]; overdue?: DashItem[]; lists?: Array<{ id: number; name: string; type: string; open_count: number }> } | null;
  meals?: { today?: DashMeal[] } | null;
  [module: string]: unknown;
}
