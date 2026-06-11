export interface ContactSource {
  /** Source UUID directory name under ~/Library/Application Support/AddressBook/Sources */
  uuid: string;
  /** Absolute path to the per-source AddressBook-v22.abcddb */
  dbPath: string;
}

export interface EmailEntry {
  address: string;
  label?: string;
}

export interface PhoneEntry {
  /** Best-effort normalised form (digits, leading '+' when known). */
  normalized: string;
  /** As-typed value Apple persisted. */
  raw: string;
  label?: string;
}

export interface PostalAddressEntry {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  label?: string;
}

export interface UrlEntry {
  url: string;
  label?: string;
}

export interface ContactSummary {
  /** Apple's ZUNIQUEID, e.g. "BDE64915-...:ABPerson". Stable across runs. */
  id: string;
  displayName: string;
  organization?: string;
  jobTitle?: string;
  primaryEmail?: string;
  primaryPhone?: string;
  /** Every source UUID that surfaced a matching record before dedup. */
  sources: string[];
  isMe: boolean;
  modificationDate?: string;
}

export interface ContactFull extends ContactSummary {
  firstName?: string;
  lastName?: string;
  middleName?: string;
  nickname?: string;
  title?: string;
  suffix?: string;
  department?: string;
  emails: EmailEntry[];
  phones: PhoneEntry[];
  addresses: PostalAddressEntry[];
  urls: UrlEntry[];
  note?: string;
  birthday?: string;
  creationDate?: string;
}

export interface ContactsListResult {
  contacts: ContactSummary[];
  totalReturned: number;
  truncated: boolean;
  hint?: string;
}

export interface ContactsSearchResult {
  results: ContactSummary[];
  totalReturned: number;
  truncated: boolean;
  hint?: string;
}
