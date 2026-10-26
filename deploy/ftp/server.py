"""FTPS permissions are checked by command; authenticated sessions run chrooted."""
import ctypes
import errno
import io
import logging
import os
import signal

from pyftpdlib.authorizers import AuthenticationFailed, DummyAuthorizer
from pyftpdlib.filesystems import AbstractedFS
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import MultiprocessFTPServer

from auth import authenticate


renameat2 = ctypes.CDLL(None, use_errno=True).renameat2


def reserve(path, size=0):
    disk = os.statvfs(path)
    if disk.f_bavail * disk.f_frsize - size < disk.f_blocks * disk.f_frsize // 10:
        raise OSError(errno.ENOSPC, "The 10% disk reserve must remain free")


class Upload(io.BufferedWriter):
    def __init__(self, destination, handler):
        reserve(os.path.dirname(destination))
        if os.path.lexists(destination):
            raise FileExistsError(errno.EEXIST, "The destination already exists")
        self.directory = os.open(os.path.dirname(destination), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.temporary = ".duck-upload-" + os.urandom(16).hex()
        try:
            descriptor = os.open(self.temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory)
            super().__init__(io.FileIO(descriptor, "wb"))
        except Exception:
            os.close(self.directory)
            raise
        self.destination = destination
        self.handler = handler

    @property
    def name(self):
        return self.destination

    def write(self, data):
        reserve(self.directory, len(data))
        return super().write(data)

    def close(self):
        if self.closed:
            return
        channel = self.handler.data_channel
        try:
            self.flush()
            os.fsync(self.fileno())
            super().close()
            if channel is not None and channel.transfer_finished:
                reserve(self.directory)
                # link publishes a complete upload and cannot replace a concurrent destination.
                os.link(self.temporary, os.path.basename(self.destination), src_dir_fd=self.directory,
                        dst_dir_fd=self.directory, follow_symlinks=False)
        except OSError:
            if channel is not None:
                channel.transfer_finished = False
                channel._resp = ("450 Upload could not be published.", logging.warning)
        finally:
            try:
                super().close()
            except OSError:
                pass
            try:
                os.unlink(self.temporary, dir_fd=self.directory)
            except FileNotFoundError:
                pass
            finally:
                os.close(self.directory)


class Filesystem(AbstractedFS):
    def validpath(self, path):
        if not super().validpath(path):
            return False
        current = self.root
        for part in os.path.relpath(path, self.root).split(os.sep):
            if part == ".":
                continue
            current = os.path.join(current, part)
            if part.startswith(".") or os.path.islink(current):
                return False
        return True

    def listdir(self, path):
        return [name for name in super().listdir(path) if not name.startswith(".") and not os.path.islink(os.path.join(path, name))]

    def open(self, filename, mode):
        if mode == "wb":
            return Upload(filename, self.cmd_channel)
        if mode != "rb":
            raise OSError(errno.EACCES, "Appending and resuming uploads are forbidden")
        return open(filename, mode, opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW))

    def rename(self, source, destination):
        # Linux RENAME_NOREPLACE also protects directory renames from concurrent writes.
        if renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
            raise OSError(ctypes.get_errno(), "Rename refused")


class Authorizer(DummyAuthorizer):
    def validate_authentication(self, username, password, handler):
        role = authenticate({**os.environ, "AUTHD_ACCOUNT": username, "AUTHD_PASSWORD": password,
                             "AUTHD_ENCRYPTED": "1" if handler._ssl_established else "0"})
        if not role:
            raise AuthenticationFailed("Authentication failed")
        self.add_user(username, "", "/data", perm="elr")
        handler.role = role

    def has_perm(self, username, permission, path=None):
        if path in ("/", "/downloads", "/share") and permission not in "elr":
            return False
        return super().has_perm(username, permission, path)


class Handler(TLS_FTPHandler):
    authorizer = Authorizer()
    abstracted_fs = Filesystem
    certfile = "/etc/ssl/private/pure-ftpd.pem"
    tls_control_required = True
    tls_data_required = True
    passive_ports = range(50000, 50101)
    timeout = 900
    banner = "Torrents Duck FTPS"

    def handle_auth_success(self, home, password, message):
        # MultiprocessFTPServer isolates each session before chroot and privilege dropping.
        os.chroot(home)
        os.chdir("/")
        os.setgroups([])
        os.setgid(10000)
        os.setuid(10000)
        self.authorizer.user_table[self.username]["home"] = "/"
        self.authorizer.override_perm(self.username, "/share", "elrdfmw", recursive=True)
        self.authorizer.override_perm(self.username, "/downloads", "elrd" if self.role == "admin" else "elr", recursive=True)
        super().handle_auth_success("/", "", message)

    def ftp_USER(self, line):
        if self.authenticated:
            self.respond("530 Reconnect to change account.")
        else:
            super().ftp_USER(line)

    def ftp_REIN(self, line):
        self.respond("530 Reconnect to change account.")

    def ftp_STOU(self, line):
        self.respond("550 Use STOR with a new filename.")

    def ftp_PROT(self, line):
        if line.upper() == "C":
            self.respond("534 Encrypted data connections are required.")
        else:
            super().ftp_PROT(line)


class Server(MultiprocessFTPServer):
    def _start_task(self, *args, **kwargs):
        process = super()._start_task(*args, **kwargs)
        process.remote_ip = kwargs["args"][0].remote_ip
        return process

    def handle_accepted(self, sock, address):
        # The base multiprocess server forgets each IP when closing its copy of the connection.
        self.ip_map = [process.remote_ip for process in self._active_tasks if process.is_alive()]
        return super().handle_accepted(sock, address)

    def _accept_new_cons(self):
        return self._map_len() < self.max_cons


def terminate(*_):
    raise SystemExit()


if __name__ == "__main__":
    os.umask(0o022)
    signal.signal(signal.SIGTERM, terminate)
    Handler.masquerade_address = os.environ["PUBLIC_IPV4"]
    with Server(("0.0.0.0", 21000), Handler) as server:
        server.max_cons = 40
        server.max_cons_per_ip = 8
        server.serve_forever()
