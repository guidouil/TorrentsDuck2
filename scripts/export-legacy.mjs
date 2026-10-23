#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { encryptedSSH, option, sshTarget } from './backup-common.mjs';

try {
  const args = process.argv.slice(2);
  const host = sshTarget(option(args, '--host'));
  const container = option(args, '--mongo-container', 'mongodb');
  const database = option(args, '--database', 'TorrentsDuck');
  for (const value of [container, database]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value ?? '')) throw new Error('Set --mongo-container and optionally --database using plain names');
  }
  const script = await readFile(new URL('./export-legacy-remote.sh', import.meta.url));
  const destination = option(args, '--output', `backups/legacy-${new Date().toISOString().replaceAll(':', '-')}.tar.age`);
  const elevation = args.includes('--sudo') ? 'sudo -n ' : '';
  const result = await encryptedSSH({ host, command: `${elevation}sh -s -- ${container} ${database}`, script, recipient: option(args, '--recipient'), destination });
  console.log(`Encrypted export saved: ${destination}\nSHA256 ${result.sha256}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
