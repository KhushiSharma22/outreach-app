// Transactional email for sign-in (verification, password reset, invites). Outreach email is
// never sent by the server. Uses SMTP via nodemailer when SMTP_HOST is set; otherwise the
// message is printed to the server console so links work in local development.
const sent = []; // kept for tests and the development console

let transportPromise;
async function transport() {
  if (!process.env.SMTP_HOST) return null;
  transportPromise ??= import('nodemailer').then(({ default: nodemailer }) => nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: +(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || +(process.env.SMTP_PORT || 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  }));
  return transportPromise;
}
export const mailConfigured = () => !!process.env.SMTP_HOST;

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function sendMail({ to, subject, text, action }) {
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#182b26;max-width:520px">${text.split('\n\n').map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${action ? `<p><a href="${esc(action.url)}" style="display:inline-block;background:#246847;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${esc(action.label)}</a></p><p style="color:#788780;font-size:12px">Or paste this link into your browser:<br>${esc(action.url)}</p>` : ''}</div>`;
  const body = action ? `${text}\n\n${action.label}: ${action.url}` : text;
  const msg = { from: process.env.MAIL_FROM || 'Outbound <no-reply@localhost>', to, subject, text: body, html };
  sent.push({ to, subject, text: body, url: action?.url, at: new Date().toISOString() });
  if (sent.length > 50) sent.shift();
  const t = await transport();
  if (t) return t.sendMail(msg);
  if (process.env.NODE_ENV !== 'test') console.log(`\n[mail → ${to}] ${subject}\n${body}\n`);
}
export const sentMail = () => sent;
