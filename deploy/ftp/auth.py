#!/usr/bin/python3
"""Fail closed; never emit a credential or an HTTP response body to logs."""
import json
import os
import urllib.request


def authenticate(environment, opener=urllib.request.urlopen):
    secret = environment.get("INTERNAL_API_SECRET", "")
    username = environment.get("AUTHD_ACCOUNT", "")
    password = environment.get("AUTHD_PASSWORD", "")
    if len(secret) < 32 or not username or not password or environment.get("AUTHD_ENCRYPTED") != "1":
        return False
    request = urllib.request.Request(
        environment.get("FTP_AUTH_URL", "http://web:3000/api/internal/ftp-auth"),
        data=json.dumps({"username": username, "password": password}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret},
        method="POST",
    )
    try:
        with opener(request, timeout=8) as response:
            body = response.read(4097)
            return response.status == 200 and len(body) <= 4096 and json.loads(body).get("authorized") is True
    except Exception:
        return False


if __name__ == "__main__":
    if authenticate(os.environ):
        print("auth_ok:1\nuid:10000\ngid:10000\ndir:/data\nend")
    else:
        print("auth_ok:-1\nend")
