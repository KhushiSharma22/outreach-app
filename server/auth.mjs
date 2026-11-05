// Accounts: email + password (verified by email), Google sign-in (OpenID Connect with PKCE),
// database-backed sessions, password reset, and workspace invites.
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { id, now, hash } from './db.mjs';
import { AppError, invalid, conflict, notFound, EMAIL_RE, normEmail, json } from './lib.mjs';
import { DEFAULT_CONTEXT } from './campaigns.mjs';
import { sendMail } from './mailer.mjs';
import { isApproved, requireApproved, isSuperAdmin, isOperator } from './admin.mjs';

const DAY = 864e5;
const SESSION_TTL = 30 * DAY;
export const SESSION_COOKIE = 'ob_session';
const OAUTH_COOKIE = 'ob_oauth';
const GOOGLE_AUTH_URL = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
// Google implementation retained below for a future release; disabled at both endpoints.
export const googleEnabled = () => false;
export const emailAllowed = email => new Set((process.env.ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)).has(String(email || '').trim().toLowerCase());
export function requireAllowed(email) {
  if (!emailAllowed(email)) throw new AppError(403, 'access_restricted', 'This private pilot is available only to approved email addresses. Contact the team for access.');
}

// ---------- Passwords ----------
const SCRYPT = { N: 32768, r: 8, p: 1 };
const derive = (pw, salt, { N, r, p }) => new Promise((res, rej) => scrypt(pw.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 128 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
export async function hashPassword(pw) {
  const salt = randomBytes(16), key = await derive(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || DUMMY_HASH).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64'), actual = await derive(String(pw), Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p });
  return stored != null && actual.length === expected.length && timingSafeEqual(actual, expected);
}
// Used when the account does not exist so failed sign-ins take the same time either way.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou12', 'letmein123', 'welcome123', 'passw0rd12', 'admin12345']);
function passwordProblem(pw, email) {
  pw = String(pw ?? '');
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 'Choose a less common password.';
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 3) return 'Don’t include your email name in your password.';
  return null;
}

// ---------- Rate limiting (sliding window, stored in the database so it holds across instances) ----------
async function limit(db, key, max, windowMs) {
  const k = hash('rate', key); // keys can contain emails; store only a hash
  const n = (await db.get('SELECT count(*) n FROM rate_limit_hits WHERE key=? AND at>?', [k, new Date(Date.now() - windowMs).toISOString()])).n;
  if (n >= max) throw new AppError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  await db.insert('rate_limit_hits', { key: k, at: now() });
  if (Math.random() < 0.02) await db.run('DELETE FROM rate_limit_hits WHERE at<?', [new Date(Date.now() - 2 * DAY).toISOString()]);
}
export const resetRateLimits = db => db.run('DELETE FROM rate_limit_hits');
// Behind Vercel (or TRUST_PROXY=true) the client address comes from the proxy's X-Forwarded-For.
export const clientIp = req => (process.env.VERCEL || process.env.TRUST_PROXY === 'true') && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

// ---------- One-time tokens ----------
const newToken = () => randomBytes(32).toString('base64url');
async function createToken(db, { kind, ttl, user_id = null, email = null, workspace_id = null, role = null, data = {}, created_by = null }) {
  const token = newToken();
  await db.insert('auth_tokens', { id: id(), kind, token_hash: hash(token), user_id, email, workspace_id, role, data: JSON.stringify(data), created_by, created_at: now(), expires_at: new Date(Date.now() + ttl).toISOString(), used_at: null });
  return token;
}
async function findToken(db, kind, token) {
  const row = token && await db.get('SELECT * FROM auth_tokens WHERE token_hash=? AND kind=?', [hash(String(token)), kind]);
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
  return { ...row, data: json(row.data) };
}
async function consumeToken(db, kind, token, message) {
  const row = await findToken(db, kind, token);
  if (!row || !(await db.run('UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL', [now(), row.id])).changes) throw new AppError(400, 'invalid_token', message || 'This link is invalid or has expired. Request a new one.');
  return row;
}

// ---------- Users, workspaces, sessions ----------
const userByEmail = async (db, email) => await db.get('SELECT * FROM users WHERE lower(email)=lower(?)', [email]);
// Creates a user. With an invite they join that workspace; otherwise they get their own.
async function createUser(db, { name, email, password_hash = null, verified = false, google_sub = null, company, invite = null }) {
  await requireApproved(db, email);
  return await db.tx(async () => {
    const userId = id(), t = now();
    const wsId = invite ? invite.workspace_id : null;
    const user = { id: userId, workspace_id: wsId, name: name.slice(0, 80), email, role: invite ? invite.role : 'owner', token_hash: null, created_at: t, password_hash, email_verified_at: verified ? t : null, google_sub, last_login_at: null };
    let ws;
    if (!invite) {
      // users.workspace_id is NOT NULL: create the workspace first, then the user.
      ws = { id: id(), name: (company || `${name.split(' ')[0]}’s workspace`).slice(0, 80), sending_stopped: 0, created_at: t };
      await db.insert('workspaces', ws);
      user.workspace_id = ws.id;
    }
    await db.insert('users', user);
    if (!invite) {
      await db.insert('account_context_versions', { id: id(), workspace_id: ws.id, version: 1, created_by: userId, created_at: t,
        data: JSON.stringify({ ...DEFAULT_CONTEXT, company: ws.name, website: '', offering: '', icp: '', proof: '', sender: name.split(' ')[0], email, signature: `${name}\n${ws.name}` }) });
    }
    await db.insert('memberships', { workspace_id: user.workspace_id, user_id: userId, role: user.role, invited_by: invite?.created_by || null, created_at: t });
    if (invite) await db.audit(invite.workspace_id, null, 'member.joined', `${name} joined the workspace`, {}, userId);
    else await db.audit(ws.id, null, 'workspace.created', `Workspace created by ${name}`, {}, userId);
    return user;
  });
}
export async function createSession(db, user, { workspaceId, method, userAgent }) {
  await requireApproved(db, user.email);
  const ws = workspaceId && await db.get('SELECT workspace_id FROM memberships WHERE user_id=? AND workspace_id=?', [user.id, workspaceId])
    || await db.get('SELECT workspace_id FROM memberships WHERE user_id=? ORDER BY CASE WHEN workspace_id=? THEN 0 ELSE 1 END, created_at LIMIT 1', [user.id, user.workspace_id]);
  if (!ws) throw new AppError(403, 'no_workspace', 'This account is not a member of any workspace.');
  const token = newToken(), t = now();
  await db.insert('sessions', { id: id(), token_hash: hash(token), user_id: user.id, workspace_id: ws.workspace_id, method, user_agent: String(userAgent || '').slice(0, 200), created_at: t, last_seen_at: t, expires_at: new Date(Date.now() + SESSION_TTL).toISOString() });
  await db.run('UPDATE users SET last_login_at=? WHERE id=?', [t, user.id]);
  return token;
}
// Resolves a session cookie to { user (with membership role), session }. Sliding expiry.
export async function sessionFromToken(db, token) {
  if (!token) return null;
  const s = await db.get('SELECT * FROM sessions WHERE token_hash=?', [hash(token)]);
  if (!s || Date.parse(s.expires_at) < Date.now()) return null;
  if(s.method==='local_password' && (process.env.LOCAL_SKIP_EMAIL_VERIFICATION!=='true'||process.env.NODE_ENV==='production'||process.env.VERCEL)) return null;
  const user = await db.get('SELECT u.*, m.role member_role FROM users u JOIN memberships m ON m.user_id=u.id AND m.workspace_id=? WHERE u.id=?', [s.workspace_id, s.user_id]);
  if (!user || !(await isApproved(db, user.email))) return null;
  if (Date.now() - Date.parse(s.last_seen_at) > 3600e3) await db.run('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE id=?', [now(), new Date(Date.now() + SESSION_TTL).toISOString(), s.id]);
  return { user: { ...user, role: user.member_role }, session: s };
}
export function cookie(name, value, { maxAge, secure, path = '/', sameSite = 'Lax' }) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// ---------- Service ----------
export function createAuth({ db, publicUrl }) {
  const secure = publicUrl.startsWith('https://');
  const localVerificationSkip = req => process.env.LOCAL_SKIP_EMAIL_VERIFICATION === 'true' && process.env.NODE_ENV !== 'production' && !process.env.VERCEL && ['localhost','127.0.0.1','[::1]'].includes(new URL(publicUrl).hostname) && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  const link = path => `${publicUrl}/#/${path}`;
  const sessionCookie = token => cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL / 1000, secure });
  const clearSession = cookie(SESSION_COOKIE, '', { maxAge: 0, secure });
  const signIn = async (out, user, method, req, workspaceId) => { out.setCookie(sessionCookie(await createSession(db, user, { workspaceId, method, userAgent: req.headers['user-agent'] }))); return { status: 'signed_in' }; };
  const invitation = async token => { const row = await findToken(db, 'invite', token); return row && { ...row, workspace: (await db.get('SELECT name FROM workspaces WHERE id=?', [row.workspace_id]))?.name, inviter: (await db.get('SELECT name FROM users WHERE id=?', [row.created_by]))?.name }; };

  async function sendVerification(user) {
    await db.run("UPDATE auth_tokens SET used_at=? WHERE kind='verify_email' AND user_id=? AND used_at IS NULL", [now(), user.id]);
    const token = await createToken(db, { kind: 'verify_email', ttl: DAY, user_id: user.id, email: user.email });
    await sendMail({ to: user.email, subject: 'Confirm your email for Outbound', text: `Hi ${user.name.split(' ')[0]},\n\nConfirm your email address to finish setting up your Outbound account. This link expires in 24 hours.\n\nIf you didn’t sign up, you can ignore this email.`, action: { label: 'Confirm email', url: link(`verify/${token}`) } });
  }

  return {
    config: () => ({ google: false, password: true, restricted: true }),

    async signup(out, req, body) {
      const name = String(body.name || '').trim(), email = normEmail(body.email), company = String(body.company || '').trim();
      await limit(db, 'signup:' + clientIp(req), 20, 3600e3);
      await requireApproved(db, email);
      const fields = {};
      if (!name) fields.name = 'Enter your name.';
      if (!email || !EMAIL_RE.test(email)) fields.email = 'Enter a valid email address.';
      const pwProblem = passwordProblem(body.password, email);
      if (pwProblem) fields.password = pwProblem;
      if (Object.keys(fields).length) throw invalid('Check the highlighted fields.', fields);
      const invite = body.invite_token ? await invitation(body.invite_token) : null;
      const existing = await userByEmail(db, email);
      if (existing) {
        if(localVerificationSkip(req)) {
          if(!await verifyPassword(String(body.password),existing.password_hash)) throw new AppError(401,'invalid_credentials','Account already exists. Sign in with your existing password.');
          return signIn(out,existing,'local_password',req);
        }
        // Same response as a new sign-up, so the form can't be used to discover accounts.
        await sendMail({ to: email, subject: 'You already have an Outbound account', text: `Someone (hopefully you) tried to create an Outbound account with this email address, but you already have one.\n\nSign in instead, or reset your password if you’ve forgotten it.`, action: { label: 'Sign in', url: link('signin') } });
        return { status: 'check_email' };
      }
      const password_hash = await hashPassword(body.password);
      if (invite && invite.email.toLowerCase() === email) {
        // The invite link was delivered to this address, which proves ownership.
        const user = await createUser(db, { name, email, password_hash, verified: true, invite });
        await consumeToken(db, 'invite', body.invite_token);
        return await signIn(out, user, 'password', req, invite.workspace_id);
      }
      const user = await createUser(db, { name, email, password_hash, company });
      if(localVerificationSkip(req)) return signIn(out,user,'local_password',req);
      try { await sendVerification(user); }
      catch (e) { if (e.code !== 'email_failed') throw e; throw new AppError(503, 'email_failed', `Your account was created, but ${e.message.charAt(0).toLowerCase() + e.message.slice(1)} Then sign in and choose “Send a new link”.`); }
      return { status: 'check_email' };
    },

    async login(out, req, body) {
      const email = normEmail(body.email);
      await limit(db, 'login-ip:' + clientIp(req), 50, 900e3);
      if (email) await limit(db, 'login:' + email, 10, 900e3);
      const user = email && await userByEmail(db, email);
      const ok = await verifyPassword(String(body.password ?? ''), user?.password_hash);
      if (!user || !ok || !(await isApproved(db, email))) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
      if (!user.email_verified_at && localVerificationSkip(req)) return signIn(out,user,'local_password',req);
      if (!user.email_verified_at) throw new AppError(403, 'email_unverified', 'Confirm your email address first. Check your inbox for the link, or send a new one.');
      return await signIn(out, user, 'password', req);
    },

    async resendVerification(req, body) {
      const email = normEmail(body.email);
      await limit(db, 'resend:' + (email || clientIp(req)), 5, 3600e3);
      const user = email && await userByEmail(db, email);
      if (user && !user.email_verified_at) await sendVerification(user);
      return { status: 'check_email' };
    },

    async verifyEmail(out, req, body) {
      const row = await consumeToken(db, 'verify_email', body.token, 'This confirmation link is invalid or has expired. Sign in to request a new one.');
      const user = await db.get('SELECT * FROM users WHERE id=?', [row.user_id]);
      if (!user || user.email.toLowerCase() !== String(row.email).toLowerCase()) throw new AppError(400, 'invalid_token', 'This confirmation link no longer matches your account.');
      await db.run('UPDATE users SET email_verified_at=coalesce(email_verified_at, ?) WHERE id=?', [now(), user.id]);
      return await signIn(out, user, 'email_link', req);
    },

    async forgotPassword(req, body) {
      const email = normEmail(body.email);
      await limit(db, 'forgot:' + (email || clientIp(req)), 5, 3600e3);
      const user = email && await userByEmail(db, email);
      if (user) {
        await db.run("UPDATE auth_tokens SET used_at=? WHERE kind='reset_password' AND user_id=? AND used_at IS NULL", [now(), user.id]);
        const token = await createToken(db, { kind: 'reset_password', ttl: 3600e3, user_id: user.id, email: user.email });
        await sendMail({ to: user.email, subject: 'Reset your Outbound password', text: `Hi ${user.name.split(' ')[0]},\n\nUse the link below to choose a new password. It expires in one hour and can be used once.\n\nIf you didn’t ask for this, you can ignore this email; your password won’t change.`, action: { label: 'Choose a new password', url: link(`reset/${token}`) } });
      }
      return { status: 'check_email' };
    },

    async resetPassword(out, req, body) {
      const pre = await findToken(db, 'reset_password', body.token);
      const user = pre && await db.get('SELECT * FROM users WHERE id=?', [pre.user_id]);
      const problem = passwordProblem(body.password, user?.email);
      if (problem) throw invalid(problem, { password: problem });
      await consumeToken(db, 'reset_password', body.token, 'This reset link is invalid or has expired. Request a new one.');
      const password_hash = await hashPassword(body.password);
      await db.tx(async () => {
        // Completing a reset proves control of the inbox, so it also confirms the email.
        await db.run('UPDATE users SET password_hash=?, email_verified_at=coalesce(email_verified_at, ?) WHERE id=?', [password_hash, now(), user.id]);
        await db.run('DELETE FROM sessions WHERE user_id=?', [user.id]);
      });
      await sendMail({ to: user.email, subject: 'Your Outbound password was changed', text: `Hi ${user.name.split(' ')[0]},\n\nYour password was just changed and all other sessions were signed out. If this wasn’t you, reset your password immediately.` });
      return await signIn(out, user, 'password', req);
    },

    async changePassword(ctx, out, req, body) {
      const user = await db.get('SELECT * FROM users WHERE id=?', [ctx.user.id]);
      await limit(db, 'change-pw:' + user.id, 10, 900e3);
      if (user.password_hash && !(await verifyPassword(String(body.current_password ?? ''), user.password_hash))) throw invalid('Your current password is incorrect.', { current_password: 'Incorrect.' });
      const problem = passwordProblem(body.password, user.email);
      if (problem) throw invalid(problem, { password: problem });
      const password_hash = await hashPassword(body.password);
      await db.tx(async () => {
        await db.run('UPDATE users SET password_hash=? WHERE id=?', [password_hash, user.id]);
        await db.run('DELETE FROM sessions WHERE user_id=?', [user.id]);
      });
      return await signIn(out, user, 'password', req, ctx.ws);
    },

    async logout(out, req, auth) {
      if (auth?.session) await db.run('DELETE FROM sessions WHERE id=?', [auth.session.id]);
      out.setCookie(clearSession);
      return { status: 'signed_out' };
    },
    async logoutAll(ctx, out) {
      await db.run('DELETE FROM sessions WHERE user_id=?', [ctx.user.id]);
      out.setCookie(clearSession);
      return { status: 'signed_out' };
    },

    async session(ctx, auth) {
      const workspaces = await db.all('SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.name', [ctx.user.id]);
      const u = await db.get('SELECT * FROM users WHERE id=?', [ctx.user.id]);
      return { user: { id: u.id, name: u.name, email: u.email, role: ctx.user.role, super_admin: isSuperAdmin(u.email), operator: await isOperator(db, u.email), has_password: !!u.password_hash, google_linked: !!u.google_sub, email_verified: !!u.email_verified_at }, workspaces, method: auth?.session?.method || 'token' };
    },
    async switchWorkspace(ctx, auth, body) {
      const m = await db.get('SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=?', [ctx.user.id, body.workspace_id]);
      if (!m) throw notFound('Workspace');
      if (!auth.session) throw new AppError(400, 'no_session', 'Switching workspaces needs a browser session.');
      await db.run('UPDATE sessions SET workspace_id=? WHERE id=?', [body.workspace_id, auth.session.id]);
      return { workspace_id: body.workspace_id };
    },

    // ---------- Invites and members ----------
    async invitePreview(body) {
      const inv = await invitation(body.token);
      if (!inv) throw new AppError(400, 'invalid_token', 'This invitation is invalid, already used, or expired. Ask for a new one.');
      return { email: inv.email, workspace: inv.workspace, inviter: inv.inviter, role: inv.role, account_exists: !!await userByEmail(db, inv.email) };
    },
    async acceptInvite(ctx, auth, body) {
      const inv = await invitation(body.token);
      if (!inv) throw new AppError(400, 'invalid_token', 'This invitation is invalid, already used, or expired. Ask for a new one.');
      const user = await db.get('SELECT * FROM users WHERE id=?', [ctx.user.id]);
      if (user.email.toLowerCase() !== inv.email.toLowerCase()) throw new AppError(403, 'wrong_account', `This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
      await db.tx(async () => {
        await consumeToken(db, 'invite', body.token);
        await db.run('INSERT INTO memberships(workspace_id, user_id, role, invited_by, created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING', [inv.workspace_id, user.id, inv.role, inv.created_by, now()]);
        await db.run('UPDATE users SET email_verified_at=coalesce(email_verified_at, ?) WHERE id=?', [now(), user.id]);
        if (auth.session) await db.run('UPDATE sessions SET workspace_id=? WHERE id=?', [inv.workspace_id, auth.session.id]);
        await db.audit(inv.workspace_id, null, 'member.joined', `${user.name} joined the workspace`, {}, user.id);
      });
      return { workspace_id: inv.workspace_id, workspace: inv.workspace };
    },
    async team(ctx) {
      return {
        members: (await db.all(`SELECT u.id, u.name, u.email, m.role, m.created_at joined_at, u.last_login_at, u.password_hash IS NOT NULL has_password, u.google_sub IS NOT NULL google_linked
          FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at`, [ctx.ws])).map(m => ({ ...m, has_password: !!m.has_password, google_linked: !!m.google_linked })),
        invites: await db.all("SELECT id, email, role, created_at, expires_at FROM auth_tokens WHERE kind='invite' AND workspace_id=? AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC", [ctx.ws, now()]),
      };
    },
    async invite(ctx, body) {
      requireOwner(ctx);
      const email = normEmail(body.email), role = body.role === 'owner' ? 'owner' : 'member';
      if (!email || !EMAIL_RE.test(email)) throw invalid('Enter a valid email address.', { email: 'Invalid.' });
      await limit(db, 'invite:' + ctx.ws, 50, DAY);
      if (await db.get('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND lower(u.email)=?', [ctx.ws, email])) throw conflict('already_member', `${email} is already a member.`);
      await db.run("UPDATE auth_tokens SET used_at=? WHERE kind='invite' AND workspace_id=? AND lower(email)=? AND used_at IS NULL", [now(), ctx.ws, email]);
      const token = await createToken(db, { kind: 'invite', ttl: 7 * DAY, email, workspace_id: ctx.ws, role, created_by: ctx.user.id });
      const ws = await db.get('SELECT name FROM workspaces WHERE id=?', [ctx.ws]);
      await sendMail({ to: email, subject: `${ctx.user.name} invited you to ${ws.name} on Outbound`, text: `${ctx.user.name} invited you to join the ${ws.name} workspace on Outbound as ${role === 'owner' ? 'an owner' : 'a member'}.\n\nThe invitation expires in 7 days.`, action: { label: 'Accept invitation', url: link(`invite/${token}`) } });
      await db.audit(ctx.ws, null, 'member.invited', `${email} invited as ${role}`, {}, ctx.user.id);
      return await this.team(ctx);
    },
    async revokeInvite(ctx, inviteId) {
      requireOwner(ctx);
      if (!(await db.run("UPDATE auth_tokens SET used_at=? WHERE id=? AND kind='invite' AND workspace_id=? AND used_at IS NULL", [now(), inviteId, ctx.ws])).changes) throw notFound('Invitation');
      return await this.team(ctx);
    },
    async removeMember(ctx, userId) {
      requireOwner(ctx);
      const m = await db.get('SELECT m.*, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?', [ctx.ws, userId]);
      if (!m) throw notFound('Member');
      if (m.role === 'owner' && (await db.get("SELECT count(*) n FROM memberships WHERE workspace_id=? AND role='owner'", [ctx.ws])).n < 2) throw conflict('last_owner', 'A workspace needs at least one owner.');
      await db.tx(async () => {
        await db.run('DELETE FROM memberships WHERE workspace_id=? AND user_id=?', [ctx.ws, userId]);
        await db.run('DELETE FROM sessions WHERE workspace_id=? AND user_id=?', [ctx.ws, userId]);
        await db.audit(ctx.ws, null, 'member.removed', `${m.name} removed from the workspace`, {}, ctx.user.id);
      });
      return await this.team(ctx);
    },

    // ---------- Google ----------
    async googleStart(out, query) {
      if (!googleEnabled()) throw new AppError(404, 'google_disabled', 'Google sign-in is not configured.');
      const verifier = newToken(), nonce = newToken();
      const state = await createToken(db, { kind: 'oauth_state', ttl: 600e3, data: { verifier, nonce, invite: query.invite ? String(query.invite).slice(0, 100) : null } });
      out.setCookie(cookie(OAUTH_COOKIE, state, { maxAge: 600, secure, path: '/auth/google' }));
      const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: `${publicUrl}/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      return `${GOOGLE_AUTH_URL()}?${params}`;
    },
    // Returns the URL to redirect the browser to.
    async googleCallback(out, req, query) {
      throw new AppError(404, 'google_disabled', 'Google sign-in is disabled for this pilot.');
      const fail = code => `${publicUrl}/#/signin?error=${code}`;
      out.setCookie(cookie(OAUTH_COOKIE, '', { maxAge: 0, secure, path: '/auth/google' }));
      if (query.error) return fail('google_cancelled');
      const browserState = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(OAUTH_COOKIE + '='))?.slice(OAUTH_COOKIE.length + 1);
      if (!query.state || !query.code || decodeURIComponent(browserState || '') !== query.state) return fail('google_state');
      let st;
      try { st = await consumeToken(db, 'oauth_state', query.state); } catch { return fail('google_state'); }
      let claims;
      try {
        const res = await fetch(GOOGLE_TOKEN_URL(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code: query.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: `${publicUrl}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: st.data.verifier }) });
        if (!res.ok) return fail('google_exchange');
        const { id_token } = await res.json();
        // The ID token comes straight from Google's token endpoint over TLS, so its claims are checked
        // rather than its signature (OpenID Connect Core §3.1.3.7).
        claims = JSON.parse(Buffer.from(String(id_token).split('.')[1], 'base64url').toString('utf8'));
      } catch { return fail('google_exchange'); }
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== process.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now() || claims.nonce !== st.data.nonce || !claims.sub) return fail('google_token');
      if (!claims.email || claims.email_verified !== true) return fail('google_unverified');
      const email = normEmail(claims.email), invite = st.data.invite ? await invitation(st.data.invite) : null;
      let user = await db.get('SELECT * FROM users WHERE google_sub=?', [claims.sub]) || await userByEmail(db, email);
      if (user && user.google_sub && user.google_sub !== claims.sub) return fail('google_conflict');
      if (user) {
        // Google has verified this address, so the accounts can be linked safely.
        await db.run('UPDATE users SET google_sub=?, email_verified_at=coalesce(email_verified_at, ?) WHERE id=?', [claims.sub, now(), user.id]);
      } else {
        const useInvite = invite && invite.email.toLowerCase() === email ? invite : null;
        user = await createUser(db, { name: String(claims.name || email.split('@')[0]), email, verified: true, google_sub: claims.sub, invite: useInvite });
        if (useInvite) await consumeToken(db, 'invite', st.data.invite);
      }
      let workspaceId;
      if (invite && invite.email.toLowerCase() === user.email.toLowerCase() && !await db.get('SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=?', [user.id, invite.workspace_id])) {
        await consumeToken(db, 'invite', st.data.invite);
        await db.insert('memberships', { workspace_id: invite.workspace_id, user_id: user.id, role: invite.role, invited_by: invite.created_by, created_at: now() });
        workspaceId = invite.workspace_id;
      } else if (invite) workspaceId = invite.workspace_id;
      await signIn(out, user, 'google', req, workspaceId);
      return `${publicUrl}/#/`;
    },
  };
}
function requireOwner(ctx) { if (ctx.user.role !== 'owner') throw new AppError(403, 'forbidden', 'Only workspace owners can manage the team.'); }
