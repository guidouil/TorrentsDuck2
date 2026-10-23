"""Close every FTPS session when access changes or the policy becomes unavailable."""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request


def revision(environment, opener=urllib.request.urlopen):
    secret = environment.get("INTERNAL_API_SECRET", "")
    if len(secret) < 32:
        raise ValueError("Missing internal API secret")
    request = urllib.request.Request(
        "http://web:3000/api/internal/ftp-policy",
        headers={"Authorization": "Bearer " + secret},
    )
    with opener(request, timeout=3) as response:
        body = response.read(4097)
        if response.status != 200 or len(body) > 4096:
            raise ValueError("Unavailable FTP policy")
        value = json.loads(body).get("revision")
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ValueError("Invalid FTP policy")
        return value


def unchanged(baseline, environment, opener=urllib.request.urlopen):
    try:
        return revision(environment, opener) == baseline
    except Exception:
        return False


def stop(children):
    for process in children:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for process in children:
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def main():
    children = []
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    try:
        # No listening socket is opened before policy authentication succeeds.
        baseline = revision(os.environ)
        children.append(subprocess.Popen(["/usr/sbin/pure-authd", "-s", "/run/pure-ftpd/auth.sock", "-r", "/usr/local/bin/ftp-auth"], start_new_session=True))
        for _ in range(50):
            if os.path.exists("/run/pure-ftpd/auth.sock"):
                break
            if children[0].poll() is not None:
                raise RuntimeError("Authentication daemon stopped")
            time.sleep(0.1)
        else:
            raise RuntimeError("Authentication socket unavailable")
        children.append(subprocess.Popen([
            "/usr/sbin/pure-ftpd", "-4", "-A", "-E", "-H", "-R", "-x", "-X", "-0",
            "-c", "40", "-C", "8", "-u", "10000", "-U", "022:022", "-k", "90",
            "-S", "0.0.0.0,21000", "-p", "50000:50100", "-P", os.environ["PUBLIC_IPV4"],
            "-Y", "3", "-2", "/etc/ssl/private/pure-ftpd.pem", "-l", "extauth:/run/pure-ftpd/auth.sock",
        ], start_new_session=True))
        while True:
            time.sleep(5)
            if any(process.poll() is not None for process in children):
                raise RuntimeError("FTP child stopped with status " + str([process.poll() for process in children]))
            if not unchanged(baseline, os.environ):
                raise RuntimeError("FTP policy changed or became unavailable; closing sessions")
    finally:
        stop(children)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FTP stopped: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
