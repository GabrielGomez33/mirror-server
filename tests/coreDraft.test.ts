// ============================================================================
// UNIT TESTS — resumable Core-intake draft sanitization + projection (pure)
// ============================================================================
// Run:  npx ts-node tests/coreDraft.test.ts
// Exit 0 = all passed, 1 = at least one failed.
//
// Drafts persist ONLY text answers for one step. This proves the content
// backstop: media keys, data: URLs, and oversized strings never survive into a
// stored draft (so draft_state can't become a blob/DoS store), arrays/indices
// are preserved (answers stay aligned), non-objects normalize to null (no
// draft), and DB rows project safely — a corrupt/legacy value degrades to null
// instead of throwing. The 100 KB byte cap is the separate SIZE backstop.
// ============================================================================

import {
  stripMedia,
  sanitizeDraftState,
  projectStepDraft,
  MAX_DRAFT_STRING,
} from '../utils/coreDraft';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
}
function group(name: string): void { console.log(`\n• ${name}`); }

// ---------------------------------------------------------------------------
group('sanitizeDraftState — only plain objects become drafts');
eq(sanitizeDraftState(null), null, 'null -> null');
eq(sanitizeDraftState(undefined), null, 'undefined -> null');
eq(sanitizeDraftState('hello'), null, 'string -> null (not a draft)');
eq(sanitizeDraftState(42), null, 'number -> null');
eq(sanitizeDraftState(true), null, 'boolean -> null');
eq(sanitizeDraftState([1, 2, 3]), null, 'array -> null (drafts are objects)');
eq(sanitizeDraftState({}), {}, 'empty object -> empty object');

// ---------------------------------------------------------------------------
group('sanitizeDraftState — legit answers preserved, media stripped');
eq(
  sanitizeDraftState({ currentQuestionIndex: 3, userAnswers: [1, 0, 2], showResult: false }),
  { currentQuestionIndex: 3, userAnswers: [1, 0, 2], showResult: false },
  'IQ-style draft preserved verbatim',
);
eq(
  sanitizeDraftState({ orderIds: ['q1', 'q2'], index: 1, answers: { q1: 'a' } }),
  { orderIds: ['q1', 'q2'], index: 1, answers: { q1: 'a' } },
  'personality-style draft preserved verbatim',
);

// ---------------------------------------------------------------------------
group('media keys dropped (by name), anywhere in the tree');
eq(
  sanitizeDraftState({ index: 2, photoFileRef: 'x', voiceMetadata: { d: 1 }, imageBlob: 'y' }),
  { index: 2 },
  'top-level media-named keys dropped',
);
eq(
  sanitizeDraftState({ step: { keep: 1, faceImage: 'zz', audioBuffer: [1, 2] } }),
  { step: { keep: 1 } },
  'nested media-named keys dropped',
);
ok(!('base64Data' in (sanitizeDraftState({ base64Data: 'AAAA', ok: 1 }) as any)), 'base64 key dropped');

// ---------------------------------------------------------------------------
group('data: URLs and oversized strings dropped (→ null), regardless of key');
eq(
  sanitizeDraftState({ note: 'data:image/png;base64,AAAA', keep: 'fine' }),
  { note: null, keep: 'fine' },
  'a data: URL value under an innocuous key -> null',
);
const huge = 'x'.repeat(MAX_DRAFT_STRING + 1);
// innocuous key (NOT media-named) so this exercises the oversized-VALUE path,
// not the media-KEY drop; the value is nulled but the key is kept.
eq(sanitizeDraftState({ longNote: huge, n: 5 }), { longNote: null, n: 5 }, 'oversized string value -> null');
eq(
  sanitizeDraftState({ arr: ['data:xxx', 'ok', 'y'.repeat(MAX_DRAFT_STRING + 1)] }),
  { arr: [null, 'ok', null] },
  'data:/oversized inside arrays -> null, indices preserved',
);

// ---------------------------------------------------------------------------
group('robustness — nesting bound, no throw on pathological input');
let deep: any = { a: 1 };
for (let i = 0; i < 40; i++) deep = { nested: deep };
ok((() => { try { sanitizeDraftState(deep); return true; } catch { return false; } })(), 'deep nesting does not throw');
eq(stripMedia(5), 5, 'primitive passthrough (number)');
eq(stripMedia('ok'), 'ok', 'primitive passthrough (short string)');
eq(stripMedia(null), null, 'null passthrough');

// ---------------------------------------------------------------------------
group('projectStepDraft — DB row -> API shape');
eq(
  projectStepDraft('iq', undefined),
  { step: 'iq', status: 'not_started', completedAt: null, draftState: null },
  'missing row -> not_started + null draft',
);
eq(
  projectStepDraft('personality', { step_key: 'personality', status: 'in_progress', completed_at: null, draft_state: { index: 2 } }),
  { step: 'personality', status: 'in_progress', completedAt: null, draftState: { index: 2 } },
  'object draft_state (mysql2 JSON) passed through',
);
eq(
  projectStepDraft('iq', { status: 'in_progress', completed_at: null, draft_state: '{"currentQuestionIndex":4}' }),
  { step: 'iq', status: 'in_progress', completedAt: null, draftState: { currentQuestionIndex: 4 } },
  'string draft_state parsed',
);
ok(
  projectStepDraft('iq', { status: 'in_progress', completed_at: null, draft_state: '{not json' }).draftState === null,
  'unparseable draft_state -> null (no throw)',
);
ok(
  projectStepDraft('iq', { status: 'in_progress', completed_at: null, draft_state: '[1,2,3]' }).draftState === null,
  'array draft_state -> null (drafts are objects)',
);
{
  const p = projectStepDraft('visual', { status: 'completed', completed_at: '2026-01-02T03:04:05Z', draft_state: null });
  ok(p.status === 'completed' && p.draftState === null, 'completed step with no draft');
  ok(typeof p.completedAt === 'string' && p.completedAt.includes('2026-01-02'), 'completed_at -> ISO string');
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} coreDraft: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
