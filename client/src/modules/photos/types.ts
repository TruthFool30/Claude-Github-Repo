import type { AvatarUser } from '../../lib/types';

export interface PhotoUser extends AvatarUser {
  id: number;
  name: string;
  color: string;
  avatar_url: string | null;
}

export interface Photo {
  id: number;
  album_id: number | null;
  album_title: string | null;
  url: string;
  thumb_url: string;
  width: number | null;
  height: number | null;
  size: number | null;
  mime: string | null;
  caption: string | null;
  taken_at: string;
  /** Local calendar date of the capture (YYYY-MM-DD) — used for month grouping. */
  taken_date: string;
  created_at: string;
  uploaded_by: number | null;
  uploader: PhotoUser | null;
  like_count: number;
  comment_count: number;
  liked: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface PhotoComment {
  id: number;
  photo_id: number;
  body: string;
  created_at: string;
  user_id: number | null;
  user: PhotoUser | null;
  can_delete: boolean;
}

export interface PhotoDetail extends Photo {
  likers: Array<PhotoUser & { created_at: string }>;
  comments: PhotoComment[];
}

export interface Album {
  id: number;
  title: string;
  description: string | null;
  event_date: string | null;
  cover_photo_id: number | null;
  cover: { id: number; url: string; thumb_url: string; width: number | null; height: number | null } | null;
  preview: Array<{ id: number; thumb_url: string }>;
  photo_count: number;
  first_taken_at: string | null;
  last_taken_at: string | null;
  contributor_ids: number[];
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_delete: boolean;
}

export interface AlbumDetail extends Album {
  photos: Photo[];
}

export interface Overview {
  total: number;
  unsorted: number;
  contributors: number;
  albums: number;
  likes: number;
  recent: Photo[];
}

export interface TimelinePage {
  items: Photo[];
  next_cursor: string | null;
  total?: number;
  months?: Array<{ month: string; count: number }>;
}
