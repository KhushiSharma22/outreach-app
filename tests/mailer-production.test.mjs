import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('production without transactional SMTP fails closed without exposing verification links', () => {
  const script = `
    const { sendMail, sentMail, mailConfigured } = await import('./server/mailer.mjs');
    try {
      await sendMail({to:'person@example.com',subject:'Verify',text:'Confirm',action:{label:'Verify',url:'https://app.example/#/verify/secret-token'}});
      process.exitCode = 1;
    } catch (error) {
      if (error.code !== 'email_failed' || error.status !== 503 || sentMail().length || mailConfigured()) process.exitCode = 2;
    }
  `;
  const env = { ...process.env, NODE_ENV: 'production', VERCEL: '1', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: '' };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-token|person@example\.com/);
});

test('production with an SMTP host but no credentials fails closed', () => {
  const script = `
    const { sendMail, mailConfigured } = await import('./server/mailer.mjs');
    if (mailConfigured()) process.exitCode = 1;
    try { await sendMail({to:'person@example.com',subject:'Verify',text:'Confirm'}); process.exitCode = 2; }
    catch (error) { if (error.code !== 'email_failed') process.exitCode = 3; }
  `;
  const env = { ...process.env, NODE_ENV: 'production', VERCEL: '1', SMTP_HOST: 'smtp.example.com', SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: '' };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
