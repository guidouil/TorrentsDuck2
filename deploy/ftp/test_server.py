"""Filesystem regressions; run with the FTPS image's Python dependencies."""
import errno
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class Files(unittest.TestCase):
    def test_upload_publishes_atomically_without_replacing_concurrent_files(self):
        for concurrent in (False, True):
            with self.subTest(concurrent=concurrent), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary) / "file.txt"
                channel = types.SimpleNamespace(transfer_finished=False)
                upload = server.Upload(str(destination), types.SimpleNamespace(data_channel=channel))
                upload.write(b"complete contents")
                self.assertFalse(destination.exists())
                if concurrent:
                    destination.write_bytes(b"keep me")
                channel.transfer_finished = True
                upload.close()
                self.assertEqual(destination.read_bytes(), b"keep me" if concurrent else b"complete contents")
                self.assertEqual(channel.transfer_finished, not concurrent)
                self.assertEqual(list(Path(temporary).glob(".duck-upload-*")), [])

    def test_failed_upload_cleans_temporary_and_keeps_existing_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "file.txt"
            upload = server.Upload(str(destination), types.SimpleNamespace(data_channel=None))
            upload.write(b"incomplete")
            upload.close()
            self.assertEqual(list(Path(temporary).iterdir()), [])
            destination.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):
                server.Upload(str(destination), types.SimpleNamespace(data_channel=None))
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_parent_rename_during_upload_keeps_publication_and_cleanup_in_that_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, renamed = Path(temporary) / "original", Path(temporary) / "renamed"
            directory.mkdir()
            channel = types.SimpleNamespace(transfer_finished=False)
            upload = server.Upload(str(directory / "file.txt"), types.SimpleNamespace(data_channel=channel))
            upload.write(b"complete")
            directory.rename(renamed)
            channel.transfer_finished = True
            upload.close()
            self.assertEqual((renamed / "file.txt").read_bytes(), b"complete")
            self.assertEqual(list(renamed.glob(".duck-upload-*")), [])

    def test_disk_reserve_is_rechecked_while_receiving(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "file.txt"
            upload = server.Upload(str(destination), types.SimpleNamespace(data_channel=None))
            disk = types.SimpleNamespace(f_bavail=11, f_frsize=1, f_blocks=100)
            with patch.object(server.os, "statvfs", return_value=disk):
                with self.assertRaises(OSError) as error:
                    upload.write(b"two")
                self.assertEqual(error.exception.errno, errno.ENOSPC)
            upload.close()
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_parent_deletion_aborts_publication_without_leaking_or_raising(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "folder"
            directory.mkdir()
            channel = types.SimpleNamespace(transfer_finished=False)
            upload = server.Upload(str(directory / "file.txt"), types.SimpleNamespace(data_channel=channel))
            upload.write(b"pending")
            next(directory.iterdir()).unlink()
            directory.rmdir()
            channel.transfer_finished = True
            upload.close()
            self.assertFalse(channel.transfer_finished)
            self.assertTrue(channel._resp[0].startswith("450 "))
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_paths_reject_symlinks_hidden_files_and_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "folder").mkdir()
            (root / "folder/file").write_text("fixture")
            (root / "link").symlink_to("folder", target_is_directory=True)
            filesystem = server.Filesystem(temporary, None)
            self.assertTrue(filesystem.validpath(str(root / "folder/file")))
            for relative in ("link", "link/file", ".hidden", "../outside"):
                self.assertFalse(filesystem.validpath(str(root / relative)), relative)
            self.assertEqual(filesystem.listdir(temporary), ["folder"])

    def test_renames_never_replace_files_or_directories(self):
        for directory in (False, True):
            with self.subTest(directory=directory), tempfile.TemporaryDirectory() as temporary:
                source, destination = Path(temporary) / "source", Path(temporary) / "destination"
                if directory:
                    source.mkdir()
                    destination.mkdir()
                else:
                    source.write_bytes(b"source")
                    destination.write_bytes(b"destination")
                original = destination.stat().st_ino
                filesystem = server.Filesystem(temporary, None)
                with self.assertRaises(OSError) as error:
                    filesystem.rename(str(source), str(destination))
                self.assertEqual(error.exception.errno, errno.EEXIST)
                self.assertTrue(source.exists())
                self.assertEqual(destination.stat().st_ino, original)


if __name__ == "__main__":
    unittest.main()
