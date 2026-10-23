import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

export function sshTarget(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(value ?? '')) throw new Error('Use an SSH alias or user@hostname, without shell syntax');
  return value;
}

export function completed(child, description) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${description} failed (${signal ?? code})`)));
  });
}

export async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function encryptedSSH({ host, command, script, recipient, destination }) {
  if (!/^age1[0-9a-z]{50,}$/.test(recipient ?? '')) throw new Error('Supply an age public recipient using --recipient age1…');
  const filename = path.resolve(destination);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.partial';
  const file = await open(temporary, 'wx', 0o600);
  const remote = spawn('ssh', ['-T', sshTarget(host), command], { stdio: [script ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
  const age = spawn('age', ['--encrypt', '--recipient', recipient], { stdio: ['pipe', 'pipe', 'inherit'] });
  const tasks = [completed(remote, 'SSH export'), completed(age, 'age encryption')];
  if (script) remote.stdin.end(script);
  try {
    await Promise.all([...tasks, pipeline(remote.stdout, age.stdin), pipeline(age.stdout, file.createWriteStream())]);
    const saved = await open(temporary, 'r');
    try { await saved.sync(); } finally { await saved.close(); }
    await link(temporary, filename);
    await rm(temporary);
    return { archive: path.basename(filename), sha256: await sha256(filename), completedAt: new Date().toISOString() };
  } catch (error) {
    remote.kill();
    age.kill();
    await Promise.allSettled(tasks);
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}
