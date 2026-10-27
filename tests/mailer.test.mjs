// Sign-in emails go out over SMTP when SMTP_HOST is set (local fake SMTP server, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

let smtp;
const received = [];
let authOk = true;
before(async () => {
  smtp = createServer(sock => {
    let data = false, buf = '', msg = { rcpt: [], body: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; received.push(msg); msg = { rcpt: [], body: '' }; sock.write('250 queued\r\n'); } else msg.body += line + '\n'; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') sock.write(authOk ? '235 ok\r\n' : '535 5.7.8 Username and Password not accepted\r\n');
        else if (cmd === 'MAIL') { msg.from = line; sock.write('250 ok\r\n'); }
        else if (cmd === 'RCPT') { msg.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { NODE_ENV: 'test', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'Outbound <auth@outbound.test>' });
});
after(() => smtp.close());

test('verification email is delivered over SMTP with the link in text and HTML', async () => {
  const { sendMail } = await import('../server/mailer.mjs');
  await sendMail({ to: 'new@acme.test', subject: 'Confirm your email for Outbound', text: 'Hi Asha,\n\nConfirm your email.', action: { label: 'Confirm email', url: 'https://app.test/#/verify/abc' } });
  assert.equal(received.length, 1);
  assert.match(received[0].from, /auth@outbound\.test/);
  assert.match(received[0].rcpt[0], /new@acme\.test/);
  assert.match(received[0].body, /Subject: Confirm your email for Outbound/);
  assert.match(received[0].body.replace(/=\n/g, ''), /https:\/\/app\.test\/#\/verify\/abc/);
});

test('a rejected SMTP login gives a clear, retryable error and logs the server reply without the password', async () => {
  const { sendMail } = await import('../server/mailer.mjs');
  authOk = false;
  const logged = [], orig = console.error;
  console.error = m => logged.push(String(m));
  try {
    await assert.rejects(sendMail({ to: 'new@acme.test', subject: 'x', text: 'y' }), e => e.code === 'email_failed' && e.status === 503 && /rejected the SMTP username or password/.test(e.message));
  } finally { console.error = orig; authOk = true; }
  const line = logged.find(l => l.includes('mail_failed'));
  assert.ok(line, 'mail failure was logged');
  assert.match(line, /535/);
  assert.ok(!line.includes('"p"') && !line.includes(process.env.SMTP_PASS + '"'), 'password not logged');
});
