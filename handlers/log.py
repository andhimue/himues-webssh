"""
handlers/log.py — Verbindungslog-Endpunkt

Liefert die In-Memory-Logeinträge aus mem_log an den Browser.
"""

from aiohttp import web
from .core import mem_log


async def log_handler(request):
    """GET /log?since=<timestamp> — Gibt neue Log-Einträge seit dem angegebenen Timestamp zurück."""
    try:
        since = float(request.query.get("since", "0"))
    except ValueError:
        since = 0.0
    entries = mem_log.get_entries(since)
    return web.json_response(entries)