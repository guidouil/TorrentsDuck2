"""Install a real RPC password before the engine binds any sockets."""
import base64
import configparser
import hashlib
import os
import re
from pathlib import Path


def configure(root, username, password):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,64}", username or "") or len(password or "") < 24:
        raise ValueError("Set QBT_USERNAME and a QBT_PASSWORD of at least 24 characters")
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
        r"Session\Port": "51413",
        r"Session\UseUPnP": "false",
        r"Session\MaxConnections": "400",
    })
    config["LegalNotice"]["Accepted"] = "true"
    temporary = path.with_suffix(".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        config.write(output, space_around_delimiters=False)
    os.replace(temporary, path)


if __name__ == "__main__":
    configure(os.environ.get("XDG_CONFIG_HOME", "/config"), os.environ.get("QBT_USERNAME"), os.environ.get("QBT_PASSWORD"))
