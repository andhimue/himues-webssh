"""
handlers/presets.py — Preset-Export und -Import mit AES-256-GCM Verschlüsselung

Zuständig für:
    - Presets als verschlüsselte JSON-Datei exportieren (POST /presets/export)
    - Verschlüsselte Preset-Dateien importieren (POST /presets/import)

Verschlüsselung: AES-256-GCM mit PBKDF2-HMAC-SHA256 Schlüsselableitung.
Sensitive Felder (Passwörter) werden pro Feld einzeln verschlüsselt.
"""

import json
import logging
import os
from ruamel.yaml.comments import CommentedMap
from aiohttp import web
from .core import load_config, load_config_raw, save_config


# ── Verschlüsselung ───────────────────────────────────────────

def _derive_key(password: str, salt: bytes) -> bytes:
    """
    Leitet einen 256-bit AES-Schlüssel aus Passwort und Salt ab.
    Verwendet PBKDF2-HMAC-SHA256 mit 480.000 Iterationen.
    """
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=480000)
    return kdf.derive(password.encode())


def _encrypt_value(value: str, password: str) -> dict:
    """
    Verschlüsselt einen String mit AES-256-GCM.
    Gibt ein Dict mit salt, nonce und ciphertext (alle hex-kodiert) zurück.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt  = os.urandom(16)
    nonce = os.urandom(12)
    key   = _derive_key(password, salt)
    ct    = AESGCM(key).encrypt(nonce, value.encode(), None)
    return {"salt": salt.hex(), "nonce": nonce.hex(), "ct": ct.hex()}


def _decrypt_value(enc: dict, password: str) -> str:
    """
    Entschlüsselt einen mit _encrypt_value verschlüsselten Wert.
    Wirft ValueError bei falschem Passwort oder beschädigten Daten.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt  = bytes.fromhex(enc["salt"])
    nonce = bytes.fromhex(enc["nonce"])
    ct    = bytes.fromhex(enc["ct"])
    key   = _derive_key(password, salt)
    try:
        return AESGCM(key).decrypt(nonce, ct, None).decode()
    except Exception as e:
        raise ValueError("Falsches Passwort oder beschädigte Datei") from e


# ── Handler ───────────────────────────────────────────────────

EXPORT_FIELDS  = ["title", "category", "host", "port", "username",
                  "private_key", "password", "font"]
ENCRYPT_FIELDS = {"password"}
KEY_ORDER      = ["title", "category", "host", "port", "username",
                  "private_key", "password", "font"]


async def preset_export_handler(request):
    """
    POST /presets/export — Exportiert alle Presets als verschlüsselte JSON-Datei.
    Sensitive Felder (Passwörter) werden einzeln mit AES-256-GCM verschlüsselt.
    Erwartet JSON-Body mit {"password": "..."}
    """
    try:
        body     = await request.json()
        password = body.get("password", "")
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    if not password:
        return web.json_response({"ok": False, "error": "Kein Passwort angegeben"}, status=400)

    config  = load_config()
    presets = config.get("presets", [])

    export_presets = []
    for p in presets:
        ep = {}
        for field in EXPORT_FIELDS:
            if field in p and p[field] is not None and p[field] != "":
                if field in ENCRYPT_FIELDS:
                    ep[field] = {"__encrypted__": True, **_encrypt_value(str(p[field]), password)}
                else:
                    ep[field] = p[field]
        export_presets.append(ep)

    payload = json.dumps({"version": 2, "presets": export_presets},
                         ensure_ascii=False, indent=2)
    return web.Response(
        body=payload.encode(),
        headers={
            "Content-Disposition": 'attachment; filename="webssh-presets.json"',
            "Content-Type": "application/json",
        }
    )


async def preset_import_handler(request):
    """
    POST /presets/import — Importiert eine verschlüsselte Preset-Datei.
    Liest Multipart-Formular mit den Feldern 'password' und 'file'.
    Hängt importierte Presets an die bestehende Liste an.
    """
    try:
        reader   = await request.multipart()
        password = ""
        file_data = b""
        field = await reader.next()
        while field:
            if field.name == "password":
                pw = await field.read(decode=True)
                password = pw.decode() if isinstance(pw, bytes) else pw
            elif field.name == "file":
                file_data = await field.read()
            field = await reader.next()
    except Exception as e:
        return web.json_response({"ok": False, "error": f"Lesefehler: {e}"}, status=400)

    if not password:
        return web.json_response({"ok": False, "error": "Kein Passwort angegeben"}, status=400)
    if not file_data:
        return web.json_response({"ok": False, "error": "Keine Datei"}, status=400)

    try:
        data = json.loads(file_data.decode())
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültige JSON-Datei"}, status=400)

    raw_presets = data.get("presets", [])
    if not isinstance(raw_presets, list):
        return web.json_response({"ok": False, "error": "Ungültiges Format"}, status=400)

    imported = []
    try:
        for p in raw_presets:
            ep = {}
            for k, v in p.items():
                if isinstance(v, dict) and v.get("__encrypted__"):
                    ep[k] = _decrypt_value(v, password)
                else:
                    ep[k] = v
            imported.append(ep)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

    raw_config = load_config_raw()
    existing   = list(raw_config.get("presets", []))

    for p in imported:
        cm = CommentedMap()
        for key in KEY_ORDER:
            if key in p and p[key] is not None and p[key] != "":
                cm[key] = p[key]
        for key, val in p.items():
            if key not in KEY_ORDER:
                cm[key] = val
        existing.append(cm)

    raw_config["presets"] = existing
    save_config(raw_config)
    logging.warning(f"Presets importiert: {len(imported)} Einträge")
    return web.json_response({"ok": True, "count": len(imported)})