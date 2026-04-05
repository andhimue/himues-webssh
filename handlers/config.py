"""
handlers/config.py — Konfiguration lesen und schreiben

Zuständig für:
    - GET  /config       — gesamte Konfiguration lesen
    - PATCH /config      — Konfigurationswerte setzen
    - GET  /presets/hash — Hash der Presets für Cache-Invalidierung
"""

import hashlib
import json as _json
import io
import logging
import re as _re
from ruamel.yaml.comments import CommentedMap

from aiohttp import web

from .core import load_config, load_config_raw, save_config, get_log_level


async def config_get_handler(request):
    """GET /config — Gibt die vollständige Konfiguration als JSON zurück."""
    try:
        config = load_config()
        safe   = _json.loads(_json.dumps(dict(config)))
        return web.json_response(safe)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def config_patch_handler(request):
    """
    PATCH /config — Aktualisiert einzelne Konfigurationswerte.
    Body: {"path": ["fonts", "terminal", "size"], "value": 14}
    Sonderfall: path=["presets"] → Preset-Array mit Kommentarerhalt speichern.
    """
    try:
        body  = await request.json()
        path  = body["path"]
        value = body["value"]
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    try:
        # Sonderfall: Preset-Array
        if path == ["presets"] and isinstance(value, list):
            from .core import _yaml, CONFIG_FILE
            raw_config = load_config_raw()
            KEY_ORDER  = ["title", "category", "host", "port", "username",
                          "private_key", "password", "font"]
            ordered = []
            for p in value:
                cm = CommentedMap()
                for key in KEY_ORDER:
                    if key in p and p[key] is not None and p[key] != "":
                        cm[key] = p[key]
                for key, val in p.items():
                    if key not in KEY_ORDER:
                        cm[key] = val
                ordered.append(cm)
            raw_config["presets"] = ordered
            buf     = io.StringIO()
            _yaml.dump(raw_config, buf)
            yml_str = buf.getvalue()
            yml_str = _re.sub(r'(\n)(- title:)', r'\1\n\2', yml_str)
            with open(CONFIG_FILE, "w") as f:
                f.write(yml_str)
            logging.warning("Config geändert: presets")
            return web.json_response({"ok": True})

        # Alle anderen Pfade
        raw_config = load_config_raw()
        raw_node   = raw_config
        for key in path[:-1]:
            if key not in raw_node:
                raw_node[key] = CommentedMap()
            raw_node = raw_node[key]
        raw_node[path[-1]] = value
        save_config(raw_config)

        logging.warning(f"Config geändert: {'.'.join(str(k) for k in path)}")

        if "log_level" in path:
            new_level = get_log_level(load_config())
            logging.getLogger().setLevel(new_level)
            logging.warning(f"Log-Level geändert auf {logging.getLevelName(new_level)}")

        return web.json_response({"ok": True})
    except Exception as e:
        logging.error(f"Config PATCH Fehler: {e}")
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def presets_hash_handler(request):
    """GET /presets/hash — Gibt einen deterministischen Hash der Preset-Liste zurück."""
    try:
        config  = load_config()
        presets = config.get("presets", [])
        data    = sorted(
            [{"title":    p.get("title", ""),
              "host":     p.get("host", ""),
              "port":     p.get("port", 22),
              "category": p.get("category", "")}
             for p in presets],
            key=lambda p: p["title"]
        )
        h = hashlib.md5(_json.dumps(data, sort_keys=True).encode()).hexdigest()[:8]
        return web.json_response({"hash": h})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)