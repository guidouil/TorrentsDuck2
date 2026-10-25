# Torrents Duck 2

[Français](README.fr.md) · **English** · [Deployment guide](docs/deployment.en.md) · [Contributing](#contributing) · [Apache 2.0](LICENSE)

**An open source, self-hosted platform for sharing torrents, files and server resources within a community.**

Torrents Duck 2 brings members together around one server, one torrent engine and one shared library. Where individual seedboxes divide a server into separate user spaces, this project pools downloads and storage: every addition grows the library for all approved members.

The idea is a lively torrent commons: a community hub where everyone contributes to a shared space. Accounts and permissions control access; files and transfers belong to the collective library.

The project is the successor to [TorrentsDuck](https://github.com/guidouil/TorrentsDuck), originally built with Meteor. This version uses Node.js 24+, Svelte 5, SvelteKit 3 and TypeScript, with Better Auth, PostgreSQL 17, qBittorrent, Nginx and FTPS. It is released under the [Apache 2.0 license](LICENSE).

The entire project was orchestrated with **OpenAI Sol 6.1 Ultra**.

## Features

- **Collective torrents**: search and manage shared transfers through qBittorrent.
- **Shared library**: browse, download and create revocable playback links, with VLC integration.
- **Web and FTPS access**: the same file spaces, available to active, approved accounts.
- **Community administration**: registration approval, account management and a dedicated permission for managing search sources.
- **TV sign-in**: approve a QR code from a phone without typing a password on the TV.
- **Documented operations**: Docker Compose, HTTPS/FTPS, encrypted backups and Meteor account migration.

## One server, one shared library

| Space | Purpose | Member access |
| --- | --- | --- |
| `downloads` | Files managed by qBittorrent | Read through the website and FTPS |
| `share` | Files contributed by the community | Read and write through the website and FTPS |

Both spaces are collective. Removing a torrent keeps its files; deleting its data requires explicit confirmation and affects the whole community.

## Local Docker

With Docker, Compose and npm available, run from the repository root:

```sh
npm run local:up
npm run local:admin
```

`local:up` builds the images and starts the standalone [compose.local.yaml](compose.local.yaml) configuration, without an `.env` file or host-side npm dependency installation. The PostgreSQL schema is initialized automatically. Open [http://127.0.0.1:5180](http://127.0.0.1:5180), then sign in with the test account `admin` and password `local-admin-password` (`admin@example.com`). `local:admin` creates this first administrator and refuses to modify a database that already contains users: run it only on the first launch.

The HTTP origin `http://127.0.0.1:5180` is baked into the image at build time. To change this URL, update `build.args.ORIGIN`, `ORIGIN`, `BETTER_AUTH_URL` and the published port in `compose.local.yaml`, then rebuild with `npm run local:up`.

```sh
npm run local:logs  # Follow logs
npm run local:down  # Stop while keeping data
npm run local:up    # Rebuild and restart after code changes
```

Data remains in named volumes dedicated to this local stack, including after `local:down`. Only the website publishes a port, on `127.0.0.1:5180`; PostgreSQL and qBittorrent RPC stay internal. Port `5180` and Docker subnet `172.30.20.0/24` must be available. Another Torrents Duck stack cannot use this subnet at the same time; stopping its containers without releasing its network is not enough.

This configuration uses fictional credentials for local testing, without Nginx, FTPS or real email delivery. qBittorrent runs on an internal network without access to Internet peers or indexers: engine tests use test torrents, simulated search results and local API calls, without public downloads.

## Usage

### Accounts and approval

Registration is open. Each new account stays on a waiting page, without service access, until an administrator approves it. The address configured in `ADMIN_EMAIL` automatically receives the administrator role when registering; access is activated after email verification.

### TV sign-in

To connect a TV without entering a password on it, choose “Sign in with my phone” on the sign-in page. Scan the QR code, sign in on the phone if needed, compare the code on both screens, then approve the connection. The QR code expires after five minutes and can only be used once. Only approve requests started on your own device. Signing out on one device closes all web sessions for the account, including the TV, and cancels approved QR codes that have not yet been used. Open screens detect the sign-out within a few seconds when their network connection is available. Both devices must be able to reach the same site address, using HTTPS in production.

### VLC playback

In the file browser, “Open in VLC” prepares a revocable playback link valid for six hours. On Android, iPhone and iPad, then tap the dialog's “Open in VLC” button to pass the media to the installed app; the browser may ask for confirmation. The website cannot check whether VLC is installed. Copying the link and downloading the playlist remain available, including on desktop or when the browser blocks opening the app.

### Search and sources

The Search page finds torrents and adds them to collective transfers. The initial catalogue includes The Pirate Bay, Torrents CSV, Nyaa.si and LimeTorrents; Snowfl is available as an optional installation. An administrator can grant selected members the additional “Source manager” permission to install, enable, disable or remove catalogue plugins. The pinned versions are bundled in the qBittorrent image, and their [sources and licenses](deploy/qbittorrent/search/SOURCES.md) are kept in the repository. External indexer availability may vary.

Source managers can also add a source by URL, with detection of JSON, RSS/Atom/Torznab, or HTML containing recognized magnets, torrent files or hashes. Use `{query}` for keywords, or a fixed list or feed filtered by name. Optional HTTP Basic, Bearer or `X-Api-Key` authentication requires HTTPS. URLs and credentials are encrypted on the server; sources and their access are shared among approved members. If detection fails, copy the detection report from Sources or Search when requesting a new adapter. See the [limits and procedure](docs/deployment.en.md#search-and-sources). Apply `db:migrate` on an existing installation to create `search_sources`.

Sorting by seeders, leechers, newest date, size or name, and filtering by minimum seeders and size, happen before pagination over a maximum of 2,000 results; reaching the limit is reported. Search can target one source or all active sources. Dates not provided by the engine remain unknown; Snowfl and LimeTorrents dates are approximate when available.

### Transfer gauges

Transfer gauges use the peak download and upload rates observed by the server. These two maxima are stored in a single PostgreSQL row shared by all browsers and are only replaced when exceeded; no speed history is recorded. On an existing installation, apply the schema with the `db:migrate` command below before restarting the new version.

## Development

Node.js 24+, PostgreSQL 17 and a qBittorrent instance are required. Copy [.env.example](.env.example) to `.env`, choose secrets, and configure `DATABASE_URL`, `QBT_URL`, `ORIGIN` and local paths.

For email, set `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` (a verified Mailgun domain), `MAILGUN_FROM` (for example `Torrents Duck <noreply@mg.example.com>`) and `MAILGUN_API_URL`: `https://api.mailgun.net` for a US domain or `https://api.eu.mailgun.net` for an EU domain. Password reset, verification and registration notification emails use the Mailgun API. Without a Mailgun key, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM` in `.env`. Each registration notifies active, approved administrators with a link to `/admin`; if there is no active administrator, the email is sent to `ADMIN_EMAIL` when configured. Delivery failures are logged without cancelling registration. Keep keys and passwords in `.env`, never in Git.

Set `ADMIN_EMAIL=admin@example.com` to automatically assign the admin role when that account is created, using a case-insensitive address match. The emailed verification link activates access; the waiting page can resend it if delivery fails or the link expires. Other accounts still require administrator approval. An empty value disables automatic assignment; changing the variable does not modify existing accounts.

```sh
npm ci
node --env-file=.env --run db:migrate
npm run dev
```

For local files, set `DATA_ROOT=./data`, `DOWNLOADS_DIR=./data/downloads`, `SHARE_DIR=./data/share` and `FILE_DELIVERY=node`, then create those directories. Set `ORIGIN` and `BETTER_AUTH_URL` to `http://127.0.0.1:5173`, and point `DATABASE_URL` at the PostgreSQL port published on the host (`postgres` is an internal Docker hostname). `npm run dev` loads `.env` automatically at startup; restart the server after changing this file. Create the initial administrator with `node --env-file=.env --run admin:create` and the `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` variables. If migrating Meteor accounts, import them before creating this account: the import requires an empty user table.

### Checks

```sh
npm run check
npm test
npm run build
python3 deploy/test_services.py
node --test scripts/backup.test.mjs
python3 scripts/backup-ftp.test.py
docker compose --env-file .env.example config --no-env-resolution -q
```

`npm test` runs `tests/**/*.test.ts`. Set `TEST_DATABASE_URL` to a dedicated test database to include PostgreSQL tests; without it, they are skipped. Run the full HTTP flow separately with `node --test tests/http-flow.test.mjs`, setting `HTTP_BASE_URL`, `HTTP_ADMIN_LOGIN` and `HTTP_ADMIN_PASSWORD` for a local instance and test administrator. These tests write data: never point them at production.

## Deployment and account migration

Follow the Ubuntu 24.04 LTS and Docker deployment guide in [English](docs/deployment.en.md) or [French](docs/deployment.md), then the [Meteor migration and backup guide (French)](docs/migration-backups.md) if needed. Installation covers ports, secrets, PostgreSQL, HTTPS/FTPS certificates, the first administrator, backups and updates. No script reformats a disk, and no SSH credentials are bundled. PostgreSQL and qBittorrent RPC do not publish ports. HTTP downloads require session authorization before Nginx serves the files.

Both spaces are collective: qBittorrent manages `downloads`, which is readable through the website and FTPS; `share` is writable through both. Explicit FTPS uses port 21000 and requires TLS for commands and data.

An optional encrypted FTP backup can run directly from the server every night, without a Mac running: it includes the full PostgreSQL database and configuration, followed by files from `share` that fit within the quota, starting with the smallest. It is disabled by default; the [backup guide (French)](docs/migration-backups.md#sauvegarde-ftp-automatique-depuis-le-serveur) describes `age` keys, the 100 GB quota, retention and restoration. Downloads and qBittorrent state remain excluded.

Validate the images and server behavior with the guide's checks before opening access. Files and historical torrents from the old server are not included in account migration.

## Contributing

Issues and pull requests are welcome for reproducible problems or focused improvements. Run the checks above before proposing a change. Use fictional data in examples, screenshots and logs; keep production domains, backups, keys and `.env` files out of the repository.

## License

Released under the [Apache 2.0 license](LICENSE), like the original TorrentsDuck project. [Third-party search plugins](deploy/qbittorrent/search/SOURCES.md) retain their BSD, MIT or GPL licenses, included alongside their sources.
