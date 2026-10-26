// Sign-in: email + password with verification, reset, sessions, invites, and Google (mocked token endpoint).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/app.mjs';
import { sentMail } from '../server/mailer.mjs';
import { resetRateLimits } from '../server/auth.mjs';
import { testDatabase } from './helpers.mjs';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'offline';
let app, base, google, googleClaims = {}, tdb;

before(async () => {
  // Mock of Google's token endpoint: returns an unsigned ID token with the claims under test.
  google = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const p = new URLSearchParams(body);
      if (p.get('code') !== 'good-code' || !p.get('code_verifier')) { res.writeHead(400); return res.end('{}'); }
      const seg = o => Buffer.from(JSON.stringify(o)).toString('base64url');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id_token: `${seg({ alg: 'RS256' })}.${seg(googleClaims)}.sig` }));
    });
  });
  await new Promise(r => google.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'client-123', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.address().port}/token` });
  tdb = await testDatabase();
  app = await createApp({ ...tdb, workers: false, publicUrl: 'http://app.test' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); google.close(); await tdb.drop(); });
beforeEach(() => resetRateLimits(app.db));

// Minimal browser: keeps cookies, sends the CSRF header.
function browser() {
  const jar = {};
  const call = async (method, path, body, { csrf = true, redirect = 'follow' } = {}) => {
    const res = await fetch(base + path, { method, redirect, headers: { ...(csrf ? { 'x-requested-with': 'outbound' } : {}), ...(body ? { 'content-type': 'application/json' } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv, ...attrs] = c.split('; '); const [k, v] = kv.split('='); if (attrs.includes('Max-Age=0')) delete jar[k]; else jar[k] = v; }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { jar, call, get: p => call('GET', p), post: (p, b = {}, o) => call('POST', p, b, o), del: p => call('DELETE', p) };
}
const lastMail = to => sentMail().filter(m => m.to === to).at(-1);
const tokenFrom = (mail, kind) => mail.url.match(new RegExp(`#/${kind}/([\\w-]+)`))[1];
async function signUpVerified(email, name = 'Asha Rao', company = 'Acme') {
  const b = browser();
  assert.equal((await b.post('/api/auth/signup', { name, email, password: 'correct horse battery', company })).data.status, 'check_email');
  assert.equal((await b.post('/api/auth/verify-email', { token: tokenFrom(lastMail(email), 'verify') })).data.status, 'signed_in');
  return b;
}

test('sign-up requires email verification, then signs in with a session cookie and a fresh workspace', async () => {
  const b = browser();
  assert.equal((await b.get('/api/session')).status, 401);
  const weak = await b.post('/api/auth/signup', { name: 'Asha', email: 'asha@acme.test', password: 'short' });
  assert.equal(weak.status, 422);
  assert.ok(weak.data.error.fields.password);
  const r = await b.post('/api/auth/signup', { name: 'Asha Rao', email: 'Asha@Acme.test', password: 'correct horse battery', company: 'Acme' });
  assert.equal(r.data.status, 'check_email');
  assert.equal((await b.post('/api/auth/login', { email: 'asha@acme.test', password: 'correct horse battery' })).data.error.code, 'email_unverified');
  const mail = lastMail('asha@acme.test');
  assert.match(mail.url, /^http:\/\/app\.test\/#\/verify\//);
  assert.equal((await b.post('/api/auth/verify-email', { token: tokenFrom(mail, 'verify') })).data.status, 'signed_in');
  assert.ok(b.jar.ob_session);
  const s = (await b.get('/api/session')).data;
  assert.equal(s.user.email, 'asha@acme.test');
  assert.equal(s.user.role, 'owner');
  assert.equal(s.workspace.name, 'Acme');
  const ctx = (await b.get('/api/account-context')).data.data;
  assert.equal(ctx.company, 'Acme');
  assert.equal(ctx.email, 'asha@acme.test');
  // Link is single-use.
  assert.equal((await browser().post('/api/auth/verify-email', { token: tokenFrom(mail, 'verify') })).status, 400);
  // Logout ends the session.
  await b.post('/api/auth/logout');
  assert.equal((await b.get('/api/session')).status, 401);
});

test('duplicate sign-up does not reveal or create accounts; bad passwords and CSRF are rejected; attempts are limited', async () => {
  await signUpVerified('dup@acme.test');
  const b = browser();
  const r = await b.post('/api/auth/signup', { name: 'Someone', email: 'dup@acme.test', password: 'another good password' });
  assert.equal(r.data.status, 'check_email');
  assert.match(lastMail('dup@acme.test').subject, /already have/);
  assert.equal((await app.db.get("SELECT count(*) n FROM users WHERE lower(email)='dup@acme.test'")).n, 1);
  assert.equal((await b.post('/api/auth/login', { email: 'dup@acme.test', password: 'wrong password here' })).status, 401);
  assert.equal((await b.post('/api/auth/login', { email: 'nobody@acme.test', password: 'wrong password here' })).data.error.message, 'Email or password is incorrect.');
  assert.equal((await b.post('/api/auth/login', { email: 'dup@acme.test', password: 'correct horse battery' }, { csrf: false })).status, 403);
  for (let i = 0; i < 9; i++) await b.post('/api/auth/login', { email: 'dup@acme.test', password: 'wrong password here' });
  assert.equal((await b.post('/api/auth/login', { email: 'dup@acme.test', password: 'correct horse battery' })).status, 429);
});

test('password reset is single-use, revokes existing sessions, and confirms the email', async () => {
  const old = await signUpVerified('reset@acme.test');
  const b = browser();
  assert.equal((await b.post('/api/auth/forgot-password', { email: 'reset@acme.test' })).data.status, 'check_email');
  assert.equal((await b.post('/api/auth/forgot-password', { email: 'ghost@acme.test' })).data.status, 'check_email');
  const token = tokenFrom(lastMail('reset@acme.test'), 'reset');
  assert.equal((await b.post('/api/auth/reset-password', { token, password: 'password123' })).status, 422);
  assert.equal((await b.post('/api/auth/reset-password', { token, password: 'a brand new passphrase' })).data.status, 'signed_in');
  assert.equal((await old.get('/api/session')).status, 401);
  assert.equal((await b.get('/api/session')).status, 200);
  assert.equal((await browser().post('/api/auth/reset-password', { token, password: 'yet another passphrase' })).status, 400);
  assert.equal((await browser().post('/api/auth/login', { email: 'reset@acme.test', password: 'a brand new passphrase' })).data.status, 'signed_in');
});

test('accounts are isolated; invites add teammates to the same workspace with member permissions', async () => {
  const owner = await signUpVerified('owner@team.test', 'Olu Owner', 'Team Co');
  const stranger = await signUpVerified('stranger@else.test', 'Sam Stranger', 'Else Inc');
  const c = (await owner.post('/api/campaigns', { name: 'Team campaign' })).data;
  assert.equal((await stranger.get(`/api/campaigns/${c.id}`)).status, 404);

  // Invite a brand-new person: signing up through the invite joins Team Co, already verified.
  await owner.post('/api/team/invites', { email: 'new@team.test' });
  const invTok = tokenFrom(lastMail('new@team.test'), 'invite');
  const preview = (await browser().post('/api/auth/invite-preview', { token: invTok })).data;
  assert.equal(preview.workspace, 'Team Co');
  assert.equal(preview.account_exists, false);
  const member = browser();
  assert.equal((await member.post('/api/auth/signup', { name: 'Nia New', email: 'new@team.test', password: 'joining the team ok', invite_token: invTok })).data.status, 'signed_in');
  const ms = (await member.get('/api/session')).data;
  assert.equal(ms.workspace.name, 'Team Co');
  assert.equal(ms.user.role, 'member');
  assert.equal((await member.get(`/api/campaigns/${c.id}`)).status, 200);
  assert.equal((await member.post('/api/team/invites', { email: 'x@team.test' })).status, 403);

  // Invite an existing account: only that account can accept, and it can switch workspaces.
  await owner.post('/api/team/invites', { email: 'stranger@else.test' });
  const tok2 = tokenFrom(lastMail('stranger@else.test'), 'invite');
  assert.equal((await member.post('/api/auth/accept-invite', { token: tok2 })).status, 403);
  assert.equal((await stranger.post('/api/auth/accept-invite', { token: tok2 })).data.workspace, 'Team Co');
  const ss = (await stranger.get('/api/session')).data;
  assert.equal(ss.workspaces.length, 2);
  assert.equal(ss.workspace.name, 'Team Co');
  const elseWs = ss.workspaces.find(w => w.name === 'Else Inc');
  await stranger.post('/api/auth/switch-workspace', { workspace_id: elseWs.id });
  assert.equal((await stranger.get('/api/session')).data.workspace.name, 'Else Inc');

  // Removing a member ends their access to that workspace.
  const team = (await owner.get('/api/team')).data;
  assert.equal(team.members.length, 3);
  await owner.del(`/api/team/members/${team.members.find(m => m.email === 'new@team.test').id}`);
  assert.equal((await member.get('/api/session')).status, 401);
  const self = team.members.find(m => m.email === 'owner@team.test');
  assert.equal((await owner.del(`/api/team/members/${self.id}`)).status, 409);
});

test('Google sign-in creates verified accounts, links by verified email, and rejects bad state or claims', async () => {
  const flow = async (claims, { tamperState = false, invite } = {}) => {
    const b = browser();
    const start = await b.call('GET', `/auth/google/start${invite ? `?invite=${invite}` : ''}`, null, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://app.test/auth/google/callback');
    googleClaims = { iss: 'https://accounts.google.com', aud: 'client-123', exp: Math.floor(Date.now() / 1000) + 300, nonce: loc.searchParams.get('nonce'), email_verified: true, ...claims };
    const state = tamperState ? 'forged' : loc.searchParams.get('state');
    const cb = await b.call('GET', `/auth/google/callback?code=good-code&state=${state}`, null, { redirect: 'manual' });
    return { b, location: cb.headers.get('location') };
  };
  const fresh = await flow({ sub: 'g-1', email: 'gina@gmail.test', name: 'Gina G' });
  assert.equal(fresh.location, 'http://app.test/#/');
  const s = (await fresh.b.get('/api/session')).data;
  assert.equal(s.user.google_linked, true);
  assert.equal(s.user.has_password, false);
  assert.equal(s.workspace.name, 'Gina’s workspace');

  // An unverified password account with the same email is linked and confirmed by Google.
  await browser().post('/api/auth/signup', { name: 'Pat', email: 'pat@corp.test', password: 'pat password long' });
  const linked = await flow({ sub: 'g-2', email: 'pat@corp.test', name: 'Pat' });
  assert.equal((await linked.b.get('/api/session')).data.user.email_verified, true);
  assert.equal((await app.db.get("SELECT count(*) n FROM users WHERE lower(email)='pat@corp.test'")).n, 1);

  assert.match((await flow({ sub: 'g-3', email: 'x@gmail.test' }, { tamperState: true })).location, /error=google_state/);
  assert.match((await flow({ sub: 'g-4', email: 'y@gmail.test', aud: 'someone-else' })).location, /error=google_token/);
  assert.match((await flow({ sub: 'g-5', email: 'z@gmail.test', email_verified: false })).location, /error=google_unverified/);
  assert.match((await flow({ sub: 'g-6', email: 'z@gmail.test', nonce: 'replayed' })).location, /error=google_token/);
});
