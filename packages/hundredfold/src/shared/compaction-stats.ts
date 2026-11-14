export interface CompactionStats {
  /** Context tokens before the compaction. */
  preTokens?: number;
  /** Context tokens after it: what the next turn starts from. */
  postTokens?: number;
}
