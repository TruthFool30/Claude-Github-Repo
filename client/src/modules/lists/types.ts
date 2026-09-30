export type ListType = 'shopping' | 'todo' | 'other';

export interface ListSummary {
  id: number;
  family_id: number;
  name: string;
  type: ListType;
  icon: string;
  color: string;
  position: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  item_count: number;
  done_count: number;
  open_count: number;
  overdue_count: number;
  due_today_count: number;
  preview: string[];
  assignee_ids: number[];
  can_manage: boolean;
}

export interface ListItem {
  id: number;
  list_id: number;
  family_id: number;
  text: string;
  quantity: string | null;
  notes: string | null;
  category: string | null;
  assignee_id: number | null;
  due_date: string | null;
  done: boolean;
  done_by: number | null;
  done_at: string | null;
  position: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_edit_notes: boolean;
  can_delete: boolean;
}

export interface ListDetail extends ListSummary {
  items: ListItem[];
}

export interface TaskItem extends ListItem {
  list_name: string;
  list_icon: string;
  list_color: string;
  list_type: ListType;
}

export interface MyTasks {
  user_id: number;
  date: string;
  overdue: TaskItem[];
  today: TaskItem[];
  upcoming: TaskItem[];
  someday: TaskItem[];
}

export interface ItemInput {
  text?: string;
  quantity?: string | null;
  notes?: string | null;
  category?: string | null;
  assignee_id?: number | null;
  due_date?: string | null;
  done?: boolean;
  list_id?: number;
  /** Append a signed note (what a child assignee can do). */
  add_note?: string;
}
