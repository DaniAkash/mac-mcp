export type SpotlightKind = "file" | "folder" | "any";

export interface SpotlightResult {
  path: string;
  /** Resolved at result-collection time via `statSync`. */
  kind: "file" | "folder" | "other";
}

export interface SpotlightSearchResult {
  results: SpotlightResult[];
  totalReturned: number;
  truncated: boolean;
  hint?: string;
}
