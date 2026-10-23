"""Small checks for the security-sensitive service bootstrap code."""
import base64
import hashlib
import importlib.util
import io
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ftp = load("ftp_auth", "ftp/auth.py")
qbt = load("qbt_init", "qbittorrent/initialize.py")
guardian = load("ftp_guardian", "ftp/guardian.py")


class Services(unittest.TestCase):
    def test_update_checks_disk_and_preserves_cleanup_and_failures(self):
        source = (Path(__file__).resolve().parents[1] / "scripts/update.sh").read_text()
        for scenario in ["success", "dirty", "staged", "untracked", "locked", "low-disk", "failed-deploy", "failed-health"]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                executable = root / "bin"
                executable.mkdir()
                (root / ".git").mkdir()
                (root / "scripts").mkdir()
                script = root / "update.sh"
                script.write_text(source.replace("cd /opt/torrentduck", "cd " + shlex.quote(str(root)), 1))
                (root / "scripts/deploy.sh").write_text('#!/bin/sh\necho deploy >> "$CALLS"\nexit "$DEPLOY_EXIT"\n')
                stubs = {
                    "id": '#!/bin/sh\necho 1000\n',
                    "flock": '#!/bin/sh\necho "flock $*" >> "$CALLS"\nif test "$SCENARIO" = locked; then exit 1; fi\n',
                    "git": '''#!/bin/sh
echo "git $*" >> "$CALLS"
case "$*:$SCENARIO" in
  "status --porcelain:dirty") echo ' M tracked';;
  "status --porcelain:staged") echo 'M  tracked';;
  "status --porcelain:untracked") echo '?? fixture';;
esac
''',
                    "sudo": '#!/bin/sh\necho "sudo $*" >> "$CALLS"\nexec "$@"\n',
                    "df": '''#!/bin/sh
echo "df $*" >> "$CALLS"
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo "fixture 100000000 0 $DISK_AVAILABLE 0% /fixture/docker"
''',
                    "docker": '''#!/bin/sh
echo "docker $*" >> "$CALLS"
case "$*" in
  info*) echo /fixture/docker;;
  "compose exec -T web node --input-type=module -")
    cat > "$HEALTH_SCRIPT"
    if test "$SCENARIO" = failed-health; then exit 38; fi
    ;;
esac
''',
                }
                for name, body in stubs.items():
                    (executable / name).write_text(body)
                    (executable / name).chmod(0o700)
                calls = root / "calls"
                environment = {
                    **os.environ, "PATH": str(executable) + ":" + os.environ["PATH"],
                    "CALLS": str(calls), "HEALTH_SCRIPT": str(root / "health.js"), "SCENARIO": scenario,
                    "DISK_AVAILABLE": "15242879" if scenario == "low-disk" else "15242880",
                    "DEPLOY_EXIT": "37" if scenario == "failed-deploy" else "0",
                }
                result = subprocess.run(["sh", str(script)], env=environment, capture_output=True, text=True)
                commands = calls.read_text().splitlines()
                if scenario in ["dirty", "staged", "untracked", "locked"]:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(any(command.startswith(("git pull", "sudo", "docker")) for command in commands))
                    if scenario == "locked":
                        self.assertEqual(commands, ["flock -n 9"])
                    continue
                cleanup = "docker image prune -f --filter label=com.docker.compose.project=torrentduck"
                cache_cleanup = "docker builder prune -af --keep-storage 1GB"
                self.assertEqual(commands.count(cleanup), 2)
                self.assertEqual(commands.count(cache_cleanup), 2)
                self.assertEqual(commands[-2:], [cleanup, cache_cleanup])
                self.assertFalse(any("volume" in command or "system prune" in command or "backup" in command for command in commands))
                self.assertLess(commands.index("git pull --ff-only"), commands.index("sudo sh -s"))
                self.assertLess(commands.index(cleanup), commands.index("df -Pk /fixture/docker"))
                if scenario == "low-disk":
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn("deploy", commands)
                    continue
                self.assertLess(commands.index("df -Pk /fixture/docker"), commands.index("deploy"))
                nginx = "docker compose up -d --no-deps --force-recreate --wait nginx"
                health = "docker compose exec -T web node --input-type=module -"
                if scenario == "failed-deploy":
                    self.assertEqual(result.returncode, 37)
                    self.assertNotIn(nginx, commands)
                    self.assertNotIn(health, commands)
                else:
                    self.assertEqual(result.returncode, 38 if scenario == "failed-health" else 0, result.stderr)
                    self.assertLess(commands.index("deploy"), commands.index(nginx))
                    self.assertLess(commands.index(nginx), commands.index(health))
                    self.assertIn("process.env.ORIGIN + '/api/health'", (root / "health.js").read_text())
                    self.assertIn("(await response.json()).status === 'ok'", (root / "health.js").read_text())
                    if scenario == "failed-health":
                        self.assertNotIn("Deployment complete", result.stdout)

    @unittest.skipUnless(shutil.which("docker"), "Docker CLI unavailable")
    def test_local_compose_is_isolated_and_persistent(self):
        result = subprocess.run(
            ["docker", "compose", "-f", "compose.local.yaml", "config", "--format", "json"],
            cwd=Path(__file__).resolve().parents[1], check=True, capture_output=True, text=True,
        )
        configuration = json.loads(result.stdout)
        self.assertEqual(configuration["name"], "torrentduck-local")
        services = configuration["services"]
        self.assertEqual(set(services), {"volumes", "postgres", "web", "qbittorrent"})
        self.assertEqual(services["web"]["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(services["web"]["ports"][0]["published"], "5180")
        self.assertEqual(services["web"]["build"]["args"]["ORIGIN"], services["web"]["environment"]["ORIGIN"])
        for service in ["postgres", "qbittorrent"]:
            self.assertFalse(services[service].get("ports"))
            self.assertTrue(all(configuration["networks"][name]["internal"] for name in services[service]["networks"]))
        self.assertEqual(services["web"]["depends_on"]["postgres"]["condition"], "service_healthy")
        self.assertIn("-h 127.0.0.1", services["postgres"]["healthcheck"]["test"][-1])
        self.assertIn("scripts/migrate-db.ts", services["web"]["command"][-1])
        for service in ["web", "qbittorrent"]:
            downloads = next(mount for mount in services[service]["volumes"] if mount["target"] == "/data/downloads")
            self.assertEqual(downloads["source"], "downloads")
            self.assertEqual(downloads.get("read_only", False), service == "web")
        self.assertEqual(set(configuration["volumes"]), {"postgres", "downloads", "share", "qbittorrent"})

    @unittest.skipUnless(shutil.which("docker"), "Docker CLI unavailable")
    def test_compose_tmpfs_targets_are_absolute(self):
        result = subprocess.run(
            ["docker", "compose", "--env-file", ".env.example", "config", "--format", "json"],
            cwd=Path(__file__).resolve().parents[1], check=True, capture_output=True, text=True,
        )
        for service, configuration in json.loads(result.stdout)["services"].items():
            for mount in configuration.get("tmpfs", []):
                with self.subTest(service=service, mount=mount):
                    self.assertTrue(Path(mount.split(":", 1)[0]).is_absolute())

    def test_firewall_precedes_docker_and_blocks_private_destinations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "calls"
            iptables_stub = f'''#!/bin/sh
printf "%s\\n" "$*" >> "{log}"
case "$*" in
  "-C INPUT -s 172.30.20.2 -j DROP"|"-C INPUT -s 172.30.40.2 -j DROP")
    test ! -e "{root}/old-rule-$4" || exit 1
    touch "{root}/old-rule-$4"
    ;;
  -C*) exit 1;;
esac
'''
            for name, source in {"iptables": iptables_stub, "id": "#!/bin/sh\necho 0\n", "modprobe": "#!/bin/sh\nexit 0\n", "sysctl": "#!/bin/sh\nexit 0\n"}.items():
                (root / name).write_text(source)
                (root / name).chmod(0o700)
            environment = {**os.environ, "PATH": str(root) + ":" + os.environ["PATH"]}
            command = ["sh", str(Path(__file__).resolve().parent / "firewall.sh")]
            subprocess.run(command, env=environment, check=True, capture_output=True)
            calls = log.read_text()
            self.assertTrue(calls.startswith("-N DOCKER-USER\n"))
            for source in ["172.30.20.2", "172.30.40.2"]:
                install = f"-I INPUT 1 -s {source} -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP"
                remove_legacy = f"-D INPUT -s {source} -j DROP"
                self.assertLess(calls.index(install), calls.index(remove_legacy))
                self.assertNotIn(f"-I INPUT 1 -s {source} -j DROP", calls)
            for private in ["10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12"]:
                self.assertIn("-A DUCK-QBT -d " + private + " -j DROP", calls)
            self.assertLess(calls.index("-A DUCK-QBT -m conntrack --ctstate ESTABLISHED,RELATED"), calls.index("-A DUCK-QBT -d"))
            (root / "iptables").write_text('#!/bin/sh\nexit 1\n')
            failed = subprocess.run(command, env=environment, capture_output=True)
            self.assertNotEqual(failed.returncode, 0)

    def test_certificate_issue_email_and_renewal_only_restart_on_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "bin"
            executable.mkdir()
            certificates = root / "certificates/live/fixture.test"
            certificates.mkdir(parents=True)
            (certificates / "fullchain.pem").write_text("certificate\n")
            (certificates / "privkey.pem").write_text("key\n")
            ftp_tls = root / "ftp-tls"
            ftp_tls.mkdir()
            (ftp_tls / "pure-ftpd.pem").write_text("certificate\nkey\n")
            log = root / "calls"
            configuration = {"services": {"nginx": {"environment": {"DOMAIN": "fixture.test"}}, "certbot": {"environment": {"ACME_EMAIL": "configured@example.org"}, "volumes": [{"source": str(root / "certificates"), "target": "/etc/letsencrypt"}]}}}
            docker_stub = f'''#!/bin/sh
printf "%s\\n" "$*" >> "{log}"
case "$*" in
  *" config "*) cat <<'JSON'
{json.dumps(configuration)}
JSON
    ;;
  *" restart ftp")
    if test -e "{root}/fail-restart"; then
      rm "{root}/fail-restart"
      exit 1
    fi
    ;;
esac
'''
            for name, source in {"docker": docker_stub, "id": "#!/bin/sh\necho 0\n", "openssl": "#!/bin/sh\nexit 0\n"}.items():
                (executable / name).write_text(source)
                (executable / name).chmod(0o700)
            environment = {**os.environ, "PATH": str(executable) + ":" + os.environ["PATH"]}
            environment.pop("ACME_EMAIL", None)
            command = ["sh", str(Path(__file__).resolve().parents[1] / "scripts/deploy-certificates.sh"), "renew"]
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertIn("--profile maintenance config", log.read_text())
            self.assertIn("certbot renew --cert-name fixture.test --no-random-sleep-on-renew --webroot -w /var/www/acme --quiet", log.read_text())
            self.assertNotIn("restart ftp", log.read_text())
            (certificates / "fullchain.pem").write_text("renewed certificate\n")
            (root / "fail-restart").touch()
            failed = subprocess.run(command, env=environment, capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertTrue((ftp_tls / ".reload-pending").exists())
            self.assertEqual((ftp_tls / "pure-ftpd.pem").read_text(), "renewed certificate\nkey\n")
            log.write_text("")
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertIn("restart ftp", log.read_text())
            self.assertFalse((ftp_tls / ".reload-pending").exists())
            log.write_text("")
            subprocess.run(command, env=environment, check=True, capture_output=True)
            self.assertNotIn("restart ftp", log.read_text())
            for override, expected in [(None, "configured@example.org"), ("override@example.org", "override@example.org")]:
                with self.subTest(override=override):
                    log.write_text("")
                    issue_environment = environment if override is None else {**environment, "ACME_EMAIL": override}
                    subprocess.run([*command[:-1], "issue"], env=issue_environment, check=True, capture_output=True)
                    self.assertIn("--email " + expected + " -d fixture.test", log.read_text())

    def test_qbt_hash_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                qbt.configure(root, "duck", "short")
            qbt.configure(root, "duck-rpc", "a long production RPC password!")
            text = (Path(root) / "qBittorrent/qBittorrent.conf").read_text()
            encoded = text.split("@ByteArray(")[1].split(")")[0]
            salt, key = map(base64.b64decode, encoded.split(":"))
            self.assertEqual(key, hashlib.pbkdf2_hmac("sha512", b"a long production RPC password!", salt, 100000, 64))
            self.assertIn("LocalHostAuth=true", text)
            self.assertNotIn("a long production RPC password!", text)

    def test_ftp_tls_auth_and_errors(self):
        environment = {"INTERNAL_API_SECRET": "s" * 32, "AUTHD_ACCOUNT": "é space", "AUTHD_PASSWORD": "private", "AUTHD_ENCRYPTED": "1"}

        class Response(io.BytesIO):
            status = 200

        def accept(request, timeout):
            self.assertEqual(json.loads(request.data)["username"], "é space")
            self.assertEqual(request.headers["Authorization"], "Bearer " + "s" * 32)
            return Response(b'{"authorized":true}')

        self.assertTrue(ftp.authenticate(environment, accept))
        self.assertFalse(ftp.authenticate({**environment, "AUTHD_ENCRYPTED": "0"}, accept))
        self.assertFalse(ftp.authenticate(environment, lambda *a, **k: Response(b'{"authorized":"true"}')))
        self.assertFalse(ftp.authenticate(environment, lambda *a, **k: Response(b"not-json")))

    def test_ftp_policy_change_and_outage_close_sessions(self):
        class Response(io.BytesIO):
            status = 200

        environment = {"INTERNAL_API_SECRET": "s" * 32}
        current = lambda *a, **k: Response(b'{"revision":"current"}')
        self.assertEqual(guardian.revision(environment, current), "current")
        self.assertTrue(guardian.unchanged("current", environment, current))
        self.assertFalse(guardian.unchanged("old", environment, current))
        self.assertFalse(guardian.unchanged("current", environment, lambda *a, **k: Response(b"invalid")))
        self.assertFalse(guardian.unchanged("current", {}, current))


if __name__ == "__main__":
    unittest.main()
