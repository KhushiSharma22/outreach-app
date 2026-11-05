// Real-browser check of the sign-in forms (headless Chrome over the DevTools protocol).
// Catches DOM issues the stubbed UI test can't, e.g. inputs replaced by a re-render before
// their values are read. Skipped when Chrome isn't installed (set CHROME_PATH to point at it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { sentMail } from '../server/mailer.mjs';
import { testDatabase } from './helpers.mjs';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'offline';
process.env.ALLOWED_EMAILS = 'test@testco.test'; // the pilot admits approved addresses only
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Runs whenever Chrome is installed; set BROWSER_TESTS=0 to skip it.
const ENABLED = process.env.BROWSER_TESTS !== '0' && existsSync(CHROME);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let app, tdb, base, chrome, ws, profile, send;

before(async () => {
  if (!ENABLED) return;
  tdb = await testDatabase();
  app = await createApp({ ...tdb, workers: false, publicUrl: 'http://127.0.0.1:0' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  profile = mkdtempSync(join(tmpdir(), 'outbound-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 75 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { /* starting */ } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let n = 0; const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  send = (method, params = {}) => new Promise(r => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
});
after(async () => {
  ws?.close();
  if (chrome) { const exited = new Promise(r => chrome.once('exit', r)); chrome.kill('SIGKILL'); await Promise.race([exited, sleep(3000)]); chrome.unref(); }
  await app?.close(); await tdb?.drop();
  // Chrome's helper processes can keep writing to the profile briefly, so a synchronous delete can spin
  // forever; delete it in the background with a time limit instead.
  if (profile) await Promise.race([rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}), sleep(3000)]);
});

const js = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
async function until(expr, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(100); } return false; }
async function open(path) { await send('Page.navigate', { url: 'about:blank' }); await sleep(100); await send('Page.navigate', { url: base + path }); await until("document.querySelector('.auth-card,.heading')"); }
// Types into the real inputs, then submits the form the way a click on the button would.
const submit = fields => js(`(()=>{${Object.entries(fields).map(([k, v]) => `document.getElementById('auth-${k}').value=${JSON.stringify(v)};`).join('')}document.querySelector('.auth-card form').requestSubmit();return true})()`);
const heading = () => js("document.querySelector('.auth-card h2, h1')?.textContent || ''");
const errorText = () => js("document.querySelector('.auth-card .error')?.textContent || ''");
// Signed in = the workspace shell is showing. New pilot users land on onboarding (company context) first.
const link = kind => sentMail().filter(m => m.url?.includes(`/#/${kind}/`)).at(-1).url.replace(/^https?:\/\/[^/]+/, '');

test('sign-up, email confirmation, password reset, and sign-in work through the real forms', { skip: !ENABLED && 'needs Chrome (or BROWSER_TESTS=0 was set)' }, async () => {
  await open('/#/signup');
  await submit({ name: 'Test Person', company: 'Testco', email: 'test@testco.test', password: 'my long new password' });
  assert.ok(await until("document.querySelector('.auth-card h2')?.textContent==='Check your email'"), await errorText());

  await open(link('verify'));
  assert.ok(await until("document.querySelector('.sidebar') && !document.querySelector('.auth-card')"), 'confirm link signs in');
  assert.equal(await js("document.querySelector('h1')?.textContent"), '1. Company context'); // pilot onboarding step 1

  await js('signOut()');
  assert.ok(await until("document.querySelector('.auth-card h2')?.textContent==='Welcome back'"));
  await js("showAuth('forgot')");
  await until("document.getElementById('auth-email')");
  await submit({ email: 'test@testco.test' });
  assert.ok(await until("document.querySelector('.auth-card h2')?.textContent==='Check your email'"), await errorText());

  await open(link('reset'));
  await submit({ password: 'a different passphrase', confirm: 'a different passphrase' });
  assert.ok(await until("document.querySelector('.sidebar') && !document.querySelector('.auth-card')"), `reset failed: ${await errorText()}`);

  await js('signOut()');
  await until("document.getElementById('auth-password')");
  await submit({ email: 'test@testco.test', password: 'my long new password' });
  assert.ok(await until("(document.querySelector('.auth-card .error')?.textContent||'').includes('incorrect')"), 'old password rejected');
  await submit({ email: 'test@testco.test', password: 'a different passphrase' });
  assert.ok(await until("document.querySelector('.sidebar') && !document.querySelector('.auth-card')"), `sign-in failed: ${await errorText()} / ${await heading()}`);
});
