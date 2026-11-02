import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import '../server/db.js';

// Runs in any time zone, including UTC, where the date bug can't be seen from the outside:
// without the parser in db.js, pg would turn '2026-09-01' into a Date object.
test('DATE columns stay YYYY-MM-DD strings, so no time zone can shift them', () => {
  const parse = pg.types.getTypeParser(1082);
  assert.equal(parse('2026-09-01'), '2026-09-01');
  assert.equal(parse('2026-12-31'), '2026-12-31');
});
