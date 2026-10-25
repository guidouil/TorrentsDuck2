"""Offline checks for FTP backup selection, publication and failure handling."""
import contextlib
import ftplib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("backup_ftp", Path(__file__).with_name("backup-ftp.py"))
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


def settings(**overrides):
    return {
        "enabled": "true", "tls": "true", "host": "ftp.example.com", "port": "21",
        "user": "fixture", "password": "fixture-password", "directory": "torrentduck",
        "recipient": "age1" + "a" * 58, "quota_bytes": "1000000", "keep": "1", **overrides,
    }


class FakeFTP:
    def __init__(self, files=None, sizes=None, failure=None):
        self.files = dict(files or {})
        self.sizes = dict(sizes or {})
        self.failure = failure
        self.events = []

    def nlst(self):
        return list(self.files)

    def retrlines(self, command, callback):
        self.events.append(("list", command))
        for name in self.files:
            callback(name)

    def voidcmd(self, command):
        self.events.append(("command", command))

    def size(self, name):
        size = self.sizes.get(name, len(self.files[name]))
        return size + 1 if self.failure == "size" and name.endswith(".partial") else size

    def storbinary(self, command, content):
        name = command.removeprefix("STOR ")
        self.events.append(("upload", name))
        self.files[name] = content.read()
        if self.failure == "upload":
            raise ftplib.error_temp("421 fixture upload failure")

    def rename(self, source, destination):
        self.events.append(("rename", source, destination))
        self.files[destination] = self.files.pop(source)

    def retrbinary(self, command, callback):
        name = command.removeprefix("RETR ")
        self.events.append(("retrieve", name))
        if self.failure == "retrieve":
            raise ftplib.error_temp("421 fixture retrieval failure")
        callback(b"corrupt" if self.failure == "integrity" else self.files[name])

    def delete(self, name):
        self.events.append(("delete", name))
        if self.failure == "prune":
            raise ftplib.error_perm("550 fixture-password: cannot delete")
        self.files.pop(name)

    def close(self):
        self.events.append(("close",))


class FTPBackupTests(unittest.TestCase):
    def compose(self, configuration):
        return SimpleNamespace(returncode=0, stdout=json.dumps({
            "name": "torrentduck", "x-backup-ftp": configuration,
            "services": {"web": {"volumes": [{"source": "/fixture/share", "target": "/data/share"}]}},
        }).encode())

    def test_disabled_configuration_never_starts_backup(self):
        with patch.object(backup.subprocess, "run", return_value=self.compose({"enabled": "false"})) as compose, \
                patch.object(backup, "backup") as perform, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(backup.main(), 0)
        perform.assert_not_called()
        self.assertEqual(compose.call_count, 1)
        self.assertEqual(compose.call_args.args[0], ["docker", "compose", "config", "--format", "json"])

    def test_configuration_validates_control_characters_paths_and_numbers(self):
        with patch.object(backup.subprocess, "run", return_value=self.compose(settings())):
            configured, share, project = backup.configuration()
        self.assertEqual((configured["port"], configured["quota_bytes"], configured["keep"]), (21, 1000000, 1))
        self.assertEqual((share, project), (Path("/fixture/share"), "torrentduck"))
        for invalid in [
            {"host": "fixture\r\nDELE other"}, {"password": "fixture\0password"},
            {"directory": "../other"}, {"directory": "/absolute"}, {"recipient": "private-key"},
            {"port": "65536"}, {"quota_bytes": "0"}, {"keep": "0"}, {"enabled": "yes"},
        ]:
            with self.subTest(invalid=invalid), \
                    patch.object(backup.subprocess, "run", return_value=self.compose(settings(**invalid))):
                with self.assertRaises(backup.BackupError):
                    backup.configuration()

    def test_inventory_excludes_links_and_special_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "nested").mkdir()
            (root / "large").write_bytes(b"large")
            (root / "z-small").write_bytes(b"x")
            (root / "nested" / "a-small").write_bytes(b"x")
            (root / "hard").write_bytes(b"hard link")
            os.link(root / "hard", root / "hard-copy")
            (root / "file-link").symlink_to(root / "large")
            (root / "directory-link").symlink_to(root / "nested", target_is_directory=True)
            os.mkfifo(root / "pipe")
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                files, skipped = backup.inventory(root_fd)
            finally:
                os.close(root_fd)
        self.assertEqual([(size, name) for size, name, _ in files], [(1, "nested/a-small"), (1, "z-small"), (5, "large")])
        self.assertEqual(skipped, 5)

    def test_open_share_rejects_escape_and_swapped_parent_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "share"
            outside = Path(temporary) / "outside"
            root.mkdir()
            outside.mkdir()
            (outside / "file").write_bytes(b"outside")
            (root / "nested").mkdir()
            (root / "nested" / "file").write_bytes(b"inside")
            (root / "link").symlink_to(outside / "file")
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                for relative in ["", "../outside/file", "nested/../file", str(outside / "file")]:
                    with self.subTest(relative=relative), self.assertRaises(backup.BackupError):
                        backup.open_share(root_fd, relative)
                with os.fdopen(backup.open_share(root_fd, "nested/file"), "rb") as content:
                    self.assertEqual(content.read(), b"inside")
                backup.inventory(root_fd)
                (root / "nested").rename(root / "previous")
                (root / "nested").symlink_to(outside, target_is_directory=True)
                for relative in ["link", "nested/file"]:
                    with self.subTest(relative=relative), self.assertRaises(OSError):
                        backup.open_share(root_fd, relative)
            finally:
                os.close(root_fd)

    def test_selection_prioritizes_small_files_with_stable_ties_and_tar_cost(self):
        files = [(5000, "large", None), (1, "z-small", None), (1, "a-small", None)]
        def cost(size, relative):
            return len(backup.file_header(relative, size).tobuf(format=tarfile.PAX_FORMAT)) + \
                (size + 511) // 512 * 512 + len(json.dumps({"path": relative, "size": size}).encode()) + 2
        budget = cost(1, "a-small") + cost(1, "z-small")
        self.assertEqual([name for _, name, _ in backup.select_files(files, budget)], ["a-small", "z-small"])
        self.assertEqual(backup.select_files(files, cost(1, "a-small") - 1), [])
        self.assertEqual(backup.select_files(files, 0), [])

    def test_remote_usage_counts_foreign_and_partial_files_and_rejects_paths(self):
        ftp = FakeFTP({"foreign": b"123", "old.tar.age.partial": b"12345"})
        self.assertEqual(backup.remote_files(ftp), {"foreign": 3, "old.tar.age.partial": 5})
        for name in ["../escape", "nested/file", "bad\r\nname"]:
            with self.subTest(name=name), self.assertRaises(backup.BackupError):
                backup.remote_files(FakeFTP({name: b"fixture"}))

    def test_ambiguous_listing_failure_requires_a_verified_empty_list(self):
        ftp = FakeFTP()
        with patch.object(ftp, "nlst", side_effect=ftplib.error_perm("550 fixture")):
            self.assertEqual(backup.remote_files(ftp), {})
            self.assertIn(("list", "LIST"), ftp.events)
            ftp.files["existing"] = b"fixture"
            with self.assertRaises(backup.BackupError):
                backup.remote_files(ftp)
            with patch.object(ftp, "retrlines", side_effect=ftplib.error_perm("550 listing denied")), \
                    self.assertRaises(ftplib.error_perm):
                backup.remote_files(ftp)

    def run_backup(self, ftp, *, keep=1, quota=1000000, status_failure=False, disk_free=9 * 10**8):
        generated_limits = []
        def create(destination, recipient, share, limit):
            self.assertEqual(ftp.events[-1], ("close",))
            ftp.events.append(("create",))
            generated_limits.append(limit)
            destination.write_bytes(b"encrypted fixture")
            return {"included": 1, "excludedForSpace": 2, "excludedUnsafe": 3}
        def register(metadata):
            ftp.events.append(("register", metadata["archive"]))
            if status_failure:
                raise backup.BackupError("fixture registration failure")
        with tempfile.TemporaryDirectory() as temporary:
            share = Path(temporary) / "share"
            share.mkdir()
            with patch.object(backup, "connect", return_value=ftp) as connect, \
                    patch.object(backup, "create_archive", side_effect=create), \
                    patch.object(backup, "register_backup", side_effect=register), \
                    patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(total=10**9, free=disk_free)), \
                    contextlib.redirect_stdout(io.StringIO()):
                try:
                    backup.backup(settings(keep=keep, quota_bytes=quota), share, "torrentduck")
                finally:
                    self.assertFalse(list((share.parent / "backup-ftp").glob(".backup-*")))
                self.assertEqual(connect.call_count, 2)
        return generated_limits

    def test_success_verifies_and_registers_before_pruning_only_owned_archives(self):
        old = [f"duck-ftp-torrentduck-202{year}-01-01T00-00-00-{'a' * 32}.tar.age" for year in range(3)]
        foreign = "duck-ftp-another-2020-01-01T00-00-00-" + "a" * 32 + ".tar.age"
        files = {name: b"old" for name in old + [foreign, "foreign", "duck-ftp-torrentduck-manual.tar.age", "orphan.partial"]}
        ftp = FakeFTP(files)
        self.assertEqual(self.run_backup(ftp, keep=2), [1000000 // 3])
        operations = [event[0] for event in ftp.events]
        self.assertLess(operations.index("close"), operations.index("create"))
        self.assertLess(operations.index("create"), operations.index("upload"))
        self.assertLess(operations.index("rename"), operations.index("retrieve"))
        self.assertLess(operations.index("retrieve"), operations.index("register"))
        self.assertLess(operations.index("register"), operations.index("delete"))
        self.assertEqual({event[1] for event in ftp.events if event[0] == "delete"}, set(old[:2]))
        self.assertTrue(set(files) - set(old[:2]) <= ftp.files.keys())
        self.assertEqual(operations[-1], "close")

    def test_remaining_quota_includes_foreign_files_and_partials(self):
        ftp = FakeFTP({"foreign": b"x", "orphan.partial": b"x"}, sizes={"foreign": 550000, "orphan.partial": 10000})
        self.assertEqual(self.run_backup(ftp), [440000])
        self.assertEqual({event[1] for event in ftp.events if event[0] == "delete"}, set())

    def test_full_quota_never_uploads_or_deletes_previous_files(self):
        ftp = FakeFTP({"foreign": b"x"}, sizes={"foreign": 1000000})
        with self.assertRaises(backup.BackupError):
            self.run_backup(ftp)
        self.assertFalse(any(event[0] in ("upload", "rename", "register", "delete") for event in ftp.events))

    def test_quota_is_checked_again_after_reconnecting(self):
        ftp = FakeFTP({"old": b"old"})
        listings = 0
        def listing():
            nonlocal listings
            listings += 1
            if listings == 2:
                ftp.files["concurrent"] = b"x"
                ftp.sizes["concurrent"] = 999990
            return list(ftp.files)
        with patch.object(ftp, "nlst", side_effect=listing), self.assertRaises(backup.BackupError):
            self.run_backup(ftp)
        self.assertEqual(listings, 2)
        self.assertIn(("create",), ftp.events)
        self.assertFalse(any(event[0] in ("upload", "rename", "register", "delete") for event in ftp.events))
        self.assertEqual(ftp.files["old"], b"old")

    def test_local_disk_reserve_limits_archive_and_refuses_a_full_disk(self):
        self.assertEqual(self.run_backup(FakeFTP(), disk_free=10**8 + 100000), [100000])
        ftp = FakeFTP()
        with self.assertRaises(backup.BackupError):
            self.run_backup(ftp, disk_free=10**8)
        self.assertFalse(any(event[0] in ("upload", "rename", "register", "delete") for event in ftp.events))

    def test_upload_size_integrity_and_status_failures_preserve_previous_copy(self):
        old = "duck-ftp-torrentduck-2020-01-01T00-00-00-" + "a" * 32 + ".tar.age"
        for failure in ["upload", "size", "integrity", "retrieve", "status"]:
            with self.subTest(failure=failure):
                ftp = FakeFTP({old: b"old"}, failure=failure)
                with self.assertRaises((backup.BackupError, ftplib.error_temp)):
                    self.run_backup(ftp, status_failure=failure == "status")
                self.assertEqual(ftp.files[old], b"old")
                self.assertFalse(any(event == ("delete", old) for event in ftp.events))
                self.assertFalse(any(name.endswith(".partial") for name in ftp.files))
                operations = [event[0] for event in ftp.events]
                if failure in ("upload", "size"):
                    self.assertNotIn("rename", operations)
                    self.assertNotIn("register", operations)
                elif failure == "integrity":
                    self.assertNotIn("register", operations)
                    self.assertEqual(ftp.files, {old: b"old"})
                elif failure == "retrieve":
                    self.assertNotIn("register", operations)
                    self.assertEqual(len(ftp.files), 2)
                else:
                    self.assertIn("register", operations)
                    self.assertEqual(len(ftp.files), 2)
                self.assertEqual(operations[-1], "close")

    def test_pruning_failure_reports_registered_success_without_exposing_ftp_errors(self):
        old = "duck-ftp-torrentduck-2020-01-01T00-00-00-" + "a" * 32 + ".tar.age"
        ftp = FakeFTP({old: b"old"}, failure="prune")
        with self.assertRaisesRegex(backup.BackupError, "saved and registered.*pruning") as failure:
            self.run_backup(ftp)
        self.assertNotIn("fixture-password", str(failure.exception))
        registered = next(event[1] for event in ftp.events if event[0] == "register")
        self.assertEqual(set(ftp.files), {old, registered})
        operations = [event[0] for event in ftp.events]
        self.assertLess(operations.index("register"), operations.index("delete"))
        self.assertEqual(operations[-1], "close")

    @unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"), "age tools unavailable")
    def test_encrypted_archive_keeps_database_when_share_exceeds_budget(self):
        source = io.BytesIO()
        with tarfile.open(fileobj=source, mode="w") as archive:
            for name, content in [("database.dump", b"fixture database"), ("config/.env", b"DUMMY=fixture\n")]:
                header = tarfile.TarInfo(name)
                header.size = len(content)
                archive.addfile(header, io.BytesIO(content))
        original_popen = subprocess.Popen
        def popen(command, *args, **kwargs):
            if command == ["sh", "scripts/backup-remote.sh"]:
                command = [sys.executable, "-c", "import sys; sys.stdout.buffer.write(bytes.fromhex(" + repr(source.getvalue().hex()) + "))"]
            return original_popen(command, *args, **kwargs)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = root / "identity.txt"
            subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
            recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True).stdout.strip()
            share = root / "share"
            share.mkdir()
            (share / "large").write_bytes(b"x" * 200000)
            (share / "link").symlink_to(share / "large")
            for include_small in [False, True]:
                with self.subTest(include_small=include_small):
                    if include_small:
                        (share / "small").write_bytes(b"small fixture")
                    destination = root / (str(include_small) + ".tar.age")
                    with patch.object(backup.subprocess, "Popen", side_effect=popen):
                        manifest = backup.create_archive(destination, recipient, share, 131072)
                    self.assertLessEqual(destination.stat().st_size, 131072)
                    plaintext = subprocess.run(["age", "--decrypt", "--identity", str(identity), str(destination)], check=True, capture_output=True).stdout
                    with tarfile.open(fileobj=io.BytesIO(plaintext)) as archive:
                        self.assertEqual(archive.extractfile("database.dump").read(), b"fixture database")
                        self.assertEqual(archive.extractfile("config/.env").read(), b"DUMMY=fixture\n")
                        self.assertEqual(json.load(archive.extractfile("backup-manifest.json")), manifest)
                        self.assertEqual(manifest["included"], int(include_small))
                        self.assertEqual(manifest["includedBytes"], len(b"small fixture") if include_small else 0)
                        self.assertEqual(manifest["excludedBytes"], 200000)
                        self.assertEqual(manifest["totalBytes"], 200000 + manifest["includedBytes"])
                        self.assertEqual(manifest["excludedForSpace"], 1)
                        self.assertEqual(manifest["excludedUnsafe"], 1)
                        self.assertNotIn("share/large", archive.getnames())
                        self.assertNotIn("share/link", archive.getnames())
                        if include_small:
                            self.assertEqual(archive.extractfile("share/small").read(), b"small fixture")


if __name__ == "__main__":
    unittest.main()
