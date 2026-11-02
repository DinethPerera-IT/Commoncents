// CSV for spreadsheets (Excel, Google Sheets, Numbers).
// - Fields with commas, quotes or line breaks are quoted; quotes are doubled (RFC 4180).
// - Text starting with = + - @ (or a tab/CR) would run as a formula when the file is opened,
//   so such text gets a leading ' (OWASP "CSV injection"). Real numbers are left alone.
// - A UTF-8 byte-order mark makes Excel read names like "Pak’nSave" correctly.
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  // DATE columns are already 'YYYY-MM-DD' strings (db.js). A Date here is a real moment in
  // time (a timestamp), written as its UTC date.
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (typeof v !== 'number' && FORMULA.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const toCsv = (header, rows) =>
  '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
