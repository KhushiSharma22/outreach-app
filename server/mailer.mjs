// Transactional email for sign-in (verification, password reset, invites). Outreach email is
// never sent by the server. Uses SMTP via nodemailer when SMTP_HOST is set; otherwise the
// message is printed to the server console so links work in local development.
import { AppError } from './lib.mjs';

const sent = []; // kept for tests and the development console
const isProduction = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

let transportPromise;
async function transport() {
  if (!process.env.SMTP_HOST) return null;
  if (isProduction() && (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM)) return null;
  transportPromise ??= import('nodemailer').then(({ default: nodemailer }) => nodemailer.createTransport({
    host: process.env.SMTP_HOST.trim(),
    port: +(String(process.env.SMTP_PORT || 587).trim()),
    secure: process.env.SMTP_SECURE === 'true' || +(String(process.env.SMTP_PORT || 587).trim()) === 465,
    requireTLS: isProduction() && process.env.SMTP_SECURE !== 'true' && +(String(process.env.SMTP_PORT || 587).trim()) !== 465,
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  }));
  return transportPromise;
}
export const mailConfigured = () => !!process.env.SMTP_HOST && (!isProduction() || !!(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM));
export function requireAccountMail() {
  if (isProduction() && !mailConfigured()) throw new AppError(503, 'email_failed', 'Account email is temporarily unavailable. Please contact support and try again.');
}

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function sendMail({ to, subject, text, action }) {
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#182b26;max-width:520px">${text.split('\n\n').map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${action ? `<p><a href="${esc(action.url)}" style="display:inline-block;background:#246847;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${esc(action.label)}</a></p><p style="color:#788780;font-size:12px">Or paste this link into your browser:<br>${esc(action.url)}</p>` : ''}</div>`;
  const body = action ? `${text}\n\n${action.label}: ${action.url}` : text;
  const msg = { from: process.env.MAIL_FROM || 'Outbound <no-reply@localhost>', to, subject, text: body, html };
  if (!isProduction()) {
    sent.push({ to, subject, text: body, url: action?.url, at: new Date().toISOString() });
    if (sent.length > 50) sent.shift();
  }
  const t = await transport();
  if (!t) requireAccountMail();
  if (t) {
    try { return await t.sendMail(msg); }
    catch (e) {
      // Do not log message bodies, links, credentials, or the provider's arbitrary reply.
      console.error(JSON.stringify({ t: new Date().toISOString(), event: 'mail_failed', code: e.code, responseCode: e.responseCode }));
      const hint = e.code === 'EAUTH' ? 'the mail server rejected the SMTP username or password'
        : ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'EDNS'].includes(e.code) ? 'the mail server could not be reached'
        : e.code === 'EENVELOPE' || e.responseCode === 553 || e.responseCode === 550 ? 'the mail server refused the sender or recipient address'
        : 'the mail server returned an error';
      throw new AppError(503, 'email_failed', `We couldn't send the email (${hint}). Please try again in a few minutes.`);
    }
  }
  if (process.env.NODE_ENV !== 'test') console.log(`\n[mail → ${to}] ${subject}\n${body}\n`);
}
export const sentMail = () => sent;
