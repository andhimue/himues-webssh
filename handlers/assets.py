"""
handlers/assets.py — Font- und Key-Handler

Zuständig für:
    - Font-Scanner (scan_fonts)
    - GET /fonts       — verfügbare Fonts auflisten
    - GET /fonts/{fn}  — Font-Datei ausliefern
    - GET /keys        — verfügbare SSH-Keys auflisten
"""

import logging
from pathlib import Path

from aiohttp import web

from .core import load_config, BASE_DIR

FONT_EXTENSIONS = {".ttf", ".otf", ".woff", ".woff2"}
FONT_FORMAT_MAP = {
    ".ttf":   "truetype",
    ".otf":   "opentype",
    ".woff":  "woff",
    ".woff2": "woff2",
}
REGULAR_SUFFIXES = ["-Regular", "_Regular", "-regular", "_regular"]
BOLD_SUFFIXES    = ["-Bold", "_Bold", "-bold", "_bold"]
IGNORE_SUFFIXES  = [
    "-Italic", "_Italic", "-italic", "_italic",
    "-Light", "_Light", "-light", "_light",
    "-Thin", "_Thin", "-thin", "_thin",
    "-Medium", "_Medium", "-medium", "_medium",
    "-SemiBold", "_SemiBold", "-semibold", "_semibold",
    "-ExtraBold", "_ExtraBold", "-extrabold", "_extrabold",
    "-Black", "_Black", "-black", "_black",
    "-Condensed", "_Condensed", "-condensed", "_condensed",
    "-BoldItalic", "_BoldItalic", "-bolditalic", "_bolditalic",
    "-Oblique", "_Oblique", "-oblique", "_oblique",
]


def scan_fonts(config: dict | None = None) -> list[dict]:
    """
    Scannt das konfigurierte Fonts-Verzeichnis nach Font-Dateien und
    gruppiert sie in Regular+Bold-Paare.
    Unterstützt moderne (-Regular/-Bold) und klassische (Name/Name-Bold) Konvention.
    """
    if config is None:
        config = load_config()
    fonts_dir_str = config.get("paths", {}).get("fonts", "")
    fonts_dir     = Path(fonts_dir_str) if fonts_dir_str else BASE_DIR / "static" / "fonts"
    if not fonts_dir.exists():
        return []

    files        = {f for f in fonts_dir.iterdir() if f.suffix.lower() in FONT_EXTENSIONS}
    regular_files = {f for f in files if any(f.stem.endswith(s) for s in REGULAR_SUFFIXES)}
    bold_files    = {f for f in files if any(f.stem.endswith(s) for s in BOLD_SUFFIXES)}
    ignore_files  = {f for f in files if any(f.stem.endswith(s) for s in IGNORE_SUFFIXES)}
    plain_files   = files - regular_files - bold_files - ignore_files

    result = []

    for reg in sorted(regular_files):
        base = reg.stem
        for s in REGULAR_SUFFIXES:
            if base.endswith(s):
                base = base[:-len(s)]
                break
        bold_file = None
        for s in BOLD_SUFFIXES:
            for ext in [reg.suffix, *[e for e in FONT_EXTENSIONS if e != reg.suffix]]:
                candidate = reg.with_name(base + s + ext)
                if candidate in bold_files:
                    bold_file = candidate
                    break
            if bold_file:
                break
        result.append({
            "name":      base,
            "file":      f"/fonts/{reg.name}",
            "file_bold": f"/fonts/{bold_file.name}" if bold_file else None,
            "format":    FONT_FORMAT_MAP.get(reg.suffix.lower(), "truetype"),
        })

    for plain in sorted(plain_files):
        base      = plain.stem
        bold_file = None
        for s in BOLD_SUFFIXES:
            candidate = plain.with_name(base + s + plain.suffix)
            if candidate in bold_files:
                bold_file = candidate
                break
        result.append({
            "name":      base,
            "file":      f"/fonts/{plain.name}",
            "file_bold": f"/fonts/{bold_file.name}" if bold_file else None,
            "format":    FONT_FORMAT_MAP.get(plain.suffix.lower(), "truetype"),
        })

    return sorted(result, key=lambda f: f["name"].lower())


async def fonts_handler(request):
    """GET /fonts — Gibt alle verfügbaren Schriftarten als JSON-Liste zurück."""
    try:
        return web.json_response(scan_fonts())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def font_file_handler(request):
    """GET /fonts/{filename} — Liefert eine Font-Datei aus dem konfigurierten Verzeichnis."""
    filename  = request.match_info["filename"]
    config    = load_config()
    fonts_dir_str = config.get("paths", {}).get("fonts", "")
    fonts_dir = Path(fonts_dir_str) if fonts_dir_str else BASE_DIR / "static" / "fonts"
    font_path = (fonts_dir / filename).resolve()

    try:
        font_path.relative_to(fonts_dir.resolve())
    except ValueError:
        return web.Response(status=403)

    if not font_path.exists() or font_path.suffix.lower() not in FONT_EXTENSIONS:
        return web.Response(status=404)

    content_types = {
        ".ttf":   "font/ttf",
        ".otf":   "font/otf",
        ".woff":  "font/woff",
        ".woff2": "font/woff2",
    }
    ct = content_types.get(font_path.suffix.lower(), "application/octet-stream")
    return web.FileResponse(font_path, headers={"Content-Type": ct})


async def keys_handler(request):
    """GET /keys — Listet alle SSH-Keys im konfigurierten Keys-Verzeichnis auf."""
    config   = load_config()
    key_dir  = config.get("paths", {}).get("ssh_keys", "")
    key_path = Path(key_dir) if key_dir else BASE_DIR / "keys"
    if not key_path.exists() or not key_path.is_dir():
        return web.json_response([])

    exclude_raw = config.get("paths", {}).get("keys_exclude", "")
    excludes    = {e.strip() for e in exclude_raw.split(",") if e.strip()}
    excludes.update({"authorized_keys", "authorized_keys2", "known_hosts",
                     "known_hosts.old", "config", "environment", ".gitkeep"})

    keys = sorted([
        f.name for f in key_path.iterdir()
        if f.is_file()
        and not f.name.startswith(".")
        and f.suffix == ""
        and f.name not in excludes
    ])
    return web.json_response(keys)