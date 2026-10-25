# Bundled search plugins

These are separate third-party qBittorrent search plugins, reviewed and copied
into the image rather than downloaded as executable code at runtime. Their
original licence notices are retained. No third-party Python package is needed.

| File | Version | Source | Licence | SHA256 |
| --- | --- | --- | --- | --- |
| `piratebay.py` | 3.10 | [qBittorrent search-plugins, commit 2beb5c6](https://github.com/qbittorrent/search-plugins/blob/2beb5c67b0edbf2387a031a02d1881fab4bec3c3/nova3/engines/piratebay.py) | BSD 3-clause, included in file | `b37f13d21ff5f22ff2154a497cd3ed2d727784024d09d393c1bead88e438dab5` |
| `torrentscsv.py` | 1.8 | [qBittorrent search-plugins, commit 2beb5c6](https://github.com/qbittorrent/search-plugins/blob/2beb5c67b0edbf2387a031a02d1881fab4bec3c3/nova3/engines/torrentscsv.py) | BSD 3-clause, included in file | `7c7c8a54249e5f2ce237df6421a735a5c1bd7acefd1304d736ee8f925fd6031b` |
| `nyaasi.py` | 1.3 | [MadeOfMagicAndWires/qBit-plugins, commit f84b6cb](https://github.com/MadeOfMagicAndWires/qBit-plugins/blob/f84b6cb5efe38f60f9d64c718392fd2ae41383a3/engines/nyaasi.py) | [GPL 3 or later](LICENSE.nyaasi) | `8b38deb7d22d86c3d64300cd58d55810260ea61b96b0fd552c3748201de44e46` |
| `limetorrents.py` | 4.15.1 (local adaptation) | [qBittorrent search-plugins, commit 2beb5c6](https://github.com/qbittorrent/search-plugins/blob/2beb5c67b0edbf2387a031a02d1881fab4bec3c3/nova3/engines/limetorrents.py) | [GPL 2](LICENSE.limetorrents) | `4cb099eb00d6772fbcba6e8490644c95223722757f390df6dadd35e163a572a3` |
| `snowfl.py` | 2.1 | [ChocoTonic/snowfl v2.1 release artifact](https://github.com/ChocoTonic/snowfl/releases/tag/v2.1) | [MIT](LICENSE.snowfl) | `58e17e41590dd362cbee0f148f896b2b72bcaba619cfd5d9da3673dbe8c6942c` |

The LimeTorrents file is adapted locally from upstream version 4.15 (original
SHA256 `aca3fbc4956970474a66295f5e61f02532bcdf5399ae97c144bf826a7c8fddce`).
The original emits description-page URLs that need another HTTP request before
addition. Our parser instead turns the strict 40-digit hexadecimal hash already
present in each `itorrents.net/torrent/<hash>.torrent` search link into a magnet.
Rows with no usable hash are omitted, and the unused page-resolution method is
removed. The upstream authors and GPL licence are retained. Relative publication
ages from LimeTorrents and Snowfl provide approximate dates only.

`catalog.json` is shared by the website and bootstrap. Only entries with
`initial: true` are installed automatically. The first bootstrap copies them to
`$XDG_DATA_HOME/qBittorrent/nova3/engines` without overwriting existing plugins,
then writes `.torrentduck-sources-initialized` in `nova3`. Later restarts preserve
removed plugins and qBittorrent's enabled/disabled settings.

The bootstrap order is compatible with
[qBittorrent 5.1.0's `SearchPluginManager`](https://github.com/qbittorrent/qBittorrent/blob/release-5.1.0/src/base/search/searchpluginmanager.cpp#L89):
its constructor calls `updateNova()` before discovering engines with `update()`.
`updateNova()` creates `nova3/__init__.py` and `nova3/engines/__init__.py`, then
copies only its five core helper files. It does not delete the existing engine
files. Discovery subsequently reads the stored disabled-engine list. Thus the
initial plugins can be copied before qBittorrent starts; no Python package
marker needs to be provided by the bootstrap itself.

To update or add a plugin, review its code and licence, pin its upstream revision,
update this file and the catalogue, run `python3 deploy/test_services.py`, rebuild
qBittorrent, then install the bundled version from the Sources interface. Do not
enable automatic remote plugin updates or accept user-provided Python URLs.

On 2026-10-25, harmless `ubuntu` search requests returned usable JSON from APiBay
and Torrents CSV and HTML with a magnet from Nyaa.si. The LimeTorrents search
page and one Ubuntu detail page returned HTTP 200; its live listing was parsed
offline into 40 magnets, and the first hash matched the magnet on its detail
page. Snowfl's homepage returned
HTTP 520 from the validation environment, so it is available in the catalogue but
is not installed initially. These checks downloaded no torrent or payload and do
not establish availability from the deployment host. All plugins also have
offline parsing tests; domain changes, blocks and upstream failures can still
require a reviewed plugin update.
