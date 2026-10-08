import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createConfigSource } from './config/config.js';
import { hashPassword } from './access/auth.js';
import { MIN_PASSWORD_LENGTH } from './access/policy.js';

/** Reads one line without echoing it when attached to a terminal. */
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) rl._writeToOutput = (s) => { if (s.startsWith(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); if (process.stdin.isTTY) process.stdout.write('\n'); resolve(answer); });
  });
}

/**
 * `tinywebui set-password`: stores an scrypt hash of a new password in the
 * config file and switches authMode to 'single'. Existing sessions are
 * signed with sessionSecret, which is rotated so they all end here too.
 */
export async function setPassword(opts = {}) {
  if (opts.config && Object.hasOwn(opts.config, 'authMode') && opts.config.authMode !== 'single') {
    throw new Error('authMode is set in code; change the JS config to use password login');
  }
  if (opts.config && Object.hasOwn(opts.config, 'authPassword')) {
    throw new Error('authPassword is set in code; change the JS config to update the password');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('set-password needs an interactive terminal; for headless startup set TINYWEBUI_PASSWORD');
  }
  const file = createConfigSource(opts).path();
  if (!file) throw new Error('no config file to write to');
  const pw = await ask('New password: ');
  if (pw.length < MIN_PASSWORD_LENGTH) throw new Error(`use at least ${MIN_PASSWORD_LENGTH} characters`);
  if ((await ask('Repeat password: ')) !== pw) throw new Error('passwords do not match');
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  current.authMode = 'single';
  current.authPassword = hashPassword(pw);
  delete current.sessionSecret; // regenerated on next start: every old session ends
  if (existsSync(file) && process.platform !== 'win32') chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  console.log(`[tinywebui] password set in ${file}`);
}
