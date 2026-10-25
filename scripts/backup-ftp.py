#!/usr/bin/env python3
"""Optional encrypted PostgreSQL/configuration/share backup to FTP."""
import datetime
import fcntl
import ftplib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import resource
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]


class BackupError(Exception):
    pass


def configuration():
    # Compose handles .env quoting/interpolation without executing it as shell code.
    result = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=ROOT, capture_output=True)
    if result.returncode:
        raise BackupError("Cannot read the Compose backup configuration")
    compose = json.loads(result.stdout)
    settings = compose["x-backup-ftp"]
    if settings["enabled"] == "false":
        return None
    if settings["enabled"] != "true" or settings["tls"] not in ("true", "false"):
        raise BackupError("BACKUP_FTP_ENABLED and BACKUP_FTP_TLS must be true or false")
    if not all(settings[key] for key in ("host", "user", "password", "recipient")):
        raise BackupError("Set the FTP host, user, password and public age recipient before enabling backups")
    if any(c in settings[key] for key in ("host", "user", "password") for c in "\r\n\0"):
        raise BackupError("FTP settings must not contain control characters")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", settings["directory"]):
        raise BackupError("BACKUP_FTP_DIRECTORY must be a single dedicated directory name")
    if not re.fullmatch(r"age1[0-9a-z]{50,}", settings["recipient"]):
        raise BackupError("BACKUP_AGE_RECIPIENT must be a public age recipient")
    for key in ("port", "quota_bytes", "keep"):
        try:
            settings[key] = int(settings[key])
        except (ValueError, TypeError):
            raise BackupError("Backup port, quota and retention must be positive integers") from None
        if settings[key] < 1:
            raise BackupError("Backup port, quota and retention must be positive integers")
    if settings["port"] > 65535 or settings["keep"] > 100:
        raise BackupError("Backup port or retention is out of range")
    share = next(mount["source"] for mount in compose["services"]["web"]["volumes"] if mount["target"] == "/data/share")
    return settings, Path(share), compose["name"]


def inventory(root_fd):
    files = []
    skipped = 0
    def walk_error(error):
        raise BackupError("Cannot read the complete share inventory") from None
    for directory, directories, names, directory_fd in os.fwalk(".", dir_fd=root_fd, follow_symlinks=False, onerror=walk_error):
        for name in directories + names:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                files.append((info.st_size, str(Path(directory) / name), info))
            elif not stat.S_ISDIR(info.st_mode):
                skipped += 1
    return sorted(files, key=lambda item: (item[0], item[1])), skipped


def open_share(root_fd, relative):
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(part in (".", "..") for part in parts):
        raise BackupError("Invalid share archive path")
    parent = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)


def file_header(relative, size):
    header = tarfile.TarInfo("share/" + relative)
    header.size = size
    header.mode = 0o600
    return header


def select_files(files, budget):
    selected = []
    for size, relative, info in sorted(files, key=lambda item: (item[0], item[1])):
        header_size = len(file_header(relative, size).tobuf(format=tarfile.PAX_FORMAT))
        manifest_size = len(json.dumps({"path": relative, "size": size}).encode()) + 2
        cost = header_size + (size + 511) // 512 * 512 + manifest_size
        if cost <= budget:
            selected.append((size, relative, info))
            budget -= cost
    return selected


def create_archive(destination, recipient, share, limit):
    # Leave room for age framing, tar padding and the fixed manifest fields.
    plain_limit = int(limit * 0.99) - 65536
    with open(destination, "xb") as encrypted:
        age = subprocess.Popen(["age", "--encrypt", "--recipient", recipient], stdin=subprocess.PIPE, stdout=encrypted,
                               stderr=subprocess.DEVNULL, preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit)))
        export = None
        try:
            with tarfile.open(fileobj=age.stdin, mode="w|") as archive:
                export = subprocess.Popen(["sh", "scripts/backup-remote.sh"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
                with tarfile.open(fileobj=export.stdout, mode="r|") as source:
                    for member in source:
                        archive.addfile(member, source.extractfile(member) if member.isfile() else None)
                        if archive.offset > plain_limit:
                            raise BackupError("Database and configuration exceed the backup budget")
                export.stdout.close()
                if export.wait() != 0:
                    raise BackupError("PostgreSQL/configuration export failed")
                root_fd = os.open(share, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    files, unsafe = inventory(root_fd)
                    selected = select_files(files, plain_limit - archive.offset)
                    for size, relative, before in selected:
                        with os.fdopen(open_share(root_fd, relative), "rb") as content:
                            current = os.fstat(content.fileno())
                            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (before.st_dev, before.st_ino, size, before.st_mtime_ns):
                                raise BackupError("Share changed during backup; retry when files are stable")
                            archive.addfile(file_header(relative, size), content)
                            if os.fstat(content.fileno()).st_mtime_ns != current.st_mtime_ns:
                                raise BackupError("Share changed during backup; retry when files are stable")
                finally:
                    os.close(root_fd)
                total_bytes = sum(size for size, _, _ in files)
                included_bytes = sum(size for size, _, _ in selected)
                manifest = {"version": 1, "selection": "smallest-first", "files": [{"path": relative, "size": size} for size, relative, _ in selected],
                            "included": len(selected), "includedBytes": included_bytes, "totalBytes": total_bytes,
                            "excludedForSpace": len(files) - len(selected), "excludedBytes": total_bytes - included_bytes, "excludedUnsafe": unsafe}
                content = json.dumps(manifest).encode()
                if archive.offset + len(content) + 10240 > plain_limit + 65536:
                    raise BackupError("Backup manifest exceeds the backup budget")
                header = tarfile.TarInfo("backup-manifest.json")
                header.size = len(content)
                header.mode = 0o600
                archive.addfile(header, io.BytesIO(content))
            age.stdin.close()
            if age.wait() != 0:
                raise BackupError("age encryption failed or the backup exceeded its size limit")
            encrypted.flush()
            os.fsync(encrypted.fileno())
            return manifest
        finally:
            if export and export.poll() is None:
                try:
                    os.killpg(export.pid, 15)
                except ProcessLookupError:
                    pass
                export.wait()
            if age.poll() is None:
                age.kill()
                age.wait()


def connect(settings):
    ftp = ftplib.FTP_TLS(context=ssl.create_default_context(), timeout=60) if settings["tls"] == "true" else ftplib.FTP(timeout=60)
    try:
        ftp.connect(settings["host"], settings["port"])
        ftp.login(settings["user"], settings["password"])
        if settings["tls"] == "true":
            ftp.prot_p()
        # Dedibackup data connections use the address supplied by PASV.
        ftp.trust_server_pasv_ipv4_address = True
        try:
            ftp.cwd(settings["directory"])
        except ftplib.error_perm:
            ftp.mkd(settings["directory"])
            ftp.cwd(settings["directory"])
        return ftp
    except Exception:
        ftp.close()
        raise


def remote_files(ftp):
    try:
        names = ftp.nlst()
    except ftplib.error_perm as error:
        if not str(error).startswith("550"):
            raise
        listing = []
        ftp.retrlines("LIST", listing.append)
        if any(line.strip() for line in listing):
            raise BackupError("Cannot safely list the FTP backup directory")
        names = []
    ftp.voidcmd("TYPE I")
    files = {}
    for name in names:
        if name in (".", ".."):
            continue
        if "/" in name or any(c in name for c in "\r\n\0"):
            raise BackupError("FTP backup directory must contain only plain files")
        size = ftp.size(name)
        if size is None or size < 0:
            raise BackupError("Cannot determine FTP storage usage")
        files[name] = size
    return files


def register_backup(metadata):
    script = 'let input="";for await(const c of process.stdin)input+=c;const r=await fetch("http://127.0.0.1:3000/api/internal/backup-status",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.INTERNAL_API_SECRET},body:input});if(!r.ok)process.exit(1);'
    result = subprocess.run(["docker", "compose", "exec", "-T", "web", "node", "--input-type=module", "-e", script], cwd=ROOT,
                            input=json.dumps(metadata).encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise BackupError("FTP archive saved, but status registration failed; no previous backup was removed")


def backup(settings, share, project):
    staging = share.parent / "backup-ftp"
    staging.mkdir(mode=0o700, exist_ok=True)
    if staging.is_symlink():
        raise BackupError("Backup staging directory must not be a symbolic link")
    os.chmod(staging, 0o700)
    with os.fdopen(os.open(staging / ".lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("An FTP backup is already running") from None
        ftp = connect(settings)
        partial = None
        try:
            existing = remote_files(ftp)
            ftp.close()
            ftp = None
            disk = shutil.disk_usage(staging)
            limit = min(settings["quota_bytes"] // (settings["keep"] + 1), settings["quota_bytes"] - sum(existing.values()), disk.free - (disk.total + 9) // 10)
            if limit <= 65536:
                raise BackupError("Not enough backup space while preserving the previous copy and the 10% disk reserve")
            prefix = "duck-ftp-" + project + "-"
            filename = prefix + datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S") + "-" + uuid.uuid4().hex + ".tar.age"
            with tempfile.TemporaryDirectory(prefix=".backup-", dir=staging) as temporary:
                local = Path(temporary) / "archive.tar.age"
                manifest = create_archive(local, settings["recipient"], share, limit)
                size = local.stat().st_size
                if size > limit:
                    raise BackupError("Encrypted archive exceeds the backup budget")
                with local.open("rb") as content:
                    digest = hashlib.file_digest(content, "sha256").hexdigest()
                # Encryption can take hours; start a fresh FTP session before uploading.
                ftp = connect(settings)
                existing = remote_files(ftp)
                if size + sum(existing.values()) > settings["quota_bytes"]:
                    raise BackupError("FTP space changed during backup; no previous backup was removed")
                partial = filename + ".partial"
                if filename in existing or partial in existing:
                    partial = None
                    raise BackupError("Refusing to overwrite an existing FTP backup")
                with local.open("rb") as content:
                    ftp.storbinary("STOR " + partial, content)
                if ftp.size(partial) != size:
                    raise BackupError("Incomplete FTP upload; no previous backup was removed")
                ftp.rename(partial, filename)
                partial = None
                uploaded = hashlib.sha256()
                ftp.retrbinary("RETR " + filename, uploaded.update)
                if uploaded.hexdigest() != digest:
                    ftp.delete(filename)
                    raise BackupError("FTP integrity verification failed; no previous backup was removed")
                register_backup({"archive": filename, "sha256": digest, "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
                pattern = re.compile(re.escape(prefix) + r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{32}\.tar\.age")
                previous = sorted((name for name in existing if pattern.fullmatch(name)), reverse=True)
                try:
                    for old in previous[settings["keep"] - 1:]:
                        ftp.delete(old)
                except ftplib.all_errors:
                    raise BackupError("FTP backup saved and registered, but pruning old copies failed") from None
                print(f"Encrypted FTP backup verified: {filename}; share files included={manifest['included']}, excluded for space={manifest['excludedForSpace']}, unsafe={manifest['excludedUnsafe']}")
        finally:
            if partial:
                try:
                    ftp.delete(partial)
                except ftplib.all_errors:
                    pass
            if ftp:
                ftp.close()


def main():
    os.umask(0o077)
    try:
        configured = configuration()
        if configured is None:
            print("FTP backup disabled")
        else:
            backup(*configured)
        return 0
    except BackupError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        # FTP/server and subprocess errors can contain credentials; never log their text.
        print("FTP backup failed; no success was recorded. Check configuration, storage and connectivity.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
