// Real-browser check of the sign-in forms (headless Chrome over the DevTools protocol).
// Catches DOM issues the stubbed UI test can't, e.g. inputs replaced by a re-render before
// their values are read. Skipped when Chrome isn't installed (set CHROME_PATH to override).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { sentMail } from '../server/mailer.mjs';
import { testDatabase } from './helpers.mjs';

process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'offline';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Opt-in (npm run test:browser): headless Chrome keeps the `node --test` runner waiting after this file ends.
const ENABLED = process.env.BROWSER_TESTS === '1' && existsSync(CHROME);
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
after(async () => { ws?.close(); chrome?.kill('SIGKILL'); chrome?.unref(); if (profile) rmSync(profile, { recursive: true, force: true }); await app?.close(); await tdb?.drop();
  // Chrome can leave keep-alive sockets that delay exit by many seconds; results are already reported.
  setTimeout(() => process.exit(), 1000).unref();
});

const js = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
async function until(expr, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(100); } return false; }
async function open(path) { await send('Page.navigate', { url: 'about:blank' }); await sleep(100); await send('Page.navigate', { url: base + path }); await until("document.querySelector('.auth-card,.heading')"); }
// Types into the real inputs, then submits the form the way a click on the button would.
const submit = fields => js(`(()=>{${Object.entries(fields).map(([k, v]) => `document.getElementById('auth-${k}').value=${JSON.stringify(v)};`).join('')}document.querySelector('.auth-card form').requestSubmit();return true})()`);
const heading = () => js("document.querySelector('.auth-card h2, h1')?.textContent || ''");
const errorText = () => js("document.querySelector('.auth-card .error')?.textContent || ''");
const link = kind => sentMail().filter(m => m.url?.includes(`/#/${kind}/`)).at(-1).url.replace(/^https?:\/\/[^/]+/, '');

test('sign-up, email confirmation, password reset, and sign-in work through the real forms', { skip: !ENABLED && 'set BROWSER_TESTS=1 (npm run test:browser); needs Chrome' }, async () => {
  await open('/#/signup');
  await submit({ name: 'Test Person', company: 'Testco', email: 'test@testco.test', password: 'my long new password' });
  assert.ok(await until("document.querySelector('.auth-card h2')?.textContent==='Check your email'"), await errorText());

  await open(link('verify'));
  assert.ok(await until("document.querySelector('h1')?.textContent.startsWith('Hello, Test')"), 'confirm link signs in');

  await js('signOut()');
  assert.ok(await until("document.querySelector('.auth-card h2')?.textContent==='Welcome back'"));
  await js("showAuth('forgot')");
  await until("document.getElementById('auth-email')");
  await submit({ email: 'test@testco.test' });
  assert.ok(await until("document.querySelector('.auth-card h2')?.textContent==='Check your email'"), await errorText());

  await open(link('reset'));
  await submit({ password: 'a different passphrase', confirm: 'a different passphrase' });
  assert.ok(await until("document.querySelector('h1')?.textContent.startsWith('Hello, Test')"), `reset failed: ${await errorText()}`);

  await js('signOut()');
  await until("document.getElementById('auth-password')");
  await submit({ email: 'test@testco.test', password: 'my long new password' });
  assert.ok(await until("(document.querySelector('.auth-card .error')?.textContent||'').includes('incorrect')"), 'old password rejected');
  await submit({ email: 'test@testco.test', password: 'a different passphrase' });
  assert.ok(await until("document.querySelector('h1')?.textContent.startsWith('Hello, Test')"), `sign-in failed: ${await errorText()} / ${await heading()}`);
});
