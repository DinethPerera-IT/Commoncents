import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../server/csv.js';

test('csvCell quotes commas, quotes and line breaks', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('Milk, eggs'), '"Milk, eggs"');
  assert.equal(csvCell('The "good" one'), '"The ""good"" one"');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(new Date('2026-11-02T00:00:00Z')), '2026-11-02');
});

test('csvCell neutralises spreadsheet formulas in text, not in numbers', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil","click")'), '"\'=HYPERLINK(""http://evil"",""click"")"');
  assert.equal(csvCell('+64 21 123'), "'+64 21 123");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-5 refund'), "'-5 refund");
  assert.equal(csvCell(-5.5), '-5.5');     // a real number stays a number
});

test('toCsv: BOM, header, CRLF rows', () => {
  assert.equal(toCsv(['a', 'b'], [[1, 'x,y']]), '﻿a,b\r\n1,"x,y"\r\n');
});
