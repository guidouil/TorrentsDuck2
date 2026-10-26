#!/usr/bin/env python3
"""Real, local Docker protocol checks; removes only its own named resources."""
import ftplib
import hashlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
SECRET = "integration-only-not-a-production-secret-1234"
PASSWORD = "integration-only-RPC-password-1234"
MOCK = r'''
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
state={"revision":"1","revoked":False,"available":True,"admin":True}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def answer(self,status,body=b"",headers={}):
        self.send_response(status)
        for name,value in headers.items(): self.send_header(name,value)
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/health": return self.answer(200,b"ok")
        if self.path == "/api/internal/ftp-policy":
            if self.headers.get("Authorization") != "Bearer integration-only-not-a-production-secret-1234": return self.answer(401)
            if not state["available"]: return self.answer(503)
            return self.answer(200,json.dumps({"revision":state["revision"]}).encode(),{"content-type":"application/json"})
        if self.path == "/file":
            if self.headers.get("Cookie") != "session=fixture": return self.answer(401,b"unauthorized")
            return self.answer(200,b"",{"X-Accel-Redirect":"/_protected/share/sample.txt"})
        return self.answer(404)
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers.get("Content-Length","0"))) or b"{}")
        if self.headers.get("Authorization") != "Bearer integration-only-not-a-production-secret-1234": return self.answer(401)
        if self.path == "/api/internal/ftp-auth":
            allowed=(data.get("username") in ["member","other","membre été","admin"] and data.get("password")=="test password" and not (data.get("username")=="member" and state["revoked"]))
            return self.answer(200 if allowed else 401,json.dumps({"authorized":allowed,"role":"admin" if data.get("username")=="admin" and state["admin"] else "member"}).encode(),{"content-type":"application/json"})
        if self.path == "/demote": state.update(revision="2",admin=False)
        elif self.path == "/revoke": state.update(revision="3",revoked=True)
        elif self.path == "/available": state["available"]=data["available"]
        else: return self.answer(404)
        self.answer(200,b"ok")
ThreadingHTTPServer(("0.0.0.0",3000),Handler).serve_forever()
'''


def run(*args, **options):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.decode()}")
    return result.stdout.decode().strip()


def docker(*args):
    return run("docker", *args)


def eventually(action, timeout=30):
    last = None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = action()
            if result:
                return result
        except Exception as error:
            last = error
        time.sleep(0.3)
    raise AssertionError(f"Condition timed out: {last}")


def port(container, internal):
    return int(docker("port", container, str(internal) + "/tcp").split(":")[-1])


def bencode(value):
    if isinstance(value, int):
        return b"i" + str(value).encode() + b"e"
    if isinstance(value, bytes):
        return str(len(value)).encode() + b":" + value
    if isinstance(value, dict):
        return b"d" + b"".join(bencode(key) + bencode(value[key]) for key in sorted(value)) + b"e"
    raise TypeError(value)


def main():
    prefix = "duck-infra-" + uuid.uuid4().hex[:10]
    network = prefix + "-network"
    containers = []
    network_created = False
    with tempfile.TemporaryDirectory(prefix="duck-infra-", dir="/private/tmp" if Path("/private/tmp").exists() else None) as temporary:
        work = Path(temporary)
        work.chmod(0o755)
        try:
            docker("network", "create", "--subnet", "172.30.20.0/24", network)
            network_created = True
            for name in ["downloads", "share", "qbt", "certificates", "ftp-tls"]:
                (work / name).mkdir(mode=0o777 if name in ["downloads", "share", "qbt"] else 0o755)
                if name in ["downloads", "share", "qbt"]:
                    (work / name).chmod(0o777)
            contents = b"0123456789" * 200
            (work / "share/sample.txt").write_bytes(contents)
            (work / "downloads/legal-fixture.txt").write_bytes(contents)
            (work / "downloads/delete.txt").write_bytes(contents)
            (work / "downloads/empty").mkdir()
            (work / "downloads/link").symlink_to("legal-fixture.txt")
            (work / "share/download-link").symlink_to("../downloads", target_is_directory=True)
            (work / "mock.py").write_text(MOCK)
            (work / "qbt/qBittorrent").mkdir()
            (work / "qbt/qBittorrent").chmod(0o777)
            (work / "qbt/qBittorrent/qBittorrent.conf").write_text("[BitTorrent]\nSession\\DHTEnabled=false\nSession\\LSDEnabled=false\nSession\\PeXEnabled=false\n")
            (work / "qbt/qBittorrent/qBittorrent.conf").chmod(0o666)
            certificate = work / "certificates/live/localhost"
            certificate.mkdir(parents=True)
            run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", str(certificate / "privkey.pem"), "-out", str(certificate / "fullchain.pem"))
            (work / "ftp-tls/pure-ftpd.pem").write_bytes((certificate / "fullchain.pem").read_bytes() + (certificate / "privkey.pem").read_bytes())
            (work / "ftp-tls/pure-ftpd.pem").chmod(0o600)

            def start(service, image, arguments, ip, command=()):
                name = prefix + "-" + service
                # Register before startup so a partially created container is cleaned up too.
                containers.append(name)
                docker("run", "-d", "--name", name, "--network", network, "--ip", ip, *arguments, image, *command)
                return name

            mock = start("mock", "torrentduck-ftp", ["--network-alias", "web", "--entrypoint", "python3", "-p", "127.0.0.1::3000", "-v", f"{work}:/fixtures"], "172.30.20.3", ["/fixtures/mock.py"])
            mock_url = "http://127.0.0.1:" + str(port(mock, 3000))
            eventually(lambda: urllib.request.urlopen(mock_url + "/health", timeout=2).status == 200)
            docker("exec", mock, "python3", "-c", "import os; p='/fixtures/share/sample.txt'; os.chown(p,10000,10000); os.chmod(p,0o600)")

            def update_policy(route, body):
                request = urllib.request.Request(mock_url + route, json.dumps(body).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + SECRET})
                return urllib.request.urlopen(request, timeout=3).read()

            qbt = start("qbt", "torrentduck-qbittorrent", ["--network-alias", "qbittorrent", "-p", "127.0.0.1::8080", "-e", "QBT_USERNAME=fixture-rpc", "-e", "QBT_PASSWORD=" + PASSWORD, "-v", f"{work / 'qbt'}:/config", "-v", f"{work / 'downloads'}:/data/downloads", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"], "172.30.20.2")
            qbt_url = "http://127.0.0.1:" + str(port(qbt, 8080))
            cookies = http.cookiejar.CookieJar()
            client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

            def qbt_request(route, data=None, headers={}):
                request = urllib.request.Request(qbt_url + "/api/v2/" + route, data=data, headers={"Host": "qbittorrent:8080", "Origin": "http://qbittorrent:8080", "Referer": "http://qbittorrent:8080/", **headers})
                return client.open(request, timeout=3).read()

            def login():
                return qbt_request("auth/login", urllib.parse.urlencode({"username": "fixture-rpc", "password": PASSWORD}).encode()) == b"Ok."

            eventually(login)
            try:
                urllib.request.urlopen(urllib.request.Request(qbt_url + "/api/v2/torrents/info", headers={"Host": "qbittorrent:8080"}), timeout=3)
                raise AssertionError("qBittorrent RPC accepted anonymous access")
            except urllib.error.HTTPError as error:
                assert error.code == 403
            info = {b"length": len(contents), b"name": b"legal-fixture.txt", b"piece length": 16384, b"pieces": hashlib.sha1(contents).digest()}
            torrent = bencode({b"info": info})
            torrent_hash = hashlib.sha1(bencode(info)).hexdigest()
            boundary = "duck-integration-fixture"
            body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"torrents\"; filename=\"legal.torrent\"\r\nContent-Type: application/x-bittorrent\r\n\r\n".encode() + torrent + f"\r\n--{boundary}--\r\n".encode())
            qbt_request("torrents/add", body, {"Content-Type": "multipart/form-data; boundary=" + boundary})

            def torrents():
                return json.loads(qbt_request("torrents/info"))

            eventually(lambda: any(item["hash"] == torrent_hash for item in torrents()))
            qbt_request("torrents/stop", urllib.parse.urlencode({"hashes": torrent_hash}).encode())
            eventually(lambda: torrents()[0]["state"].startswith("stopped"))
            qbt_request("torrents/start", urllib.parse.urlencode({"hashes": torrent_hash}).encode())
            eventually(lambda: not torrents()[0]["state"].startswith("stopped"))
            docker("restart", qbt)
            qbt_url = "http://127.0.0.1:" + str(port(qbt, 8080))
            cookies.clear()
            eventually(login)
            eventually(lambda: any(item["hash"] == torrent_hash for item in torrents()))
            print("PASS qBittorrent: password required, torrent add/stop/start, state persisted after restart", flush=True)

            nginx = start("nginx", "torrentduck-nginx", ["-p", "127.0.0.1::443", "-e", "DOMAIN=localhost", "-e", "NGINX_ENVSUBST_FILTER=DOMAIN", "-v", f"{ROOT / 'deploy/nginx/site.conf.template'}:/etc/nginx/templates/default.conf.template:ro", "-v", f"{work / 'certificates'}:/etc/letsencrypt:ro", "-v", f"{work / 'share'}:/data/share:ro", "-v", f"{work / 'downloads'}:/data/downloads:ro", "--read-only", "--tmpfs", "/etc/nginx/conf.d", "--tmpfs", "/var/cache/nginx", "--tmpfs", "/var/run", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--cap-add", "NET_BIND_SERVICE", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE"], "172.30.20.4")
            https = "https://127.0.0.1:" + str(port(nginx, 443))
            context = ssl._create_unverified_context()

            def request_https(route, headers={}):
                try:
                    with urllib.request.urlopen(urllib.request.Request(https + route, headers={"Host": "localhost", **headers}), context=context, timeout=3) as response:
                        return response.status, response.read(), response.headers
                except urllib.error.HTTPError as error:
                    return error.code, error.read(), error.headers

            eventually(lambda: request_https("/file")[0] == 401)
            assert request_https("/_protected/share/sample.txt")[0] == 404
            assert request_https("/api/internal/ftp-policy")[0] == 404
            status, data, headers = request_https("/file", {"Cookie": "session=fixture", "Range": "bytes=11-30"})
            assert status == 206 and data == contents[11:31], (status, data)
            assert headers["Content-Range"] == f"bytes 11-30/{len(contents)}"
            print("PASS Nginx: anonymous/internal denial, authenticated X-Accel redirect, byte-range video response", flush=True)

            ftp_caps = [argument for capability in ["SETUID", "SETGID", "SYS_CHROOT", "KILL"] for argument in ["--cap-add", capability]]
            ftp = start("ftp", "torrentduck-ftp", ["-p", "127.0.0.1::21000", "-p", "127.0.0.1:50000-50100:50000-50100", "-e", "INTERNAL_API_SECRET=" + SECRET, "-e", "PUBLIC_IPV4=127.0.0.1", "-v", f"{work / 'ftp-tls'}:/etc/ssl/private:ro", "-v", f"{work / 'share'}:/data/share", "-v", f"{work / 'downloads'}:/data/downloads", "--read-only", "--tmpfs", "/run", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", *ftp_caps], "172.30.20.5")
            ftp_port = port(ftp, 21000)

            def ftp_client(username="member", protect=True):
                client = ftplib.FTP_TLS(context=context, timeout=3)
                client.connect("127.0.0.1", ftp_port)
                client.login(username, "test password")
                if protect:
                    client.prot_p()
                return client

            member = eventually(lambda: ftp_client())
            other = ftp_client("other")
            admin = ftp_client("admin")
            accented = ftp_client("membre été")
            accented.quit()
            plain = ftplib.FTP(timeout=3)
            plain.connect("127.0.0.1", ftp_port)
            try:
                plain.login("member", "test password")
                raise AssertionError("Plain FTP was accepted")
            except ftplib.all_errors:
                pass
            finally:
                plain.close()
            clear = ftp_client(protect=False)
            try:
                clear.nlst()
                raise AssertionError("Cleartext FTP data was accepted")
            except ftplib.all_errors:
                pass
            finally:
                clear.close()
            received = io.BytesIO()
            member.retrbinary("RETR /downloads/legal-fixture.txt", received.write)
            assert received.getvalue() == contents
            try:
                member.storbinary("STOR /downloads/forbidden.txt", io.BytesIO(b"forbidden"))
                raise AssertionError("Downloads accepted a write")
            except ftplib.error_perm:
                pass
            def denied(action):
                try:
                    action()
                except ftplib.error_perm:
                    return
                raise AssertionError("Forbidden FTPS operation succeeded")

            tls_probe = ftp_client("other")
            tls_probe.sendcmd("PASV")
            denied(lambda: tls_probe.sendcmd("PROT C"))
            tls_probe.quit()
            for client in (member, admin):
                denied(lambda: client.storbinary("STOR /downloads/forbidden.txt", io.BytesIO(b"forbidden")))
                denied(lambda: client.storbinary("APPE /downloads/legal-fixture.txt", io.BytesIO(b"forbidden")))
                denied(lambda: client.mkd("/downloads/forbidden"))
                denied(lambda: client.rename("/downloads/legal-fixture.txt", "/share/moved.txt"))
                denied(lambda: client.rmd("/downloads"))
                denied(lambda: client.rmd("/share"))
                denied(lambda: client.rmd("/"))
                denied(lambda: client.retrbinary("RETR /downloads/link", lambda _: None))
                denied(lambda: client.storbinary("STOR /share/download-link/forbidden.txt", io.BytesIO(b"forbidden")))
                denied(lambda: client.sendcmd("SITE CHMOD 777 /downloads/legal-fixture.txt"))
                denied(lambda: client.sendcmd("STOU /downloads/unique.txt"))
                denied(lambda: client.sendcmd("PROT C"))
                denied(lambda: client.sendcmd("REIN"))
                denied(lambda: client.sendcmd("USER admin"))
            denied(lambda: member.delete("/downloads/delete.txt"))
            denied(lambda: member.delete("/share/../downloads/delete.txt"))
            denied(lambda: admin.retrbinary("RETR /../../etc/passwd", lambda _: None))
            denied(lambda: member.rmd("/downloads/empty"))
            admin.delete("/downloads/delete.txt")
            admin.rmd("/downloads/empty")
            assert not (work / "downloads/delete.txt").exists() and not (work / "downloads/empty").exists()
            denied(lambda: admin.storbinary("STOR /share/upload.txt", io.BytesIO(b"resume"), rest=1))
            member.storbinary("STOR /share/upload.txt", io.BytesIO(b"shared fixture"))
            denied(lambda: member.storbinary("STOR /share/upload.txt", io.BytesIO(b"overwrite")))
            denied(lambda: member.storbinary("APPE /share/upload.txt", io.BytesIO(b"overwrite")))
            assert (work / "share/upload.txt").read_bytes() == b"shared fixture"
            denied(lambda: member.rename("/share/upload.txt", "/downloads/moved.txt"))
            denied(lambda: member.rename("/share/upload.txt", "/share/sample.txt"))
            assert (work / "share/sample.txt").read_bytes() == contents
            member.rename("/share/upload.txt", "/share/renamed.txt")
            received = io.BytesIO()
            member.retrbinary("RETR /share/renamed.txt", received.write)
            assert received.getvalue() == b"shared fixture"
            member.delete("/share/renamed.txt")
            print("PASS FTPS: mandatory TLS, Unicode login, admin-only downloads deletion, protected roots/symlinks, exclusive share uploads/rename/delete", flush=True)

            extra = [ftp_client("other") for _ in range(5)]
            try:
                unexpected = ftp_client("other")
                unexpected.close()
                raise AssertionError("FTPS accepted a ninth session from one IP")
            except ftplib.all_errors:
                pass
            for client in extra:
                client.quit()
            pending = member.transfercmd("STOR /share/pending.txt")
            pending.sendall(b"unfinished upload")
            eventually(lambda: list((work / "share").glob(".duck-upload-*")))
            assert not (work / "share/pending.txt").exists()
            update_policy("/demote", {})
            eventually(lambda: docker("inspect", "-f", "{{.State.Running}}", ftp) == "false", timeout=15)
            pending.close()
            assert not list((work / "share").glob(".duck-upload-*")), "Revocation left an orphan upload"
            assert not (work / "share/pending.txt").exists()
            for client in (member, other, admin):
                client.close()
            docker("start", ftp)
            ftp_port = port(ftp, 21000)
            admin = eventually(lambda: ftp_client("admin"))
            denied(lambda: admin.delete("/downloads/legal-fixture.txt"))
            admin.quit()
            member = ftp_client()
            other = ftp_client("other")
            print("PASS FTPS: eight-session IP limit and administrator demotion revokes deletion", flush=True)

            update_policy("/revoke", {})

            def disconnected(client):
                try:
                    client.voidcmd("NOOP")
                    return False
                except ftplib.all_errors:
                    return True

            eventually(lambda: disconnected(member) and disconnected(other), timeout=15)
            eventually(lambda: docker("inspect", "-f", "{{.State.Running}}", ftp) == "false", timeout=10)
            member.close()
            other.close()
            docker("start", ftp)
            ftp_port = port(ftp, 21000)
            allowed = eventually(lambda: ftp_client("other"))
            allowed.quit()
            try:
                unexpected = ftp_client("member")
                unexpected.close()
                raise AssertionError("Disabled FTP account reconnected")
            except ftplib.all_errors:
                pass
            update_policy("/available", {"available": False})
            eventually(lambda: docker("inspect", "-f", "{{.State.Running}}", ftp) == "false", timeout=15)
            docker("start", ftp)
            eventually(lambda: docker("inspect", "-f", "{{.State.Running}}", ftp) == "false", timeout=10)
            print("PASS FTPS guardian: revocation closes all sessions; disabled login and policy outage fail closed", flush=True)
        except Exception:
            for container in containers:
                try:
                    result = subprocess.run(["docker", "logs", "--tail", "40", container], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    print(f"--- {container} logs ---\n{result.stdout.decode()}", flush=True)
                except Exception:
                    pass
            raise
        finally:
            for container in reversed(containers):
                subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if network_created:
                subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
