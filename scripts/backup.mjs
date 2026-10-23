#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { completed, encryptedSSH, option, sshTarget } from './backup-common.mjs';

try {
  const args = process.argv.slice(2);
  const host = sshTarget(option(args, '--host'));
  const directory = path.resolve(option(args, '--directory', 'backups'));
  const keep = Number(option(args, '--keep', '14'));
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a positive integer');
  const prefix = `duck-${host.replaceAll('@', '_')}-`;
  const filename = `${prefix}${new Date().toISOString().replaceAll(':', '-')}.tar.age`;
  const result = await encryptedSSH({ host, command: 'cd /opt/torrentduck && sh scripts/backup-remote.sh', recipient: option(args, '--recipient'), destination: path.join(directory, filename) });
  await writeFile(path.join(directory, 'last-backup.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  const remote = spawn('ssh', ['-T', host, 'cd /opt/torrentduck && docker compose exec -T web node --input-type=module -e \'let input="";for await(const c of process.stdin)input+=c;const r=await fetch("http://127.0.0.1:3000/api/internal/backup-status",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.INTERNAL_API_SECRET},body:input});if(!r.ok)process.exit(1);\''], { stdio: ['pipe', 'inherit', 'inherit'] });
  const registered = completed(remote, 'Backup status registration');
  remote.stdin.end(JSON.stringify(result));
  await registered;
  const archives = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith('.tar.age')).sort().reverse();
  for (const old of archives.slice(keep)) await rm(path.join(directory, old));
  console.log(`Backup saved and registered: ${path.join(directory, filename)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
