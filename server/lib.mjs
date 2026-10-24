// Shared helpers: errors, validation, time zones, CSV.

export class AppError extends Error {
  constructor(status, code, message, fields) { super(message); this.status = status; this.code = code; this.fields = fields; }
}
export const notFound = what => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (code, message, extra) => Object.assign(new AppError(409, code, message), extra ? { extra } : {});
export const invalid = (message, fields) => new AppError(422, 'validation_failed', message, fields);

export const json = v => { try { return JSON.parse(v); } catch { return null; } };
export const EMAIL_RE = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[A-Za-z]{2,}$/;
export const normEmail = e => (e || '').trim().toLowerCase() || null;
export const normDomain = d => {
  const v = (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return v || null;
};
export const normLinkedin = u => {
  const v = (u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www\.|[a-z]{2}\.)linkedin\.com/, 'linkedin.com').replace(/\/+$/, '').split(/[?#]/)[0];
  return v.startsWith('linkedin.com/in/') ? v : null;
};

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function validTimezone(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

const fmtCache = new Map();
function parts(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }); fmtCache.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return o;
}
// Wall-clock view of an instant in an IANA zone.
export function localView(ts, tz) {
  const p = parts(ts, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}
// Converts local wall time in a zone to a UTC instant (DST-aware; a skipped local time moves forward).
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = ts => { const p = parts(ts, tz); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts; };
  let ts = guess - offset(guess);
  ts = guess - offset(ts);
  return new Date(ts).toISOString();
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const weekdayOf = date => WEEKDAYS[new Date(date + 'T12:00:00Z').getUTCDay()];

// RFC 4180 CSV parsing (quoted fields, embedded commas/newlines, CRLF).
export function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (q) throw invalid('The CSV has an unclosed quoted field.');
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}
