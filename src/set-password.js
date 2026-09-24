import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createConfigSource } from './config.js';
import { hashPassword } from './auth.js';

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
export async function setPassword() {
  const file = createConfigSource().path();
  if (!file) throw new Error('no config file to write to');
  const pw = await ask('New password: ');
  if (pw.length < 8) throw new Error('use at least 8 characters');
  if (process.stdin.isTTY && (await ask('Repeat password: ')) !== pw) throw new Error('passwords do not match');
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  current.authMode = 'single';
  current.authPassword = hashPassword(pw);
  delete current.sessionSecret; // regenerated on next start: every old session ends
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  console.log(`[tinywebui] password set in ${file}; restart TinyWebUI to apply`);
}
