// ============================================================================
// journalSort — SQL-injection-safe ORDER BY for the journal list endpoint.
// ============================================================================
// An ORDER BY column cannot be a bound parameter, so the sort field must be
// validated against a fixed allow-list before it is interpolated into SQL —
// otherwise `?sortBy=` is a direct SQL-injection vector. Extracted from
// journalController so that guard is provable in isolation and reused verbatim.
// ============================================================================

export const JOURNAL_SORT_FIELDS = [
  'entry_date', 'mood_rating', 'created_at', 'word_count', 'sentiment_score',
] as const;
export type JournalSortField = typeof JOURNAL_SORT_FIELDS[number];

/** Returns an allow-listed column, or the safe default. Anything not exactly a
 *  known column name (including injection payloads and non-strings) collapses to
 *  'entry_date'. */
export function safeSortField(sortBy: unknown): JournalSortField {
  return (typeof sortBy === 'string' && (JOURNAL_SORT_FIELDS as readonly string[]).includes(sortBy))
    ? (sortBy as JournalSortField)
    : 'entry_date';
}

/** Only the literal 'asc' selects ascending; everything else is DESC. The result
 *  is one of two constant tokens, never user input. */
export function safeSortDirection(sortOrder: unknown): 'ASC' | 'DESC' {
  return sortOrder === 'asc' ? 'ASC' : 'DESC';
}

/** A complete, injection-safe ORDER BY clause built only from allow-listed
 *  tokens — no user-controlled substring can reach the SQL. */
export function journalOrderByClause(sortBy: unknown, sortOrder: unknown): string {
  return `ORDER BY ${safeSortField(sortBy)} ${safeSortDirection(sortOrder)}`;
}
