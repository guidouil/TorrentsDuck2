#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { completed, option, sha256 } from './backup-common.mjs';

async function decrypt(filename, identity, member, verify) {
  const age = spawn('age', ['--decrypt', '--identity', identity, filename], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ageDone = completed(age, 'age authentication/decryption');
  if (verify) {
    await Promise.all([ageDone, pipeline(age.stdout, new Writable({ write(chunk, encoding, callback) { callback(); } }))]);
    return;
  }
  // BSD tar can stop at the selected member; drain the rest so age can authenticate EOF.
  const tar = spawn('sh', ['-c', 'tar -xOf - "$1"; tar_status=$?; cat >/dev/null; exit "$tar_status"', 'restore', member], { stdio: ['pipe', 'pipe', 'inherit'] });
  const tarDone = completed(tar, 'Archive member extraction');
  await Promise.all([ageDone, tarDone, pipeline(age.stdout, tar.stdin), pipeline(tar.stdout, process.stdout)]);
}

try {
  const args = process.argv.slice(2);
  const [action, filename] = args;
  const identity = option(args, '--identity');
  if (!['verify', 'users', 'database'].includes(action) || !filename || !identity) throw new Error('Usage: node scripts/restore-backup.mjs verify|users|database archive.tar.age --identity /path/identity.txt');
  // Authenticate the entire archive before emitting anything a restore process could commit.
  const before = await sha256(filename);
  await decrypt(filename, identity, undefined, true);
  if (before !== await sha256(filename)) throw new Error('Archive changed during verification');
  if (action === 'verify') console.log(`Archive authentication verified. SHA256 ${before}`);
  else await decrypt(filename, identity, action === 'users' ? 'users.json' : 'database.dump', false);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
