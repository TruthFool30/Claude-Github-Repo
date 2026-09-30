import type { Role } from '../../lib/types';

export type ConversationKind = 'family' | 'direct' | 'group';

export interface Participant {
  id: number;
  name: string;
  color: string;
  avatar_url: string | null;
  role: Role;
  nickname: string | null;
  managed: boolean;
  last_read_id: number;
  joined_at: string;
}

export interface LastMessage {
  id: number;
  user_id: number | null;
  kind: 'text' | 'system';
  body: string;
  deleted: boolean;
  attachments: number;
  created_at: string;
}

export interface Conversation {
  id: number;
  kind: ConversationKind;
  name: string | null;
  emoji: string | null;
  color: string | null;
  title: string;
  created_by: number | null;
  created_at: string;
  last_activity_at: string;
  participants: Participant[];
  last_message: LastMessage | null;
  unread: number;
  last_read_id: number;
  muted: boolean;
}

export interface Attachment {
  id: number;
  url: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  /** Local preview while uploading (optimistic). */
  local?: boolean;
}

export interface ReplyRef {
  id: number;
  user_id: number | null;
  body: string;
  deleted: boolean;
  /** The quoted message is from a period this viewer wasn't in the group. */
  hidden?: boolean;
  attachments: number;
}

export interface Reaction {
  emoji: string;
  user_ids: number[];
}

export interface Message {
  id: number;
  conversation_id: number;
  user_id: number | null;
  kind: 'text' | 'system';
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  reply_to: ReplyRef | null;
  attachments: Attachment[];
  reactions: Reaction[];
  client_id?: string | null;
  /** Client-only state for optimistic sends. */
  pending?: boolean;
  failed?: boolean;
}

export interface MessagePage {
  messages: Message[];
  has_more: boolean;
}

export interface UnreadSummary {
  total: number;
  muted_total: number;
  conversations: Record<string, number>;
}

export interface ReadEvent {
  conversation_id: number;
  user_id: number;
  last_read_id: number;
}

export interface TypingEvent {
  conversation_id: number;
  user_id: number;
  name: string;
}

export interface MessageEvent {
  conversation_id: number;
  message: Message;
  client_id?: string | null;
}

export interface RemovedEvent {
  conversation_id: number;
  reason: 'deleted' | 'left' | 'removed';
  by: number;
}
