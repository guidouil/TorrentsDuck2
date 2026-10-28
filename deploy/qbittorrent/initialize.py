"""Install a real RPC password before the engine binds any sockets."""
import base64
import configparser
import hashlib
import json
import os
import re
from pathlib import Path


def configure(root, username, password, peer_port):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,64}", username or "") or len(password or "") < 24:
        raise ValueError("Set QBT_USERNAME and a QBT_PASSWORD of at least 24 characters")
    if not re.fullmatch(r"[1-9][0-9]{3,4}", peer_port or "") or not 1024 <= int(peer_port) <= 65535:
        raise ValueError("Set QBT_PEER_PORT to an integer from 1024 to 65535")
    config = configparser.ConfigParser(interpolation=None, strict=False, delimiters=("=",))
    config.optionxform = str
    path = Path(root) / "qBittorrent" / "qBittorrent.conf"
    path.parent.mkdir(parents=True, exist_ok=True)
    config.read(path)
    for section in ("Preferences", "BitTorrent", "LegalNotice"):
        if section not in config:
            config[section] = {}
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, 100000, 64)
    encoded = base64.b64encode(salt).decode() + ":" + base64.b64encode(key).decode()
    config["Preferences"].update({
        r"WebUI\Username": username,
        r"WebUI\Password_PBKDF2": "@ByteArray(" + encoded + ")",
        r"WebUI\Address": "172.30.20.2",
        r"WebUI\Port": "8080",
        r"WebUI\LocalHostAuth": "true",
        r"WebUI\AuthSubnetWhitelistEnabled": "false",
        r"WebUI\HostHeaderValidation": "true",
        r"WebUI\ServerDomains": "qbittorrent",
        r"WebUI\CSRFProtection": "true",
        r"WebUI\UseUPnP": "false",
    })
    config["BitTorrent"].update({
        r"Session\DefaultSavePath": "/data/downloads",
        r"Session\Port": peer_port,
        r"Session\UseUPnP": "false",
        r"Session\MaxConnections": "400",
    })
    config["LegalNotice"]["Accepted"] = "true"
    temporary = path.with_suffix(".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        config.write(output, space_around_delimiters=False)
    os.replace(temporary, path)


def install_search_sources(data_root, sources_root):
    sources = Path(sources_root)
    engines = Path(data_root) / "qBittorrent" / "nova3" / "engines"
    marker = engines.parent / ".torrentduck-sources-initialized"
    if marker.exists():
        return
    engines.mkdir(parents=True, exist_ok=True)
    for source in json.loads((sources / "catalog.json").read_text()):
        if source["initial"]:
            temporary = engines / (source["id"] + ".new")
            temporary.write_bytes((sources / (source["id"] + ".py")).read_bytes())
            try:
                os.link(temporary, engines / (source["id"] + ".py"))
            except FileExistsError:
                pass
            finally:
                temporary.unlink()
    marker.touch()


if __name__ == "__main__":
    configure(os.environ.get("XDG_CONFIG_HOME", "/config"), os.environ.get("QBT_USERNAME"), os.environ.get("QBT_PASSWORD"), os.environ.get("QBT_PEER_PORT", "42420"))
    install_search_sources(os.environ.get("XDG_DATA_HOME", "/config/data"), "/usr/local/share/torrentduck/search")
