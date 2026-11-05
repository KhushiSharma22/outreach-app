// Super-admin portal: only the configured super admins can approve people, toggle operators, and
// remove access; changes apply immediately without redeploying.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { sentMail } from '../server/mailer.mjs';
import { resetRateLimits } from '../server/auth.mjs';
import { isSuperAdmin } from '../server/admin.mjs';
import { testDatabase } from './helpers.mjs';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'offline';
delete process.env.SUPER_ADMIN_EMAILS; // use the built-in list
process.env.ALLOWED_EMAILS = 'member@pilot.test';
process.env.OPERATOR_EMAILS = '';
let app, base, tdb;

before(async () => {
  tdb = await testDatabase();
  app = await createApp({ ...tdb, workers: false, publicUrl: 'http://app.test' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); await tdb.drop(); });
beforeEach(() => resetRateLimits(app.db));

function browser() {
  const jar = {};
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'x-requested-with': 'outbound', ...(body ? { 'content-type': 'application/json' } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv, ...attrs] = c.split('; '); const [k, v] = kv.split('='); if (attrs.includes('Max-Age=0')) delete jar[k]; else jar[k] = v; }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p) };
}
const verifyLink = email => sentMail().filter(m => m.to === email && m.url?.includes('#/verify/')).at(-1).url.match(/#\/verify\/([\w-]+)/)[1];
async function signUp(email, name = 'Person') {
  const b = browser();
  const r = await b.post('/api/auth/signup', { name, email, password: 'a long enough password' });
  if (r.status !== 200) return { b, status: r.status, data: r.data };
  assert.equal((await b.post('/api/auth/verify-email', { token: verifyLink(email) })).data.status, 'signed_in');
  return { b, status: 200 };
}
const csv = 'first_name,company,email\nAda,Acme,ada@acme.example\n';
const enc = encodeURIComponent;

test('only the three configured super admins get the portal', () => {
  for (const e of ['khushi.sharma.2201@gmail.com', 'paroksh05@gmail.com', 'Siddharth.M2703@gmail.com']) assert.equal(isSuperAdmin(e), true);
  for (const e of ['sidmehta927@gmail.com', 'member@pilot.test', '']) assert.equal(isSuperAdmin(e), false);
  process.env.SUPER_ADMIN_EMAILS = 'ops@pilot.test';
  try { assert.equal(isSuperAdmin('khushi.sharma.2201@gmail.com'), false); assert.equal(isSuperAdmin('ops@pilot.test'), true); }
  finally { delete process.env.SUPER_ADMIN_EMAILS; }
});

test('super admins approve people, toggle operators, and remove access; others cannot', async () => {
  // A super admin can sign up without being on ALLOWED_EMAILS and is flagged in the session.
  const { b: boss } = await signUp('khushi.sharma.2201@gmail.com', 'Khushi');
  const me = (await boss.get('/api/session')).data.user;
  assert.equal(me.super_admin, true);
  assert.equal(me.operator, true);

  // An approved non-admin gets no portal.
  const { b: member } = await signUp('member@pilot.test', 'Member');
  assert.equal((await member.get('/api/session')).data.user.super_admin, false);
  assert.equal((await member.get('/api/admin/people')).status, 403);
  assert.equal((await member.post('/api/admin/people', { emails: 'x@pilot.test' })).status, 403);

  // Someone not yet approved is refused; once a super admin approves them they can sign up.
  assert.equal((await signUp('new@pilot.test')).status, 403);
  const added = await boss.post('/api/admin/people', { emails: 'New@pilot.test, new2@pilot.test\nnew2@pilot.test', operator: true, notify: true, note: 'Design partner' });
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.results.map(r => [r.email, r.status, r.notified]), [['new@pilot.test', 'added', true], ['new2@pilot.test', 'added', true]]);
  assert.match(sentMail().filter(m => m.to === 'new@pilot.test').at(-1).url, /^http:\/\/app\.test\/#\/signup$/);
  assert.equal((await boss.post('/api/admin/people', { emails: 'not-an-email' })).status, 422);
  const { b: fresh, status } = await signUp('new@pilot.test', 'New');
  assert.equal(status, 200);
  assert.equal((await fresh.post('/api/imports', { filename: 'a.csv', csv })).status, 201); // operator

  // Operator off: imports are refused immediately.
  assert.equal((await boss.patch(`/api/admin/people/${enc('new@pilot.test')}`, { operator: false })).status, 200);
  assert.equal((await fresh.post('/api/imports', { filename: 'a.csv', csv })).data.error.code, 'operator_only');

  // Removing access signs them out at once and blocks signing back in.
  assert.equal((await boss.del(`/api/admin/people/${enc('new@pilot.test')}`)).status, 200);
  assert.equal((await fresh.get('/api/session')).status, 401);
  assert.equal((await browser().post('/api/auth/login', { email: 'new@pilot.test', password: 'a long enough password' })).status, 401);

  // Super admins and deployment-managed entries can't be removed from the portal.
  assert.equal((await boss.del(`/api/admin/people/${enc('paroksh05@gmail.com')}`)).data.error.code, 'super_admin');
  assert.equal((await boss.del(`/api/admin/people/${enc('member@pilot.test')}`)).data.error.code, 'env_managed');
  assert.equal((await member.del(`/api/admin/people/${enc('new2@pilot.test')}`)).status, 403);

  // The listing reflects every source, and the actions are logged.
  const people = (await boss.get('/api/admin/people')).data.people;
  const by = e => people.find(p => p.email === e);
  assert.equal(by('siddharth.m2703@gmail.com').super_admin, true);
  assert.equal(by('member@pilot.test').env_allowed, true);
  assert.equal(by('new2@pilot.test').added.note, 'Design partner');
  assert.equal(by('new@pilot.test').approved, false);   // removed, but the account is still listed
  assert.equal(by('new@pilot.test').account.name, 'New');
  const logTypes = (await boss.get('/api/admin/log')).data.items.map(i => i.type);
  for (const t of ['access.granted', 'access.operator', 'access.revoked']) assert.ok(logTypes.includes(t), t);
});
