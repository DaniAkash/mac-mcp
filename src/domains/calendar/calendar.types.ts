export interface CalendarEntry {
  /** UUID (stable across runs). */
  id: string;
  title: string;
  /** Apple's stored type: "Local", "Birthdays", "CalDAV", "Subscribed", "Holidays", etc. */
  type: string;
  /** Hex color string (Apple stores like "#FF8800"). May be empty. */
  color?: string;
}

export interface EventSummary {
  /** UUID. */
  id: string;
  title: string;
  /** Calendar.title for the parent calendar. */
  calendarTitle: string;
  /** Calendar.type for the parent calendar. */
  calendarType: string;
  /** ISO 8601. */
  start: string;
  /** ISO 8601. */
  end: string;
  allDay: boolean;
  location?: string;
  url?: string;
}

export interface EventFull extends EventSummary {
  description?: string;
  calendarId: string;
  lastModified?: string;
}

export interface CalendarsResult {
  calendars: CalendarEntry[];
  hint?: string;
}

export interface EventsResult {
  events: EventSummary[];
  totalReturned: number;
  truncated: boolean;
  hint?: string;
}

export interface EventSearchResult {
  results: EventSummary[];
  totalReturned: number;
  truncated: boolean;
  hint?: string;
}
