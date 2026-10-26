# Deploy on Ubuntu 24.04 LTS

[Français](deployment.md) · [English](deployment.en.md)

To try the project on your computer with Docker, follow the [local Docker section in the README](../README.md#local-docker): run `npm run local:up`, then `npm run local:admin` on the first launch. This standalone stack uses test data and fictional credentials at [http://127.0.0.1:5180](http://127.0.0.1:5180), without Nginx, FTPS, real email delivery or Internet BitTorrent peers.

The local image is built for `http://127.0.0.1:5180`: do not reuse it in production. The deployment below keeps its network and Nginx reverse proxy unchanged.

This guide installs Torrents Duck 2 on a **fresh Ubuntu Noble 24.04 LTS amd64 host**, using Docker Engine. Node and PostgreSQL are not required on the host: services run in containers. All domains, addresses and accounts below are examples to replace. No project script reinstalls the operating system or formats a disk.

When replacing a Meteor installation, back up the accounts and test their restoration first; see the [migration and backup guide (French)](migration-backups.md). Account migration excludes historical downloads, torrents and chat messages.

## 1. Prepare the host and SSH access

Configure a public key for the SSH administration account. Check a second session before disabling password authentication. Keep access to the provider's console.

Check disks with `lsblk` and, if using RAID, its diagnostic tools and `cat /proc/mdstat`. Provide persistent storage for `/srv/torrentduck`, swap appropriate for available memory, and at least 10% free space on the data volume. If using a dedicated volume, register its UUID in `/etc/fstab` and check that it is mounted before continuing. Keep backups on a separate machine.

```sh
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git python3 age iptables openssl ufw
```

Complete any required operating system restart before proceeding.

## 2. Install Docker Engine and Compose

Install Docker from its [official Ubuntu APT repository](https://docs.docker.com/engine/install/ubuntu/). On an existing host, review running services and follow the conflicting packages section before continuing.

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
sudo docker compose version
```

Compose must support `gw_priority` (2.33.1 or later). Use Docker's **iptables** backend; `iptables-nft` is compatible with the project's rules. This guide uses `sudo` for Docker commands. Membership of the `docker` group grants administrative access to the host.

## 3. Open the required ports

First adjust the SSH port if the server uses a port other than `22`, and preserve rules needed by existing services. On the fresh host:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 21000/tcp
sudo ufw allow 50000:50100/tcp
sudo ufw allow 51413/tcp
sudo ufw allow 51413/udp
sudo ufw enable
sudo ufw status verbose
```

Check a new SSH connection after enabling the firewall. Mirror these openings in the provider's firewall, if any. Port `21000` and range `50000–50100` are used for explicit FTPS; `51413` is used for BitTorrent peers. PostgreSQL `5432` and qBittorrent RPC `8080` remain internal to Docker.

**Only if this host already runs a public DNS service**, preserve its TCP and UDP DNS ports as well:

```sh
sudo ufw allow 53/tcp
sudo ufw allow 53/udp
```

Torrents Duck does not require a local DNS server. Docker's published ports can bypass UFW rules: see [Docker firewall limitations](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations). The dedicated policy in step 5 complements UFW and must be applied before qBittorrent starts.

## 4. Clone and configure the project

```sh
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 755 /opt/torrentduck
git clone https://github.com/guidouil/TorrentsDuck2.git /opt/torrentduck
cd /opt/torrentduck
umask 077
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Edit `.env` with a text editor. Run `openssl rand -hex 32` again for each secret to obtain distinct values. Compose reads this file directly: **do not execute it or load it with `source` or `. .env`**.

| Variable | Configuration |
| --- | --- |
| `DOMAIN` | Public hostname, for example `duck.example.com`. |
| `ORIGIN`, `BETTER_AUTH_URL` | The same HTTPS URL, for example `https://duck.example.com`. |
| `PUBLIC_IPV4` | The host's actual public IPv4; `203.0.113.10` is only a documentation example. |
| `DATA_ROOT` | `/srv/torrentduck` for the commands in this guide. |
| `POSTGRES_ADMIN_PASSWORD` | PostgreSQL superuser secret, separate from the application password. |
| `POSTGRES_PASSWORD` | Hexadecimal secret for the `duck` application role. |
| `DATABASE_URL` | `postgresql://duck:PASSWORD@postgres:5432/duck`, using exactly the value of `POSTGRES_PASSWORD`. |
| `BETTER_AUTH_SECRET`, `INTERNAL_API_SECRET` | Two other independent secrets. |
| `QBT_USERNAME`, `QBT_PASSWORD` | Internal RPC username and a secret at least 24 characters long. The username accepts ASCII letters, digits, dot, hyphen and underscore. |
| `ACME_EMAIL` | Certificate contact address, for example `admin@example.com`. |
| `ADMIN_EMAIL` | Email of the future administrator signing up, for example `admin@example.com`; an empty value disables automatic assignment. |

Configure email before opening the service: `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM` and `MAILGUN_API_URL` (`https://api.mailgun.net` for the US region, `https://api.eu.mailgun.net` for Europe). The sending domain must be verified in Mailgun. Without a Mailgun key, use the `SMTP_*` variables described in the [README](../README.md). Email is used for address verification, password resets and registration notifications.

Create an A record for `duck.example.com` pointing to the server's IPv4 in your domain's DNS zone. Wait for propagation before requesting the certificate. Publish an AAAA record only after preparing and testing IPv6; the torrent engine is restricted to IPv4.

## 5. Prepare data directories, firewall and images

Check that subnets `172.30.10.0/24`, `172.30.11.0/24`, `172.30.20.0/24`, `172.30.30.0/24`, `172.30.40.0/24` and `172.30.50.0/24` are available. If they conflict with existing networks, update `compose.yaml` and `deploy/firewall.sh` together before starting services. If using a different `DATA_ROOT`, adjust the directory paths below.

```sh
sudo install -d -o 10000 -g 10000 -m 755 /srv/torrentduck/downloads /srv/torrentduck/share /srv/torrentduck/qbittorrent
sudo install -d -m 700 /srv/torrentduck/postgres /srv/torrentduck/certificates /srv/torrentduck/ftp-tls
sudo install -d -m 755 /srv/torrentduck/acme
sudo docker compose config -q
sudo sh deploy/firewall.sh
sudo docker compose build --pull
```

`deploy/firewall.sh` uses `DOCKER-USER` and `INPUT` to block connections initiated by qBittorrent to the host, private networks, loopback, link-local, CGNAT, metadata and reserved ranges. Docker DNS and replies to the application's RPC requests remain available. The engine must always start after this policy. The qBittorrent container uses Debian amd64 packages independently of the Ubuntu host; its RPC credentials are configured before its first start.

## 6. Initialize PostgreSQL and the schema

Complete this step **before certificate issuance and the public startup of Nginx/FTPS**:

```sh
sudo docker compose up -d --wait postgres
sudo docker compose run --rm --no-deps --entrypoint node web --import tsx scripts/migrate-db.ts
```

Initialization creates an application role limited to its database. Initialization passwords apply only to a new PostgreSQL data volume.

If migrating Meteor accounts, now follow the [migration guide (French)](migration-backups.md): validate the archive, import into this still-empty database, and check the accounts and their permissions. Complete the import before any registration or administrator creation; it requires an empty user table. A fresh installation can proceed directly to the next step.

## 7. Obtain the certificate and start services

Check that public DNS points to the host and that TCP `80` is reachable from the Internet. From `/opt/torrentduck`:

```sh
sudo sh scripts/deploy-certificates.sh issue
sudo sh scripts/deploy.sh
```

The first command reads `ACME_EMAIL` from `.env` through Compose. To override it once, use `sudo ACME_EMAIL=admin@example.com sh scripts/deploy-certificates.sh issue`. The ACME challenge uses a temporary Nginx on port 80; after issuance, the script prepares the FTPS PEM and starts Nginx/FTPS and their dependencies with the schema already initialized.

`scripts/deploy.sh` installs systemd units, applies the firewall, builds images, waits for PostgreSQL, applies migrations and starts the stack. It also enables startup at boot, the renewal timer and the FTP backup timer; backup transfers remain disabled while `BACKUP_FTP_ENABLED=false`. It preserves existing data and does not create an implicit administrator.

On a fresh installation, sign up on the site using the address configured in `ADMIN_EMAIL`, then follow the email verification link to activate the administrator. The waiting page can resend this link. Other accounts wait for administrator approval. Changing `ADMIN_EMAIL` later does not change existing accounts. A registration notifies active, approved administrators; if none exist, `ADMIN_EMAIL` receives the notification when configured. Sending failures are logged and do not cancel registration.

## 8. Check the installation

```sh
sudo docker compose ps
sudo docker compose logs --tail=100 web nginx ftp qbittorrent postgres
sudo docker compose exec -T nginx nginx -t
sudo systemctl status torrentduck.service torrentduck-firewall.service --no-pager
sudo systemctl list-timers torrentduck-certificates.timer --no-pager
sudo systemctl list-timers torrentduck-backup.timer --no-pager
curl -fsS https://duck.example.com/api/health
```

`active (exited)` is normal for the oneshot units; `docker compose ps` shows container status. `/api/health` confirms an HTTP response from the application and does not replace database, torrent and FTP checks.

Before opening access to members:

- In a private browser window, check that lists, downloads and playback are denied; `/_protected/...` and `/api/internal/ftp-auth` must return 404 from the Internet.
- Test registration, the waiting page, first administrator verification, email delivery and member approval. After an import, check accounts, permissions, an accented username, email sign-in, password hash upgrade, password reset and revocation.
- Add an authorized public test torrent; check progress, stop/resume, persistence after restart and both deletion modes. Test search, sorting, pagination, chat and SSE reconnection.
- On Search, run a query, add a result to transfers and check failures from an unavailable source. Grant and revoke the Source manager permission on a member: source administration must work only while granted, without access to accounts or backups. Also check that the APIs reject ordinary, pending and disabled members.
- In a signed-out browser, display the login QR code and scan it with a phone. Check that signing in on the phone returns to confirmation, compare the codes, explicitly approve, and verify that the first browser signs in automatically. Also test denial and expiry after five minutes; pending or disabled accounts must not be able to approve a device. Use the same HTTPS site address on both devices.
- Sign in to the same account in several browsers, including the TV, then sign out from one: all its web access must be denied immediately and open screens must return to sign-in within a few seconds. Check that an approved but unused QR code cannot reconnect the TV and that another account stays signed in.
- Test video seeking, a VLC link, its revocation and expiration, and a format unsupported by the browser. On Android, iPhone and iPad (including desktop mode), check the “Open in VLC” button in the link dialog with VLC installed; also check that copying the link remains available without VLC.
- On the website, check that an active, approved administrator can delete a file or folder from `downloads` after confirmation and that an ordinary member cannot, including through the API. Deletion is permanent for the whole community; files still managed by qBittorrent may be reported missing or downloaded again.
- In FileZilla/Cyberduck, require **explicit FTP over TLS**, using the certificate hostname and port `21000`. Check downloads and writes to `share`. In `downloads`, check that administrators can delete files and folders and members cannot, and that uploads, renaming and creation are denied for both roles. Reject plain FTP and unencrypted data channels.
- Disable a connected member or revoke an administrator's role: all FTPS sessions must close within a few seconds, and new connections must enforce the updated permissions. Unavailability of the internal API must also close sessions.
- From the qBittorrent container, check that `169.254.169.254`, `172.30.20.1` and PostgreSQL's private address are unreachable, while a public tracker and RPC access from `web` work. Repeat after a host restart.
- On a test volume, simulate the 10% free-space threshold: new transfers/uploads, including FTPS, must be rejected before the disk fills.
- Create an encrypted backup outside the host, restore it into an empty test database, and verify an account with a known password.

These checks require actual verification of certificates, passive ports, storage, performance and restoration on the host or an equivalent machine. This documentation does not certify that they have passed.

## Search and sources

The Search page combines qBittorrent plugins with URL sources parsed by the web
server, allowing one active search per member,
four simultaneous searches for the site, a maximum duration of 90 seconds and
five-minute result retention. Jobs belong to the account that created them;
adding a result reuses the permissions, author attribution and disk reserve of
manual torrent addition.
Search ownership stays in memory in the single web process, so results are not
restored after it restarts. Multiple web replicas would require shared job
storage.

Sorting by seeders, leechers, recent date, descending size or name and filtering
by minimum seeders and minimum/maximum size happen before pagination, across at
most the first 2,000 results returned by the engine. The page reports when this
limit is reached; sorting does not cover results beyond that limit. Choose one
source or all sources before starting the search. Size filters use GiB. A date
missing from the engine response stays unknown; Snowfl and LimeTorrents dates, when available,
are approximate because they are derived from the site's relative age values.

The qBittorrent image contains five pinned plugins: The Pirate Bay (general
index through APiBay), Torrents CSV (general index), Nyaa.si (anime and Asian
content), LimeTorrents (general index), and Snowfl (aggregator). The first start of this version installs the
first four without replacing existing files. Snowfl remains optional: its
homepage returned HTTP 520 during validation on 25 October 2026. The other sources
responded to a test query from the validation environment; availability from the
deployment host still needs checking. No content was downloaded in these checks.

The LimeTorrents plugin is adapted locally to produce magnets from the hashes
already present in search-list links. It sends no HTML description page to
torrent addition and omits rows without a valid hash. If sources have already
been initialized on the volume, install LimeTorrents from Sources after rebuilding
the image; the first-start marker preserves existing choices.

An administrator can grant the additional **Source manager** permission
(`canManageSources`) from the member list. An active, approved member with this
permission can add URL sources, test them, install bundled catalogue versions,
enable, disable and remove sources. Administrators always have access. This permission grants no account
or backup administration. Revocation is checked on every API call.

To add a URL source from **Search → Sources**:

1. Enter a name and search URL, replacing keywords with `{query}`, for example
   `https://example.org/search?q={query}`. A URL without the placeholder is
   treated as a fixed list or feed, filtered by result name.
2. Optionally choose HTTP Basic (username/password), Bearer, or an API key sent
   in `X-Api-Key`. Authenticated requests require HTTPS.
3. Choose **Analyze and add**. The check uses `ubuntu` and recognizes JSON,
   RSS/Atom/Torznab, and HTML containing magnets, torrent links or recognized
   hashes. **Test** checks an existing source again.

URL sources execute no code supplied by their manager. Authenticated access is
shared: all approved members can search them and add their results to shared
transfers. Only managers and administrators modify sources. The browser receives
only their public origin and opaque result references; complete URLs, query
parameters and credentials stay on the server.

There is a limit of ten URL sources, 2 MiB responses and a total timeout of
30 seconds per request. Private addresses are rejected, and redirects cannot
change origin or downgrade HTTPS to HTTP. Torrent files can reach 8 MiB;
credentials are sent only to the configured origin, never another file host.

On failure, use **Copy** on the v1 detection report and share it to request an
adapter. It describes HTTP status, type, size and response structure, with no raw
body, cookie, password, token or parameter value. Reports are not stored in the
database, and their HTTP responses use `Cache-Control: no-store`.
Site-specific login forms, JavaScript pages and captchas require an
adapter; an unknown page is not added.

The replayable `db/001-initial.sql` schema creates `search_sources` during the
normal deployment migration. Full URL source configuration is encrypted with
AES-256-GCM using a key derived from `BETTER_AUTH_SECRET`. Keep that secret;
after rotating it, remove and re-add URL sources with their credentials.

Catalogue plugins execute Python inside qBittorrent. The interface accepts
declarative search URLs, but no URL of Python code to install. Files, versions,
licences and checksums are recorded in
[`deploy/qbittorrent/search/SOURCES.md`](../deploy/qbittorrent/search/SOURCES.md).
A new plugin or plugin code update requires review, an image rebuild and installation
from the catalogue; remove and reinstall an existing plugin to replace its code.
Removed and disabled sources stay that way after a restart.
The `compose.local.yaml` stack keeps qBittorrent on an internal network without
Internet indexer access. URL sources use the `web` network connection; local tests
still use simulated responses.

## Operations, certificates and backups

```sh
sudo systemctl restart torrentduck.service
sudo systemctl start torrentduck-certificates.service
```

Restarting the stack interrupts services and ongoing transfers. The timer checks certificates twice daily, with a random delay of up to one hour. Renewal updates the FTPS PEM, checks the certificate and key, reloads Nginx and restarts the FTPS server; active FTPS sessions may be interrupted. After changing Docker or firewall rules, reapply `sudo sh deploy/firewall.sh` before restarting torrents. The dedicated unit is installed before Docker to apply this policy at boot.

Test ACME renewal without replacing the production certificate or adding another random delay; replace `duck.example.com` with the value of `DOMAIN` in `.env`:

```sh
sudo docker compose --profile maintenance run --rm certbot renew --cert-name duck.example.com --dry-run --webroot -w /var/www/acme --no-random-sleep-on-renew
```

The FTPS guard checks permissions every 5 seconds, with a maximum HTTP timeout of 3 seconds. Disabling or deleting an account, or changing its password or role, closes **all** FTPS sessions, including other members' sessions. Clients must reconnect and restart transfers. When the policy is unavailable, the container waits for the application before reopening its listener. `downloads` is mounted writable in `web` and `ftp` to support deletion restricted to administrators; Nginx keeps it read-only. Application checks still forbid uploads, renaming and creation in `downloads`. In `share`, FTPS uploads are published atomically without overwriting an existing file; appending and resuming partial uploads are refused. Interrupted uploads must start again using `STOR` and an unused filename; `STOU` is refused. To switch FTPS accounts, disconnect and reconnect.

Docker logs are limited to 3 × 10 MB per service. Nginx disables its access log to protect playback and recovery link tokens. The application has no access to the Docker socket.

The CPU card on the Transfers page measures Web, qBittorrent, PostgreSQL, Nginx and FTPS as a percentage of the host's total CPU capacity (100% = all cores busy). It compares the [cgroup v2 `cpu.stat` counters](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#cpu-interface-files) between shared snapshots, about every 3 seconds while the page is open. `compose.yaml` places each service in a `torrentduck-<service>.slice` and mounts `/sys/fs/cgroup` read-only in `web`; it adds no write access or Docker socket. These readings use Ubuntu 24.04's `systemd` cgroup driver and cgroup v2: check `sudo docker info --format '{{.CgroupVersion}} {{.CgroupDriver}}'` (expected: `2 systemd`). After updating, deployment must recreate the containers to apply these settings. The first reading, a missing service or another configuration shows an unavailable value; the local Docker stack keeps its portable configuration and does not provide these counters. Disk usage and the 10% reserve are calculated on the filesystem containing `DOWNLOADS_DIR` (the `downloads` directory under the host's `DATA_ROOT`), so they describe the data disk even when it is mounted separately from the operating system. Used space excludes free space reserved by the filesystem; the application's 10% threshold is unchanged.

On a backup workstation with Node 24, `age` and suitable SSH credentials, create an `age` key outside the repository, keep a second protected copy of the private key, then use its public recipient:

```sh
umask 077
mkdir -p "$HOME/.config/torrentduck" "$HOME/TorrentsDuck-backups"
age-keygen -o "$HOME/.config/torrentduck/backup-identity.txt"
age-keygen -y "$HOME/.config/torrentduck/backup-identity.txt"
node scripts/backup.mjs --host backup-host --recipient age1… --directory "$HOME/TorrentsDuck-backups" --keep 14
```

Replace `backup-host` with a configured SSH alias and `age1…` with the public key obtained above. The remote account must read configuration files and use Docker, granting it administrative access to the host. The [backup guide (French)](migration-backups.md) explains these permissions and restoration checks. This SSH backup contains PostgreSQL and configuration; downloads, shared files and torrent state are excluded. The latest registered backup appears in the administration interface; without another backup, this date ages when the workstation is offline.

### Optional automatic FTP backup

The server can upload its own encrypted archive without relying on the backup workstation. It uses Python 3, Docker Compose and `age` on the host; only the public `age1…` recipient obtained above belongs on the server. If no key exists yet, create it on the backup workstation first using the [backup guide (French)](migration-backups.md#clé-de-sauvegarde-sur-le-mac). Keep the private key and its second protected copy off this host. Leave `BACKUP_FTP_ENABLED=false` until `BACKUP_AGE_RECIPIENT` is set: FTP credentials alone are insufficient.

Edit these variables in `.env` without loading the file into the shell; Compose resolves them in `x-backup-ftp`. Never display the resolved configuration containing credentials.

| Variable | Value |
| --- | --- |
| `BACKUP_FTP_ENABLED` | `true` to enable; `false` by default. |
| `BACKUP_FTP_HOST`, `BACKUP_FTP_USER`, `BACKUP_FTP_PASSWORD` | Host and credentials supplied by the backup service. |
| `BACKUP_FTP_PORT` | `21` by default. |
| `BACKUP_FTP_TLS` | `false` by default; `true` requires explicit FTPS with certificate verification. |
| `BACKUP_FTP_DIRECTORY` | `torrents-duck` by default; a directory dedicated to this installation. |
| `BACKUP_AGE_RECIPIENT` | Public `age1…` recipient; never the private key. |
| `BACKUP_FTP_QUOTA_BYTES` | `100000000000` by default (100 decimal GB). |
| `BACKUP_FTP_KEEP` | `1` by default. |

The archive contains the full database and configuration, followed by regular `share` files in ascending size order within the remaining space. `backup-manifest.json` records selected files, the count and size excluded for lack of space, and the count of entries excluded for safety; `downloads` and qBittorrent state remain excluded. Each archive has a budget of at most `quota / (keep + 1)`, or 50 GB by default, to keep the previous copy during upload. Other files in the FTP directory count too; reduce the quota if the same account has other uses. The script uploads under a `.partial` name, checks its size, renames it, then reads back the entire remote archive to compare its SHA256 with the local copy. This check requires a full network round trip for the archive. Success must be registered with the application before the script removes its own old archives.

A temporary encrypted archive is prepared in `DATA_ROOT/backup-ftp`, with its budget calculated initially to leave 10% free disk space; the plaintext dump and configuration stay in `/dev/shm`. After deployment, the timer runs daily at 03:30 in the server's time zone, with a random delay of up to 30 minutes. Test an upload and an isolated restore following the [backup guide (French)](migration-backups.md#sauvegarde-ftp-automatique-depuis-le-serveur):

```sh
sudo systemctl start torrentduck-backup.service
sudo journalctl -u torrentduck-backup.service -n 50 --no-pager
```

For Dedibackup, upload from the Dedibox network and keep at most 1,000 files on the account. FTP without TLS sends credentials in plaintext; `age` protects archive contents. Follow the parameters and constraints in [Scaleway's documentation](https://www.scaleway.com/en/docs/dedibox/how-to/use-dedibackup-ftp-backup/). This outgoing FTP connection is independent of mandatory FTPS for members.

## Update the installation

For routine updates of a Git checkout installed in `/opt/torrentduck`, copy the script once into the account that owns the checkout:

```sh
cd /opt/torrentduck
install -m 755 scripts/update.sh "$HOME/deploy-torrentduck.sh"
"$HOME/deploy-torrentduck.sh"
```

For later updates, run `~/deploy-torrentduck.sh`, **without sudo before the script**. Git uses the current account; sudo requests its password for Docker and system operations. The checkout must have a branch with an upstream configured. The script rejects concurrent deployments and local changes, including untracked files that are not ignored, then runs `git pull --ff-only` and calls `scripts/deploy.sh`: image builds, schema, firewall and systemd units remain managed by the existing procedure. It then recreates Nginx to apply its template and checks `/api/health` through public HTTPS. Web and FTPS sessions may be interrupted.

Administrator deletion in `downloads` requires this full update to rebuild the images and recreate the `web` and `ftp` containers with their new mounts; restarting alone is insufficient.

Cleanup runs before building and on exit, including failures: only untagged project images that are no longer used by any container are removed. Unused build cache in the default Docker builder is reduced with `--keep-storage 1GB`; this cache is shared with any other projects on the host. The script requires at least 10% free plus 5 GiB on the Docker filesystem before building. It creates no archive or backup image tag and removes no volume, shared file, download or existing backup. Output stays in the terminal.

Keep regular off-host backups and test their restoration separately: this script does not create one for every deployment. It does not automatically pull new PostgreSQL or Certbot images; update those as a maintenance operation. Review any new `.env.example` variables before deploying. Preserve `.env`, `DATA_ROOT` and existing secrets, particularly `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_PASSWORD` and the password in `DATABASE_URL`: changing only these variables does not change the passwords of an initialized database. Rotation must coordinate PostgreSQL and application configuration. Keep PostgreSQL on major version 17 for this procedure; a major version upgrade requires a dedicated migration. Repeat the functional checks after updating.

## Protocol tests on a test instance

On a development or test machine, with Docker accessible to the account running Python:

```sh
docker compose --env-file .env.example build
docker run --rm --entrypoint python3 -v "$PWD/deploy/ftp:/checks:ro" torrentduck-ftp /checks/test_server.py
python3 tests/infrastructure.integration.py
```

The command inside the FTPS image tests paths, uploads, the disk reserve and renames using temporary files, without connecting to an existing service.

The test requires **the available subnet `172.30.20.0/24` and free local ports `50000–50100`**. A production stack already uses these resources: use a separate test instance. The script creates and removes its `duck-infra-…` containers and temporary network; it does not modify the host firewall.

It exercises protected RPC, torrent addition/stop/resume and qBittorrent persistence, Nginx X-Accel and `Range` requests, mandatory FTPS TLS, member and administrator permissions in `downloads`, writes/renames/deletions in `share` and session revocation. The torrent is a local fixture without a tracker, with DHT/PEX/local discovery disabled. The self-signed certificate is limited to this test. The authentication API is simulated; application tests cover accounts and permissions separately. This test does not verify public ACME, external passive routing, the Linux firewall, Internet peers or host performance.
