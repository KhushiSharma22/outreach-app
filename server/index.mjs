// Entry point: node server/index.mjs
import { createApp } from './app.mjs';
import { getProvider } from './ai.mjs';
import { mailConfigured } from './mailer.mjs';
import { googleEnabled } from './auth.mjs';

const host = process.env.HOST || '127.0.0.1', port = +(process.env.PORT || 4173);
const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!local && !String(process.env.PUBLIC_URL || '').startsWith('https://')) {
  console.error('Set PUBLIC_URL to the https:// address users reach before binding beyond localhost. It is used for secure cookies and links in sign-in emails.');
  process.exit(1);
}
if (!local && !mailConfigured()) {
  console.error('Set SMTP_HOST (and SMTP_USER/SMTP_PASS/MAIL_FROM) so verification and password-reset emails can be delivered.');
  process.exit(1);
}
const app = await createApp();
app.server.listen(port, host, async () => {
  const p = await getProvider();
  console.log(`Outbound campaign studio running at http://${host}:${port}`);
  console.log(`Database: ${app.db.dialect === 'postgres' ? `PostgreSQL (${new URL(process.env.DATABASE_URL).host})` : `SQLite (${process.env.DB_FILE || 'data/outreach.db'})`}`);
  console.log(`AI provider: ${p.name}${p.model ? ` (${p.model})` : ' — set ANTHROPIC_API_KEY and run npm install to enable Claude'}`);
  console.log('Delivery mode: manual send tasks (no outreach email is sent by this server).');
  console.log(`Sign-in: email + password${googleEnabled() ? ' and Google' : ' (set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET to add Google)'}; account emails ${mailConfigured() ? 'sent via SMTP' : 'printed to this console (set SMTP_HOST to send them)'}. Links use ${app.publicUrl}.`);
});
const shutdown = () => { app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
