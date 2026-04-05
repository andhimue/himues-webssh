"""
handlers/sessions.py — SSH-Sessions und WebSocket-Handler

Enthält:
    - ManagedSession, SessionManager, session_manager
    - _build_connect_kwargs (SSH-Verbindungsparameter)
    - cleanup_task (Hintergrund-Aufräumen)
    - start_ssh_session (SSH-Verbindung aufbauen)
    - websocket_handler (WebSocket /ws)
    - index_handler (GET /)
    - presets_handler (GET /presets)
    - terminal_config_handler (GET /config/terminal)
    - sessions_handler (GET /sessions)
    - close_session_handler (DELETE /sessions/{id})
    - grid_state_save_handler / grid_state_load_handler
"""

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path

import asyncssh
from aiohttp import web

from .core import (
    auth_manager, load_config, get_session_config,
    filter_term_responses, BASE_DIR
)

# ── Grid-State (In-Memory) ────────────────────────────────────
_grid_states: dict[str, dict] = {}

# ── Font-Format-Map ───────────────────────────────────────────
FONT_FORMAT_MAP = {
    ".ttf":   "truetype",
    ".otf":   "opentype",
    ".woff":  "woff",
    ".woff2": "woff2",
}


# ── ManagedSession ────────────────────────────────────────────

class ManagedSession:
    """Eine persistente SSH-Session mit Output-Buffer und WebSocket-Verbindung."""

    def __init__(self, session_id, preset, client_id, buffer_size):
        self.session_id  = session_id
        self.preset      = preset
        self.client_id   = client_id
        self.buffer_size = buffer_size
        self.buffer      = bytearray()
        self.process     = None
        self.ws          = None
        self.created_at  = time.time()
        self.last_seen   = time.time()
        self.state       = "connecting"
        self._lock       = asyncio.Lock()

    def append_buffer(self, data: bytes):
        """Hängt Daten an den Scrollback-Buffer an und begrenzt dessen Größe."""
        self.buffer.extend(data)
        if len(self.buffer) > self.buffer_size:
            del self.buffer[:len(self.buffer) - self.buffer_size]

    def get_buffer(self) -> bytes:
        """Gibt den gesamten Scrollback-Buffer zurück."""
        return bytes(self.buffer)

    def to_dict(self):
        """Serialisiert die Session für die /sessions-API."""
        return {
            "session_id": self.session_id,
            "title":      self.preset.get("title", ""),
            "host":       self.preset.get("host", ""),
            "port":       self.preset.get("port", 22),
            "client_id":  self.client_id,
            "state":      self.state,
            "created_at": self.created_at,
            "last_seen":  self.last_seen,
        }


# ── SessionManager ────────────────────────────────────────────

class SessionManager:
    """Verwaltet alle aktiven SSH-Sessions thread-sicher."""

    def __init__(self):
        self._sessions: dict[str, ManagedSession] = {}
        self._lock = asyncio.Lock()

    async def create(self, preset: dict, client_id: str, buffer_size: int) -> ManagedSession:
        """Legt eine neue Session an und gibt sie zurück."""
        session_id = str(uuid.uuid4())
        session    = ManagedSession(session_id, preset, client_id, buffer_size)
        async with self._lock:
            self._sessions[session_id] = session
        return session

    async def get(self, session_id: str) -> ManagedSession | None:
        """Gibt eine Session anhand ihrer ID zurück oder None."""
        async with self._lock:
            return self._sessions.get(session_id)

    async def list_all(self) -> list[ManagedSession]:
        """Gibt alle aktiven Sessions zurück."""
        async with self._lock:
            return list(self._sessions.values())

    async def list_for_client(self, client_id: str) -> list[ManagedSession]:
        """Gibt alle Sessions einer bestimmten Browser-Instanz zurück."""
        async with self._lock:
            return [s for s in self._sessions.values() if s.client_id == client_id]

    async def remove(self, session_id: str):
        """Entfernt eine Session aus dem Manager."""
        async with self._lock:
            self._sessions.pop(session_id, None)

    async def cleanup_expired(self, timeout: int):
        """Beendet Sessions die länger als timeout Sekunden ohne WebSocket waren."""
        now = time.time()
        async with self._lock:
            expired = [
                s for s in self._sessions.values()
                if s.ws is None and (now - s.last_seen) > timeout
            ]
        for s in expired:
            logging.warning(f"Session abgelaufen: {s.preset.get('title','?')} ({s.session_id[:8]})")
            await self._terminate_session(s)

    async def _terminate_session(self, session: ManagedSession):
        """Beendet eine Session: stoppt SSH-Prozess und entfernt sie aus dem Manager."""
        title = session.preset.get("title", "?") if session.preset else "?"
        logging.warning(f"Session geschlossen: {title} [{session.session_id[:8]}]")
        if session.process:
            try:
                session.process.stdin.write_eof()
            except Exception:
                pass
        await self.remove(session.session_id)


session_manager = SessionManager()


# ── SSH-Verbindungsparameter ──────────────────────────────────

async def _build_connect_kwargs(preset: dict) -> dict:
    """Baut asyncssh connect-Parameter aus einem Preset zusammen."""
    config = load_config()
    kwargs = {
        "host":        preset["host"],
        "port":        preset.get("port", 22),
        "username":    preset["username"],
        "known_hosts": None,
    }
    if "private_key" in preset:
        key_val  = preset["private_key"]
        key_path = Path(key_val)
        if not key_path.is_absolute():
            cfg_keys     = config.get("paths", {}).get("ssh_keys", "")
            keys_dir     = Path(cfg_keys) if cfg_keys else BASE_DIR / "keys"
            key_val      = str(keys_dir / key_val)
        kwargs["client_keys"] = [key_val]
    elif "password" in preset:
        kwargs["password"] = preset["password"]
    return kwargs


# ── Cleanup-Task ──────────────────────────────────────────────

async def cleanup_task():
    """Läuft im Hintergrund und räumt abgelaufene Sessions auf."""
    from .sftp import sftp_manager
    import time as _time
    while True:
        await asyncio.sleep(60)
        try:
            config = load_config()
            sc     = get_session_config(config)
            if sc["persist"]:
                await session_manager.cleanup_expired(sc["reconnect_timeout"])
            auth_manager.cleanup_expired()
            for s in await sftp_manager.list_all():
                if _time.time() - s.last_used > 3600:
                    logging.warning(f"SFTP-Session abgelaufen: {s.preset.get('title','?')}")
                    await sftp_manager.remove(s.sftp_id)
        except Exception as e:
            logging.error(f"Cleanup-Fehler: {e}")


# ── SSH-Session starten ───────────────────────────────────────

async def start_ssh_session(session: ManagedSession, cols: int, rows: int):
    """Baut die SSH-Verbindung auf und hält sie am Leben."""
    preset         = session.preset
    connect_kwargs = await _build_connect_kwargs(preset)
    title          = preset.get("title", "?")
    host_str       = f"{preset['username']}@{preset['host']}:{preset.get('port', 22)}"
    logging.warning(f"Verbinde: {title} ({host_str})")

    try:
        async with asyncssh.connect(**connect_kwargs) as ssh:
            process = await ssh.create_process(
                term_type="xterm-256color",
                term_size=(cols, rows),
                request_pty="force",
                encoding=None,
                env={"WEBSSH_SESSION": "1"},
            )
            session.process = process
            session.state   = "connected"
            logging.warning(f"Verbunden: {title} ({host_str}) [{session.session_id[:8]}]")

            while True:
                try:
                    data = await asyncio.wait_for(process.stdout.read(4096), timeout=1.0)
                    if not data:
                        break
                except asyncio.TimeoutError:
                    if process.stdout.at_eof():
                        break
                    continue

                filtered = filter_term_responses(data)
                if filtered:
                    session.append_buffer(filtered)
                session.last_seen = time.time()

                if session.ws and not session.ws.closed:
                    text = data.decode("utf-8", errors="replace")
                    try:
                        await session.ws.send_str(json.dumps({"type": "data", "data": text}))
                    except Exception:
                        session.ws = None

    except asyncssh.DisconnectError as e:
        logging.warning(f"Getrennt: {title} – {e}")
    except Exception as e:
        logging.error(f"SSH-Fehler ({title}): {e}")
    finally:
        session.state   = "disconnected"
        session.process = None
        if session.ws and not session.ws.closed:
            try:
                await session.ws.send_str(json.dumps({"type": "session_ended"}))
                await session.ws.close()
            except Exception:
                pass
            session.ws = None
        await session_manager.remove(session.session_id)
        logging.warning(f"Session beendet: {title} [{session.session_id[:8]}]")


# ── WebSocket-Handler ─────────────────────────────────────────

async def websocket_handler(request):
    """
    Öffnet eine WebSocket-Verbindung für eine SSH-Session.
    Zwei Modi:
    - ?preset=N        → neue Session anlegen
    - ?session_id=UUID → bestehende Session übernehmen
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    config    = load_config()
    sc        = get_session_config(config)
    client_id = request.query.get("client_id", "unknown")
    session_id = request.query.get("session_id")

    if session_id:
        # Bestehende Session übernehmen
        session = await session_manager.get(session_id)
        if not session:
            await ws.send_str(json.dumps({"type": "error", "data": "Session nicht gefunden"}))
            await ws.close()
            return ws

        if session.ws and not session.ws.closed:
            try:
                await session.ws.send_str(json.dumps({"type": "session_taken_over"}))
                await session.ws.close()
            except Exception:
                pass

        session.ws        = ws
        session.client_id = client_id
        session.last_seen = time.time()

        cols, rows = 80, 24
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=3.0)
            if msg.type == web.WSMsgType.TEXT:
                payload = json.loads(msg.data)
                if payload["type"] == "resize":
                    cols, rows = payload["cols"], payload["rows"]
                    if session.process:
                        session.process.change_terminal_size(cols, rows)
        except asyncio.TimeoutError:
            pass

        buf = session.get_buffer()
        if buf:
            await ws.send_str(json.dumps({"type": "data", "data": buf.decode("utf-8", errors="replace")}))

        await ws.send_str(json.dumps({"type": "attached"}))
        logging.warning(f"Reconnect: {session.preset.get('title','?')} [{session_id[:8]}]")

    else:
        # Neue Session anlegen
        presets      = config.get("presets", [])
        preset_index = int(request.query.get("preset", 0))
        if preset_index >= len(presets):
            await ws.send_str(json.dumps({"type": "error", "data": "Ungültiger Preset-Index"}))
            await ws.close()
            return ws

        preset  = presets[preset_index]
        session = await session_manager.create(preset, client_id, sc["buffer_size"])
        session.ws = ws

        cols, rows = 80, 24
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=3.0)
            if msg.type == web.WSMsgType.TEXT:
                payload = json.loads(msg.data)
                if payload["type"] == "resize":
                    cols, rows = payload["cols"], payload["rows"]
        except asyncio.TimeoutError:
            pass

        await ws.send_str(json.dumps({
            "type":       "session_created",
            "session_id": session.session_id,
            "title":      preset.get("title", ""),
        }))
        asyncio.create_task(start_ssh_session(session, cols, rows))

    # Input-Loop
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                payload = json.loads(msg.data)
                if payload["type"] == "data" and session.process:
                    session.process.stdin.write(payload["data"].encode("utf-8"))
                elif payload["type"] == "resize" and session.process:
                    session.process.change_terminal_size(payload["cols"], payload["rows"])
                elif payload["type"] == "close_session":
                    logging.warning(f"Session getrennt (Tab geschlossen): {session.preset.get('title','?')} [{session.session_id[:8]}]")
                    await session_manager._terminate_session(session)
                    break
            elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                break
    finally:
        if session.ws is ws:
            session.ws        = None
            session.last_seen = time.time()

    return ws


# ── HTTP-Handler ──────────────────────────────────────────────

async def index_handler(request):
    """GET / — Liefert die Haupt-App (index.html)."""
    resp = web.FileResponse(BASE_DIR / "templates" / "index.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


async def presets_handler(request):
    """GET /presets — Gibt alle konfigurierten Server-Presets als JSON zurück."""
    config  = load_config()
    presets = config.get("presets", [])
    return web.json_response([
        {
            "index":    i,
            "title":    p.get("title", f"Server {i}"),
            "host":     p.get("host", ""),
            "port":     p.get("port", 22),
            "category": p.get("category", ""),
            "username": p.get("username", ""),
            "font":     p.get("font", None),
        }
        for i, p in enumerate(presets)
    ])


async def terminal_config_handler(request):
    """GET /config/terminal — Liefert Terminal-relevante Konfiguration für den Browser."""
    config = load_config()
    term   = config.get("terminal", {})
    fonts  = config.get("fonts", {})
    tf     = fonts.get("terminal", {})
    uf     = fonts.get("ui", {})
    tbf    = fonts.get("toolbar", {})
    sc     = get_session_config(config)
    return web.json_response({
        "font_size":            tf.get("size", 14),
        "font_family":          tf.get("family", "DejaVuSansMono"),
        "font_file":            "/fonts/" + Path(tf.get("file", "fonts/DejaVuSansMono.ttf")).name,
        "font_file_bold":       "/fonts/" + Path(tf.get("file_bold", "fonts/DejaVuSansMono-Bold.ttf")).name,
        "font_format":          FONT_FORMAT_MAP.get(Path(tf.get("file", ".ttf")).suffix.lower(), "truetype"),
        "ui_font_size":         uf.get("size", 13),
        "kb_font_size":         tbf.get("size", 11),
        "header_btn_size":      fonts.get("header", {}).get("size", 14),
        "sftp_font_size":       fonts.get("sftp", {}).get("size", 12),
        "settings_font_size":   fonts.get("settings", {}).get("size", 13),
        "preview_font_size":    fonts.get("preview", {}).get("size", 13),
        "preview_font_family":  fonts.get("preview", {}).get("family", ""),
        "log_font_size":        fonts.get("log", {}).get("size", 12),
        "log_font_family":      fonts.get("log", {}).get("family", ""),
        "grid_fonts": {
            "2x1": fonts.get("grid_2x1", {}),
            "1x2": fonts.get("grid_1x2", {}),
            "2x2": fonts.get("grid_2x2", {}),
        },
        "close_on_disconnect":  term.get("close_on_disconnect", False),
        "close_delay":          term.get("close_delay", 3),
        "show_active_sessions": term.get("show_active_sessions", True),
        "persist_sessions":     sc["persist"],
        "session_mode":         sc["session_mode"],
        "auth_enabled":         auth_manager.auth_required(),
        "log_level":            config.get("log_level", "WARNING"),
    })


async def sessions_handler(request):
    """GET /sessions — Liefert Liste der aktiven Sessions (gefiltert nach session_mode)."""
    config    = load_config()
    sc        = get_session_config(config)
    client_id = request.query.get("client_id", "")

    if sc["session_mode"] == "single_user":
        sessions = await session_manager.list_all()
    else:
        sessions = await session_manager.list_for_client(client_id)

    return web.json_response([s.to_dict() for s in sessions])


async def close_session_handler(request):
    """DELETE /sessions/{session_id} — Beendet eine Session explizit."""
    session_id = request.match_info["session_id"]
    session    = await session_manager.get(session_id)
    if session:
        await session_manager._terminate_session(session)
        return web.json_response({"ok": True})
    return web.json_response({"ok": False, "error": "nicht gefunden"}, status=404)


async def grid_state_save_handler(request):
    """POST /grid-state — Grid-State serverseitig speichern (für Browser-Übernahme)."""
    try:
        body      = await request.json()
        client_id = body.get("client_id", "")
        if client_id:
            _grid_states[client_id] = body.get("state")
        return web.json_response({"ok": True})
    except Exception:
        return web.json_response({"ok": False}, status=400)


async def grid_state_load_handler(request):
    """GET /grid-state — Grid-State laden (für Browser-Übernahme)."""
    config       = load_config()
    sc           = get_session_config(config)
    client_id    = request.query.get("client_id", "")

    if sc["session_mode"] == "single_user":
        states = [s for s in _grid_states.values() if s]
        state  = states[-1] if states else None
    else:
        state = _grid_states.get(client_id)

    return web.json_response({"ok": True, "state": state})