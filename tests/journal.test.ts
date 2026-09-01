// ============================================================================
// UNIT TESTS — Mirror Journal: entry validation, ORDER BY injection guard, XSS
// ============================================================================
// Run:  npx ts-node tests/journal.test.ts
// Exit 0 = all passed, 1 = at least one failed.
//
// Proves the journal's input contract (validateJournalEntry), the SQL-injection
// safety of the list endpoint's sort (ORDER BY cannot be parameterised), and the
// HTML-escaping of user text (sanitizeText). Security-relevant: a bad sort guard
// is a direct SQLi vector; a bad sanitizer is stored XSS.
// ============================================================================

import { validateJournalEntry, sanitizeText } from '../utils/journalHelpers';
import { safeSortField, safeSortDirection, journalOrderByClause, JOURNAL_SORT_FIELDS } from '../utils/journalSort';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }

const validEntry = {
  entryDate: '2026-08-29',
  timeOfDay: 'morning',
  moodRating: 7,
  primaryEmotion: 'calm',
  emotionIntensity: 5,
  energyLevel: 6,
  freeFormEntry: 'A quiet start to the day.',
};

// ---------------------------------------------------------------------------
group('validateJournalEntry — a well-formed entry passes');
ok(validateJournalEntry({ ...validEntry }) === null, 'valid entry -> null (no error)');
ok(validateJournalEntry({ ...validEntry, freeFormEntry: undefined, promptResponses: { q: 'a' } }) === null, 'promptResponses satisfies content requirement');

// ---------------------------------------------------------------------------
group('validateJournalEntry — each rule rejects with a message');
ok(typeof validateJournalEntry({ ...validEntry, entryDate: undefined }) === 'string', 'missing date rejected');
ok(typeof validateJournalEntry({ ...validEntry, timeOfDay: 'lunchtime' }) === 'string', 'invalid timeOfDay rejected');
ok(typeof validateJournalEntry({ ...validEntry, moodRating: 0 }) === 'string', 'mood 0 rejected (below 1)');
ok(typeof validateJournalEntry({ ...validEntry, moodRating: 11 }) === 'string', 'mood 11 rejected (above 10)');
ok(typeof validateJournalEntry({ ...validEntry, moodRating: '7' as any }) === 'string', 'non-number mood rejected');
ok(typeof validateJournalEntry({ ...validEntry, primaryEmotion: '' }) === 'string', 'empty emotion rejected');
ok(typeof validateJournalEntry({ ...validEntry, emotionIntensity: 99 }) === 'string', 'intensity out of range rejected');
ok(typeof validateJournalEntry({ ...validEntry, energyLevel: -1 }) === 'string', 'energy out of range rejected');
ok(typeof validateJournalEntry({ ...validEntry, entryDate: '08/29/2026' }) === 'string', 'wrong date format rejected');
ok(typeof validateJournalEntry({ ...validEntry, freeFormEntry: undefined, promptResponses: undefined }) === 'string', 'no content rejected');
// boundary values are accepted
ok(validateJournalEntry({ ...validEntry, moodRating: 1, emotionIntensity: 10, energyLevel: 1 }) === null, 'boundary 1/10 accepted');

// ---------------------------------------------------------------------------
group('journal sort — allow-list is the SQL-injection guard');
for (const f of JOURNAL_SORT_FIELDS) {
  ok(safeSortField(f) === f, `allowed field '${f}' passes through`);
}
ok(safeSortField('password') === 'entry_date', 'unknown column -> entry_date');
ok(safeSortField('entry_date; DROP TABLE journal_entries;--') === 'entry_date', 'SQLi payload -> entry_date');
ok(safeSortField('mood_rating--') === 'entry_date', 'trailing comment payload -> entry_date');
ok(safeSortField(['mood_rating'] as any) === 'entry_date', 'array -> entry_date');
ok(safeSortField(undefined) === 'entry_date', 'undefined -> entry_date');
ok(safeSortDirection('asc') === 'ASC', 'literal asc -> ASC');
ok(safeSortDirection('ASC') === 'DESC', 'uppercase ASC is NOT asc -> DESC (strict)');
ok(safeSortDirection('desc') === 'DESC', 'desc -> DESC');
ok(safeSortDirection('; DELETE') === 'DESC', 'injection direction -> DESC');
ok(safeSortDirection(undefined) === 'DESC', 'undefined -> DESC');
{
  const clause = journalOrderByClause("x'; DROP TABLE t;--", 'asc');
  ok(clause === 'ORDER BY entry_date ASC', `clause built only from safe tokens (got: ${clause})`);
  ok(!/drop|;|--/i.test(clause), 'no injection substring survives into the clause');
}

// ---------------------------------------------------------------------------
group('sanitizeText — HTML-escape user content (stored-XSS guard)');
ok(sanitizeText('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;', 'script tag escaped');
ok(sanitizeText(`"'`) === '&quot;&#x27;', 'quotes escaped');
ok(sanitizeText('') === '', 'empty -> empty');
ok(!/[<>]/.test(sanitizeText('<img src=x onerror=1>')), 'no raw angle brackets survive');

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} journal: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
