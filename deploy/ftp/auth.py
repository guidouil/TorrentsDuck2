#!/usr/bin/python3
"""Fail closed; never emit a credential or an HTTP response body to logs."""
import json
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
            if response.status == 200 and len(body) <= 4096:
                policy = json.loads(body)
                if policy.get("authorized") is True and policy.get("role") in ("member", "admin"):
                    return policy["role"]
    except Exception:
        return False
