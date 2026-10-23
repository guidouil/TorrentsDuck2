import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encryptedSSH, sha256, sshTarget } from './backup-common.mjs';

test('SSH aliases reject option injection and shell syntax', () => {
  assert.equal(sshTarget('operator@legacy.example.com'), 'operator@legacy.example.com');
  for (const value of ['-oProxyCommand=evil', 'a;id', 'a$(id)', '', 'a b']) assert.throws(() => sshTarget(value));
});

test('legacy export requires an explicit SSH host', () => {
  const result = spawnSync(process.execPath, ['scripts/export-legacy.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use an SSH alias or user@hostname/);
  assert.equal(result.stdout, '');
});

test('failed export never leaves an archive and successful export does not overwrite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-backup-test-'));
  const previous = process.env.PATH;
  const destination = path.join(root, 'result.age');
  try {
    await writeFile(path.join(root, 'ssh'), '#!/bin/sh\nprintf test-data\n', { mode: 0o700 });
    await writeFile(path.join(root, 'age'), '#!/bin/sh\ncat\n', { mode: 0o700 });
    process.env.PATH = `${root}:${previous}`;
    const options = { host: 'test-alias', command: 'readonly', recipient: 'age1' + 'a'.repeat(58), destination };
    await encryptedSSH(options);
    assert.equal(await readFile(destination, 'utf8'), 'test-data');
    await assert.rejects(encryptedSSH(options));
    assert.equal(await readFile(destination, 'utf8'), 'test-data');
    await rm(destination);
    await writeFile(path.join(root, 'age'), '#!/bin/sh\ncat >/dev/null\nexit 3\n', { mode: 0o700 });
    await assert.rejects(encryptedSSH(options));
    await assert.rejects(readFile(destination));
    await assert.rejects(readFile(destination + '.partial'));
  } finally {
    process.env.PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('age archive restores and rejects tampering before stdout', { skip: spawnSync('age', ['--version']).status !== 0 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-age-test-'));
  try {
    const identity = path.join(root, 'identity.txt');
    assert.equal(spawnSync('age-keygen', ['-o', identity]).status, 0);
    const recipient = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' }).stdout.trim();
    await writeFile(path.join(root, 'users.json'), '{"users":[{"username":"é test"}]}');
    await writeFile(path.join(root, 'padding.txt'), 'x'.repeat(256 * 1024));
    const tar = spawnSync('tar', ['-C', root, '-cf', '-', 'users.json', 'padding.txt']).stdout;
    const archive = path.join(root, 'fixture.tar.age');
    assert.equal(spawnSync('age', ['-r', recipient, '-o', archive], { input: tar }).status, 0);
    const command = ['scripts/restore-backup.mjs', 'users', archive, '--identity', identity];
    const restored = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(JSON.parse(restored.stdout), { users: [{ username: 'é test' }] });
    const corrupt = await readFile(archive);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(archive, corrupt);
    const rejected = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, '');
    assert.equal((await sha256(archive)).length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
