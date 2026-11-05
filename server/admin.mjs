// Pilot access control and the super-admin portal.
// Who may use the app = super admins + ALLOWED_EMAILS (env, read-only) + people super admins add (database).
// Who may import leads = super admins + OPERATOR_EMAILS (env) + people marked operator in the database.
// Super admins are fixed by deployment config, never granted from inside the app.
import { now } from './db.mjs';
import { AppError, invalid, notFound, conflict, EMAIL_RE, normEmail } from './lib.mjs';
import { sendMail } from './mailer.mjs';

const DEFAULT_SUPER_ADMINS = 'khushi.sharma.2201@gmail.com,paroksh05@gmail.com,siddharth.m2703@gmail.com';
const list = v => [...new Set(String(v || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];
const norm = e => String(e || '').trim().toLowerCase();
export const superAdmins = () => list(process.env.SUPER_ADMIN_EMAILS ?? DEFAULT_SUPER_ADMINS);
export const isSuperAdmin = email => !!norm(email) && superAdmins().includes(norm(email));
const envAllowed = () => list(process.env.ALLOWED_EMAILS);
const envOperators = () => list(process.env.OPERATOR_EMAILS);

export async function isApproved(db, email) {
  const e = norm(email);
  if (!e) return false;
  if (isSuperAdmin(e) || envAllowed().includes(e)) return true;
  return !!await db.get('SELECT 1 FROM allowed_emails WHERE email=?', [e]);
}
export async function requireApproved(db, email) {
  if (!await isApproved(db, email)) throw new AppError(403, 'access_restricted', 'This private pilot is available only to approved email addresses. Contact the team for access.');
}
export async function isOperator(db, email) {
  const e = norm(email);
  if (!e) return false;
  if (isSuperAdmin(e) || envOperators().includes(e)) return true;
  return !!(await db.get('SELECT operator FROM allowed_emails WHERE email=?', [e]))?.operator;
}
function requireSuperAdmin(ctx) {
  if (!isSuperAdmin(ctx.user?.email)) throw new AppError(403, 'super_admin_only', 'Only super admins can manage pilot access.');
}
// Admin actions are logged under a fixed pseudo-workspace so they never mix with workspace activity.
const ADMIN_LOG = '__admin__';
const log = (ctx, type, summary, detail = {}) => ctx.db.audit(ADMIN_LOG, null, type, summary, detail, ctx.user.id);

export async function listPeople(ctx) {
  requireSuperAdmin(ctx);
  const rows = new Map();
  const row = e => rows.get(e) || rows.set(e, { email: e, super_admin: false, env_allowed: false, env_operator: false, added: null }).get(e);
  for (const e of superAdmins()) row(e).super_admin = true;
  for (const e of envAllowed()) row(e).env_allowed = true;
  for (const e of envOperators()) row(e).env_operator = true;
  for (const a of await ctx.db.all('SELECT a.*, u.name added_by_name FROM allowed_emails a LEFT JOIN users u ON u.id=a.added_by ORDER BY a.created_at DESC')) {
    row(a.email).added = { operator: !!a.operator, note: a.note, added_by: a.added_by_name, created_at: a.created_at };
  }
  // Accounts whose access was removed still show, so they can be re-approved.
  const users = await ctx.db.all(`SELECT u.id, lower(u.email) email, u.name, u.created_at, u.last_login_at, u.email_verified_at IS NOT NULL verified,
      (SELECT string_agg(w.name, ', ') FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=u.id) workspaces
    FROM users u`);
  for (const u of users) row(u.email).account = { id: u.id, name: u.name, created_at: u.created_at, last_login_at: u.last_login_at, verified: !!u.verified, workspaces: u.workspaces || '' };
  const people = [...rows.values()].map(p => {
    const approved = p.super_admin || p.env_allowed || !!p.added;
    const operator = p.super_admin || p.env_operator || !!p.added?.operator;
    return { ...p, approved, operator, editable: !!p.added && !p.super_admin, account: p.account || null };
  });
  const rank = p => p.super_admin ? 0 : p.approved ? 1 : 2;
  people.sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email));
  return { people, super_admin_source: process.env.SUPER_ADMIN_EMAILS ? 'env' : 'default' };
}

export async function addPeople(ctx, { emails, operator = false, note = '', notify = true }, publicUrl) {
  requireSuperAdmin(ctx);
  const raw = Array.isArray(emails) ? emails : String(emails || '').split(/[,;\s]+/);
  const wanted = [...new Set(raw.map(normEmail).filter(Boolean))];
  if (!wanted.length) throw invalid('Enter at least one email address.', { emails: 'Required.' });
  if (wanted.length > 100) throw invalid('Add at most 100 people at a time.');
  const bad = wanted.filter(e => !EMAIL_RE.test(e));
  if (bad.length) throw invalid(`Not valid email addresses: ${bad.join(', ')}`, { emails: 'Invalid.' });
  const results = [];
  for (const email of wanted) {
    const existed = await ctx.db.get('SELECT 1 FROM allowed_emails WHERE email=?', [email]);
    await ctx.db.run(`INSERT INTO allowed_emails(email, operator, note, added_by, created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET operator=excluded.operator, note=excluded.note`, [email, operator ? 1 : 0, String(note).slice(0, 300), ctx.user.id, now()]);
    await log(ctx, existed ? 'access.updated' : 'access.granted', `${email} ${existed ? 'updated' : 'approved'}${operator ? ' as operator' : ''}`, { email, operator: !!operator });
    let notified = false, notifyError = null;
    const hasAccount = !!await ctx.db.get('SELECT 1 FROM users WHERE lower(email)=?', [email]);
    if (notify && !existed && !hasAccount) {
      try {
        await sendMail({ to: email, subject: 'You have access to the Outbound pilot',
          text: `Hi,\n\n${ctx.user.name} gave you access to the Outbound private pilot.\n\nCreate your account with this email address (${email}). You'll confirm it by email, then set up your workspace.`,
          action: { label: 'Create your account', url: `${publicUrl}/#/signup` } });
        notified = true;
      } catch (e) { notifyError = e.message; }
    }
    results.push({ email, status: existed ? 'updated' : 'added', notified, notify_error: notifyError });
  }
  return { results, ...(await listPeople(ctx)) };
}

export async function updatePerson(ctx, email, { operator }) {
  requireSuperAdmin(ctx);
  const e = norm(decodeURIComponent(email));
  const r = await ctx.db.run('UPDATE allowed_emails SET operator=? WHERE email=?', [operator ? 1 : 0, e]);
  if (!r.changes) throw notFound('Approved person');
  await log(ctx, 'access.operator', `${e} ${operator ? 'can now import leads' : 'can no longer import leads'}`, { email: e, operator: !!operator });
  return listPeople(ctx);
}

export async function removePerson(ctx, email) {
  requireSuperAdmin(ctx);
  const e = norm(decodeURIComponent(email));
  if (isSuperAdmin(e)) throw conflict('super_admin', 'Super admins are set in the deployment configuration and can’t be removed here.');
  const r = await ctx.db.run('DELETE FROM allowed_emails WHERE email=?', [e]);
  if (!r.changes) throw envAllowed().includes(e) ? conflict('env_managed', `${e} is approved through ALLOWED_EMAILS in the deployment settings; remove it there.`) : notFound('Approved person');
  // Access is checked on every request; deleting sessions as well makes the sign-out immediate and final.
  if (!await isApproved(ctx.db, e)) await ctx.db.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email)=?)', [e]);
  await log(ctx, 'access.revoked', `${e} removed from the pilot; signed out everywhere`, { email: e });
  return listPeople(ctx);
}

export async function adminLog(ctx) {
  requireSuperAdmin(ctx);
  return { items: await ctx.db.all(`SELECT a.type, a.summary, a.created_at, u.email actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor
    WHERE a.workspace_id=? ORDER BY a.created_at DESC LIMIT 50`, [ADMIN_LOG]) };
}
