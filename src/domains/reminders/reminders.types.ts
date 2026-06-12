export interface ReminderList {
  /** UTF-8 decoded ZIDENTIFIER. */
  id: string;
  name: string;
  /** "list" for a regular list, "smart" for a Smart List. */
  type: "list" | "smart";
  /** Per-store filename so users can tell which account a list belongs to. */
  storeName: string;
}

export interface ReminderSummary {
  /** UTF-8 decoded ZIDENTIFIER. */
  id: string;
  title: string;
  listName?: string;
  listId?: string;
  completed: boolean;
  flagged: boolean;
  priority: number;
  dueDate?: string;
  creationDate?: string;
}

export interface ReminderFull extends ReminderSummary {
  notes?: string;
  startDate?: string;
  completionDate?: string;
  modificationDate?: string;
  allDay: boolean;
}

export type RemindersStatus = "open" | "completed" | "all";

export interface ListsResult {
  lists: ReminderList[];
  hint?: string;
}

export interface RemindersResult {
  reminders: ReminderSummary[];
  totalReturned: number;
  truncated: boolean;
  hint?: string;
}

export interface RemindersSearchResult {
  results: ReminderSummary[];
  totalReturned: number;
  truncated: boolean;
  hint?: string;
}
