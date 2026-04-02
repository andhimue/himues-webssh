#!/usr/bin/env python3
"""
WebSSH — Web-SSH-Client mit persistenten Sessions
server.py — aiohttp HTTP/WebSocket-Server + asyncssh SSH-Client

Architektur:
    Browser ←→ WebSocket ←→ SessionManager ←→ SSH-Prozess (asyncssh)

HTTP-Endpunkte:
    GET  /                      index.html (Single Page App)
    GET  /static/*              Statische Dateien (CSS, Fonts)
    GET  /presets               Preset-Liste (ohne Passwörter/Keys)
    GET  /presets/hash          MD5-Hash der Preset-Liste (Cache-Invalidierung)
    GET  /config/terminal       Terminal- und Font-Konfiguration für den Client
    GET  /sessions              Aktive Sessions (gefiltert nach session_mode)
    DELETE /sessions/{id}       Session explizit beenden
    GET  /ws                    WebSocket-Endpunkt

WebSocket-Parameter (/ws):
    ?preset=N                   Neue Session mit Preset-Index N anlegen
    ?session_id=UUID            Bestehende Session übernehmen (Reconnect)
    ?client_id=UUID             Browser-Identifikation (für multi_user-Modus)

Konfiguration (config/config.json):
    host, port                  Bind-Adresse des Servers
    log_level                   Python-Log-Level (DEBUG/INFO/WARNING/ERROR)
    fonts.terminal              Terminal-Font (family, size, file, file_bold)
    fonts.ui                    UI-Schriftgröße für Launcher-Dialoge
    fonts.toolbar               Schriftgröße der Keyboard-Toolbar
    terminal.close_on_disconnect  Tab automatisch schließen wenn SSH endet
    terminal.close_delay        Verzögerung in Sekunden vor dem Schließen
    terminal.show_active_sessions  Aktive Sessions im Launcher anzeigen
    sessions.persist            Sessions über Browser-Reload hinaus behalten
    sessions.session_mode       "single_user" (global) oder "multi_user" (pro Browser)
    sessions.reconnect_timeout  Sekunden bis verwaiste Session abläuft
    sessions.buffer_size        Max. Bytes im Scrollback-Buffer pro Session
    presets[].font              Optionale Font-Überschreibung pro Server

Abhängigkeiten:
    aiohttp>=3.9     HTTP/WebSocket-Server
    asyncssh>=2.14   SSH-Client-Bibliothek
"""

import asyncio
import os
import json
import logging
import time
import uuid
from pathlib import Path

import asyncssh
from ruamel.yaml import YAML
from aiohttp import web

# YAML-Instanz mit Kommentar- und Formatierungserhalt
_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.default_flow_style = False
_yaml.width = 120

# ============================================================
# Auth-System
# ============================================================

import time as _time
import uuid as _uuid

class AuthManager:
    """
    Verwaltet Login-Tokens und Rate-Limiting.
    - single_user: nur ein aktives Token, neuer Login verdrängt alten
    - multi_user:  mehrere aktive Tokens gleichzeitig
    """

    def __init__(self):
        self._tokens: dict[str, float] = {}   # token → expiry timestamp
        self._attempts: dict[str, list] = {}  # ip → [timestamp, ...]

    def _get_auth_config(self) -> dict:
        try:
            config = load_config()
        except Exception:
            return {}
        return config.get("auth", {})

    # ── Rate-Limiting ──────────────────────────────────────────
    def check_rate_limit(self, ip: str) -> tuple[bool, int]:
        """
        Gibt (erlaubt, retry_after_seconds) zurück.
        Standard: max 5 Versuche in 60 Sekunden, dann 60s Sperre.
        """
        cfg       = self._get_auth_config()
        max_tries = cfg.get("rate_limit_attempts", 5)
        window    = cfg.get("rate_limit_window", 60)

        now  = _time.time()
        hits = [t for t in self._attempts.get(ip, []) if now - t < window]
        self._attempts[ip] = hits

        if len(hits) >= max_tries:
            oldest     = min(hits)
            retry_after = int(window - (now - oldest))
            return False, max(retry_after, 1)
        return True, 0

    def record_attempt(self, ip: str):
        if ip not in self._attempts:
            self._attempts[ip] = []
        self._attempts[ip].append(_time.time())

    def clear_attempts(self, ip: str):
        self._attempts.pop(ip, None)

    # ── Passwort prüfen ────────────────────────────────────────
    def verify_password(self, password: str) -> bool:
        cfg   = self._get_auth_config()
        hash_ = cfg.get("password_hash", "")
        if not hash_:
            return False
        try:
            import bcrypt
            return bcrypt.checkpw(password.encode(), hash_.encode())
        except Exception:
            return False

    def auth_required(self) -> bool:
        """Login aktiv wenn enable_login: true in der Config."""
        cfg = self._get_auth_config()
        return bool(cfg.get("enable_login", False))

    def has_password(self) -> bool:
        """Prüft ob bereits ein Passwort-Hash gesetzt ist."""
        cfg = self._get_auth_config()
        return bool(cfg.get("password_hash", ""))

    def set_password(self, password: str):
        """Setzt einen neuen Passwort-Hash in der Config."""
        import bcrypt
        hash_ = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
        raw   = load_config_raw()
        if "auth" not in raw:
            from ruamel.yaml.comments import CommentedMap
            raw["auth"] = CommentedMap()
        raw["auth"]["password_hash"] = hash_
        save_config(raw)
        logging.warning("Passwort wurde geändert")

    # ── Token-Verwaltung ───────────────────────────────────────
    def create_token(self, session_mode: str) -> str:
        cfg     = self._get_auth_config()
        timeout = cfg.get("session_timeout", 86400)
        expiry  = _time.time() + timeout
        token   = str(_uuid.uuid4())

        if session_mode == "single_user":
            # Alle bestehenden Tokens löschen
            self._tokens.clear()

        self._tokens[token] = expiry
        return token

    def validate_token(self, token: str) -> bool:
        if not token:
            return False
        expiry = self._tokens.get(token)
        if expiry is None:
            return False
        if _time.time() > expiry:
            del self._tokens[token]
            return False
        return True

    def revoke_token(self, token: str):
        self._tokens.pop(token, None)

    def cleanup_expired(self):
        now = _time.time()
        self._tokens = {t: e for t, e in self._tokens.items() if e > now}


# ── In-Memory Log-Handler ─────────────────────────────────────
import collections as _collections

class _MemLogHandler(logging.Handler):
    """Speichert die letzten MAX_ENTRIES Log-Einträge im Speicher."""
    MAX_ENTRIES = 200

    def __init__(self):
        super().__init__()
        self._entries = _collections.deque(maxlen=self.MAX_ENTRIES)

    def emit(self, record):
        self._entries.append({
            "ts":    record.created,
            "level": record.levelname,
            "msg":   self.format(record),
        })

    def get_entries(self, since: float = 0.0) -> list:
        return [e for e in self._entries if e["ts"] > since]

_mem_log = _MemLogHandler()
_mem_log.setLevel(logging.INFO)   # DEBUG-Spam unterdrücken
_mem_log.setFormatter(logging.Formatter("%(name)s: %(message)s"))

# Globale Auth-Manager Instanz
auth_manager = AuthManager()

# ── Auth-Middleware ────────────────────────────────────────────
UNPROTECTED_PATHS = {"/auth/login", "/auth/logout", "/auth/setup"}

@web.middleware
async def auth_middleware(request, handler):
    """Prüft Auth-Token bei jedem Request außer Login-Seite und statischen Dateien."""
    # Auth deaktiviert wenn kein Passwort konfiguriert
    if not auth_manager.auth_required():
        return await handler(request)

    path = request.path

    # Login-Endpunkte und statische Dateien immer erlauben
    # (JS/CSS müssen auch auf der Login-Seite geladen werden können)
    if path in UNPROTECTED_PATHS or path.startswith("/static/"):
        return await handler(request)

    # Token aus Cookie lesen
    token = request.cookies.get("webssh_token", "")

    if not auth_manager.validate_token(token):
        # Kein Hash gesetzt → Einrichtungsseite
        if not auth_manager.has_password():
            if path not in {"/auth/setup", "/auth/login"}:
                return web.HTTPFound("/auth/setup")
            return await handler(request)
        # WebSocket: Verbindung ablehnen
        if path == "/ws":
            return web.Response(status=401, text="Unauthorized")
        # Alle anderen: zur Login-Seite umleiten
        return web.HTTPFound("/auth/login")

    return await handler(request)


# ============================================================
# Konfiguration
# ============================================================

BASE_DIR = Path(__file__).parent

def _resolve_config_file() -> Path:
    """Config-Pfad: --config Argument > WEBSSH_CONFIG Env > Standard."""
    import sys
    # --config /pfad/zur/config.yml
    if "--config" in sys.argv:
        idx = sys.argv.index("--config")
        if idx + 1 < len(sys.argv):
            return Path(sys.argv[idx + 1])
    # WEBSSH_CONFIG=/pfad/zur/config.yml
    env = os.environ.get("WEBSSH_CONFIG", "")
    if env:
        return Path(env)
    return BASE_DIR / "config" / "config.yml"

CONFIG_FILE = _resolve_config_file()

# ── Config-Cache ───────────────────────────────────────────────
# Liest config.yml nur neu von Disk wenn sich der mtime geändert hat.
_config_cache: dict | None = None
_config_mtime: float       = 0.0

def load_config() -> dict:
    """Lädt config.yml — gecacht, wird bei Dateiänderung automatisch neu gelesen."""
    global _config_cache, _config_mtime
    try:
        mtime = CONFIG_FILE.stat().st_mtime
    except OSError:
        mtime = 0.0
    if _config_cache is None or mtime != _config_mtime:
        with open(CONFIG_FILE) as f:
            _config_cache = dict(_yaml.load(f))
        _config_mtime = mtime
    return _config_cache

# Regex für Terminal-Antwort-Sequenzen die nicht in den Scrollback gehören
import re
# CSI Device Attributes (c), Cursor Position (R), Device Status (n)
_TERM_RESPONSE_RE = re.compile(rb"\x1b\[[\x30-\x3f]*[\x20-\x2f]*[cRn]")

def filter_term_responses(data: bytes) -> bytes:
    """Entfernt Terminal-Antwort-Sequenzen die beim Reconnect falsch dargestellt würden."""
    return _TERM_RESPONSE_RE.sub(b"", data)

def get_log_level(config):
    level_str = config.get("log_level", "WARNING").upper()
    return getattr(logging, level_str, logging.WARNING)

def get_session_config(config):
    s = config.get("sessions", {})
    return {
        "persist":           s.get("persist", True),
        "session_mode":      s.get("session_mode", "single_user"),
        "reconnect_timeout": s.get("reconnect_timeout", 86400),
        "buffer_size":       s.get("buffer_size", 524288),
    }

# ============================================================
# Session-Manager
# ============================================================

class ManagedSession:
    """Eine persistente SSH-Session mit Output-Buffer."""

    def __init__(self, session_id, preset, client_id, buffer_size):
        self.session_id  = session_id
        self.preset      = preset          # dict mit title, host, port, ...
        self.client_id   = client_id       # Browser-ID (für multi_user)
        self.buffer_size = buffer_size
        self.buffer      = bytearray()     # Ringbuffer als bytearray
        self.process     = None            # asyncssh-Prozess
        self.ws          = None            # aktuell verbundener WebSocket
        self.created_at  = time.time()
        self.last_seen   = time.time()
        self.state       = "connecting"    # connecting | connected | disconnected
        self._lock       = asyncio.Lock()

    def append_buffer(self, data: bytes):
        self.buffer.extend(data)
        if len(self.buffer) > self.buffer_size:
            overflow = len(self.buffer) - self.buffer_size
            del self.buffer[:overflow]

    def get_buffer(self) -> bytes:
        return bytes(self.buffer)

    def to_dict(self):
        return {
            "session_id": self.session_id,
            "title":      self.preset.get("title", ""),
            "host":       self.preset.get("host", ""),
            "port":       self.preset.get("port", 22),
            "username":   self.preset.get("username", ""),
            "client_id":  self.client_id,
            "state":      self.state,
            "created_at": self.created_at,
            "last_seen":  self.last_seen,
        }


class SessionManager:
    def __init__(self):
        self._sessions: dict[str, ManagedSession] = {}
        self._lock = asyncio.Lock()

    async def create(self, preset: dict, client_id: str, buffer_size: int) -> ManagedSession:
        session_id = str(uuid.uuid4())
        session = ManagedSession(session_id, preset, client_id, buffer_size)
        async with self._lock:
            self._sessions[session_id] = session
        return session

    async def get(self, session_id: str) -> ManagedSession | None:
        async with self._lock:
            return self._sessions.get(session_id)

    async def list_all(self) -> list[ManagedSession]:
        async with self._lock:
            return list(self._sessions.values())

    async def list_for_client(self, client_id: str) -> list[ManagedSession]:
        async with self._lock:
            return [s for s in self._sessions.values() if s.client_id == client_id]

    async def remove(self, session_id: str):
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
        title = session.preset.get("title", "?") if session.preset else "?"
        logging.warning(f"Session geschlossen: {title} [{session.session_id[:8]}]")
        if session.process:
            try:
                session.process.stdin.write_eof()
            except Exception:
                pass
        await self.remove(session.session_id)


# Globale Instanz
session_manager = SessionManager()


# ============================================================
# SFTP-Manager
# ============================================================

class SftpSession:
    """Eine offene SFTP-Verbindung zu einem Server."""
    def __init__(self, sftp_id: str, preset: dict, client_id: str = ""):
        self.sftp_id      = sftp_id
        self.preset       = preset
        self.client_id    = client_id
        self.sftp         = None
        self.ssh          = None
        self.connected    = False
        self.last_used    = _time.time()
        self.current_path = "/"

    def to_dict(self):
        return {
            "sftp_id":   self.sftp_id,
            "title":     self.preset.get("title", ""),
            "host":      self.preset.get("host", ""),
            "connected": self.connected,
        }


class SftpManager:
    def __init__(self):
        self._sessions: dict[str, SftpSession] = {}
        self._lock = asyncio.Lock()

    async def create(self, sftp_id: str, preset: dict, client_id: str = "") -> SftpSession:
        session = SftpSession(sftp_id, preset, client_id)
        async with self._lock:
            self._sessions[sftp_id] = session
        return session

    async def get_by_client_id(self, client_id: str) -> list:
        """Gibt alle SFTP-Sessions eines Clients zurück."""
        async with self._lock:
            return [s for s in self._sessions.values() if s.client_id == client_id]

    async def get(self, sftp_id: str) -> SftpSession | None:
        async with self._lock:
            return self._sessions.get(sftp_id)

    async def remove(self, sftp_id: str):
        async with self._lock:
            s = self._sessions.pop(sftp_id, None)
        if s and s.ssh:
            try: s.ssh.close()
            except Exception: pass

    async def list_all(self) -> list[SftpSession]:
        async with self._lock:
            return list(self._sessions.values())


sftp_manager = SftpManager()


async def _build_connect_kwargs(preset: dict) -> dict:
    """Baut asyncssh connect-Parameter aus einem Preset."""
    config = load_config()
    kwargs = {
        "host":        preset["host"],
        "port":        preset.get("port", 22),
        "username":    preset["username"],
        "known_hosts": None,
    }
    if "private_key" in preset:
        key_val = preset["private_key"]
        if not Path(key_val).is_absolute():
            cfg_keys = config.get("paths", {}).get("ssh_keys", "")
            if cfg_keys:
                key_val = str(Path(cfg_keys) / key_val)
        kwargs["client_keys"] = [key_val]
    elif "password" in preset:
        kwargs["password"] = preset["password"]
    return kwargs


# ============================================================
# Cleanup-Task
# ============================================================

async def cleanup_task():
    """Läuft im Hintergrund und räumt abgelaufene Sessions auf."""
    while True:
        await asyncio.sleep(60)
        try:
            config = load_config()
            sc = get_session_config(config)
            if sc["persist"]:
                await session_manager.cleanup_expired(sc["reconnect_timeout"])
            auth_manager.cleanup_expired()
            # SFTP-Sessions aufräumen die lange nicht benutzt wurden (1h)
            for s in await sftp_manager.list_all():
                if _time.time() - s.last_used > 3600:
                    logging.warning(f"SFTP-Session abgelaufen: {s.preset.get('title','?')}")
                    await sftp_manager.remove(s.sftp_id)
        except Exception as e:
            logging.error(f"Cleanup-Fehler: {e}")


# ============================================================
# SSH-Session starten
# ============================================================

async def start_ssh_session(session: ManagedSession, cols: int, rows: int):
    """Baut die SSH-Verbindung auf und hält sie am Leben."""
    preset         = session.preset
    connect_kwargs = await _build_connect_kwargs(preset)

    title = preset.get("title", "?")
    host_str = f"{preset['username']}@{preset['host']}:{preset.get('port', 22)}"
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

            # Output lesen und in Buffer + aktiven WebSocket schreiben
            while True:
                try:
                    data = await asyncio.wait_for(process.stdout.read(4096), timeout=1.0)
                    if not data:
                        break
                except asyncio.TimeoutError:
                    # Kein Output — prüfen ob Prozess noch läuft
                    if process.stdout.at_eof():
                        break
                    continue

                # Rohdaten für Live-Anzeige, gefilterte Daten in den Buffer
                filtered = filter_term_responses(data)
                if filtered:
                    session.append_buffer(filtered)
                session.last_seen = time.time()

                if session.ws and not session.ws.closed:
                    text = data.decode("utf-8", errors="replace")
                    try:
                        await session.ws.send_str(
                            json.dumps({"type": "data", "data": text})
                        )
                    except Exception:
                        session.ws = None

    except asyncssh.DisconnectError as e:
        logging.warning(f"Getrennt: {title} – {e}")
    except Exception as e:
        logging.error(f"SSH-Fehler ({title}): {e}")
    finally:
        session.state   = "disconnected"
        session.process = None
        # WebSocket über Session-Ende informieren
        if session.ws and not session.ws.closed:
            try:
                await session.ws.send_str(json.dumps({"type": "session_ended"}))
                await session.ws.close()
            except Exception:
                pass
            session.ws = None
        await session_manager.remove(session.session_id)
        logging.warning(f"Session beendet: {title} [{session.session_id[:8]}]")


# ============================================================
# WebSocket-Handler
# ============================================================

async def websocket_handler(request):
    """
    Zwei Modi:
    - ?preset=N          → neue Session anlegen
    - ?session_id=UUID   → bestehende Session übernehmen
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    config     = load_config()
    sc         = get_session_config(config)
    client_id  = request.query.get("client_id", "unknown")
    session_id = request.query.get("session_id")

    # ── Bestehende Session übernehmen ──
    if session_id:
        session = await session_manager.get(session_id)
        if not session:
            await ws.send_str(json.dumps({"type": "error", "data": "Session nicht gefunden"}))
            await ws.close()
            return ws

        # Vorherigen WebSocket trennen (Option A: single_user übernimmt)
        if session.ws and not session.ws.closed:
            try:
                await session.ws.send_str(json.dumps({
                    "type": "session_taken_over",
                }))
                await session.ws.close()
            except Exception:
                pass

        session.ws        = ws
        session.client_id = client_id
        session.last_seen = time.time()

        # Warte auf resize
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

        # Scrollback schicken
        buf = session.get_buffer()
        if buf:
            text = buf.decode("utf-8", errors="replace")
            await ws.send_str(json.dumps({"type": "data", "data": text}))

        await ws.send_str(json.dumps({"type": "attached"}))
        logging.warning(f"Reconnect: {session.preset.get('title','?')} [{session_id[:8]}]")

    # ── Neue Session anlegen ──
    else:
        presets = config.get("presets", [])
        preset_index = int(request.query.get("preset", 0))
        if preset_index >= len(presets):
            await ws.send_str(json.dumps({"type": "error", "data": "Ungültiger Preset-Index"}))
            await ws.close()
            return ws

        preset  = presets[preset_index]
        session = await session_manager.create(
            preset, client_id, sc["buffer_size"]
        )
        session.ws = ws

        # Warte auf initiales resize
        cols, rows = 80, 24
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=3.0)
            if msg.type == web.WSMsgType.TEXT:
                payload = json.loads(msg.data)
                if payload["type"] == "resize":
                    cols, rows = payload["cols"], payload["rows"]
        except asyncio.TimeoutError:
            pass

        # Session-ID an Client schicken
        await ws.send_str(json.dumps({
            "type":       "session_created",
            "session_id": session.session_id,
            "title":      preset.get("title", ""),
        }))

        # SSH im Hintergrund starten
        asyncio.create_task(start_ssh_session(session, cols, rows))

    # ── Input-Loop (gemeinsam für beide Modi) ──
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                payload = json.loads(msg.data)
                if payload["type"] == "data" and session.process:
                    session.process.stdin.write(payload["data"].encode("utf-8"))
                elif payload["type"] == "resize" and session.process:
                    session.process.change_terminal_size(
                        payload["cols"], payload["rows"]
                    )
                elif payload["type"] == "close_session":
                    # Explizites Schließen (×-Button)
                    logging.warning(f"Session getrennt (Tab geschlossen): {session.preset.get('title','?')} [{session.session_id[:8]}]")
                    await session_manager._terminate_session(session)
                    break
            elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                break
    finally:
        # WebSocket getrennt — Session bleibt aber am Leben
        if session.ws is ws:
            session.ws        = None
            session.last_seen = time.time()

    return ws


# ============================================================
# HTTP-Handler
# ============================================================

# ============================================================
# SFTP-Handler
# ============================================================

async def sftp_connect_handler(request):
    """POST /sftp/connect — SFTP-Verbindung aufbauen."""
    try:
        body         = await request.json()
        preset_index = int(body.get("preset", 0))
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    config  = load_config()
    presets = config.get("presets", [])
    if preset_index >= len(presets):
        return web.json_response({"ok": False, "error": "Preset nicht gefunden"}, status=404)

    preset    = presets[preset_index]
    sftp_id   = str(_uuid.uuid4())

    client_id = body.get("client_id", "")
    side      = body.get("side", "")
    # side im Preset speichern — einfaches dict erstellen
    preset_with_side = {k: v for k, v in preset.items()}
    preset_with_side["_side"] = side
    session   = await sftp_manager.create(sftp_id, preset_with_side, client_id)
    try:
        kwargs     = await _build_connect_kwargs(preset)
        ssh        = await asyncssh.connect(**kwargs)
        sftp       = await ssh.start_sftp_client()
        session.ssh       = ssh
        session.sftp      = sftp
        session.connected = True
        logging.warning(f"SFTP verbunden: {preset.get('title','?')} [{sftp_id[:8]}]")
        return web.json_response({"ok": True, "sftp_id": sftp_id, "title": preset.get("title","")})
    except Exception as e:
        await sftp_manager.remove(sftp_id)
        logging.error(f"SFTP Verbindungsfehler ({preset.get('title','?')}): {e}")
        return web.json_response({"ok": False, "error": str(e)}, status=500)


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
    config      = load_config()
    sc          = get_session_config(config)
    session_mode = sc["session_mode"]
    client_id   = request.query.get("client_id", "")

    if session_mode == "single_user":
        # Alle gespeicherten Grid-States zurückgeben (letzten nehmen)
        states = [s for s in _grid_states.values() if s]
        state  = states[-1] if states else None
    else:
        state = _grid_states.get(client_id)

    return web.json_response({"ok": True, "state": state})


async def sftp_sessions_handler(request):
    """GET /sftp/sessions?client_id= — gibt SFTP-Sessions zurück.
    single_user: alle Sessions (unabhängig von client_id)
    multi_user:  nur Sessions dieser client_id
    """
    client_id   = request.query.get("client_id", "")
    config      = load_config()
    sc          = get_session_config(config)
    session_mode = sc["session_mode"]

    if session_mode == "single_user":
        all_sessions = await sftp_manager.list_all()
    else:
        all_sessions = await sftp_manager.get_by_client_id(client_id)

    result = []
    for s in all_sessions:
        if s.connected:
            result.append({
                "sftp_id":      s.sftp_id,
                "title":        s.preset.get("title", ""),
                "current_path": s.current_path,
                "side":         s.preset.get("_side", ""),
            })
    return web.json_response(result)


async def sftp_status_handler(request):
    """GET /sftp/{id} — prüft ob SFTP-Session noch aktiv ist."""
    sftp_id = request.match_info["sftp_id"]
    session = await sftp_manager.get(sftp_id)
    if session and session.connected:
        return web.json_response({"ok": True, "sftp_id": sftp_id,
                                  "title": session.preset.get("title","")})
    return web.json_response({"ok": False}, status=404)


async def sftp_disconnect_handler(request):
    """DELETE /sftp/{id} — Verbindung trennen."""
    sftp_id = request.match_info["sftp_id"]
    await sftp_manager.remove(sftp_id)
    return web.json_response({"ok": True})


async def _resolve_uid_gid(sftp, uid_map: dict, gid_map: dict):
    """Liest /etc/passwd und /etc/group vom Remote-Server und füllt uid→name / gid→name Maps."""
    for path, target in (("/etc/passwd", uid_map), ("/etc/group", gid_map)):
        try:
            async with sftp.open(path, "r") as f:
                content = await f.read()
            if isinstance(content, bytes):
                content = content.decode("utf-8", errors="replace")
            for line in content.splitlines():
                parts = line.split(":")
                if len(parts) >= 3:
                    try:
                        target[int(parts[2])] = parts[0]
                    except ValueError:
                        pass
        except Exception:
            pass


# Cache pro sftp_id: (timestamp, uid_map, gid_map)
_uid_gid_cache: dict = {}
_UID_GID_TTL = 300   # 5 Minuten


async def _get_uid_gid_maps(sftp_id: str, sftp) -> tuple:
    """Gibt gecachte (uid_map, gid_map) zurück, lädt bei Bedarf neu."""
    import time as _t
    now = _t.time()
    cached = _uid_gid_cache.get(sftp_id)
    if cached and now - cached[0] < _UID_GID_TTL:
        return cached[1], cached[2]
    uid_map: dict = {}
    gid_map: dict = {}
    await _resolve_uid_gid(sftp, uid_map, gid_map)
    _uid_gid_cache[sftp_id] = (now, uid_map, gid_map)
    return uid_map, gid_map


async def sftp_ls_handler(request):
    """GET /sftp/{id}/ls?path=... — Verzeichnis listen."""
    sftp_id = request.match_info["sftp_id"]
    path    = request.query.get("path", "/")
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)

    try:
        session.last_used = _time.time()
        import stat as _stat
        uid_map, gid_map = await _get_uid_gid_maps(sftp_id, session.sftp)
        entries = await session.sftp.readdir(path)
        result  = []
        for e in entries:
            if e.filename in (".", ".."):
                continue
            attrs   = e.attrs
            perms   = getattr(attrs, "permissions", 0) or 0
            is_link = _stat.S_ISLNK(perms)
            is_dir  = _stat.S_ISDIR(perms)

            # Symlink: Ziel per stat() auflösen um zu prüfen ob es ein Verzeichnis ist
            if is_link:
                try:
                    target_attrs = await session.sftp.stat(f"{path.rstrip('/')}/{e.filename}")
                    target_perms = getattr(target_attrs, "permissions", 0) or 0
                    is_dir = _stat.S_ISDIR(target_perms)
                except Exception:
                    pass  # Broken symlink — bleibt is_dir=False

            result.append({
                "name":        e.filename,
                "is_dir":      is_dir,
                "is_link":     is_link,
                "size":        getattr(attrs, "size", 0) or 0,
                "mtime":       getattr(attrs, "mtime", 0) or 0,
                "permissions": "0" + oct(perms & 0o777)[2:],
                "uid":         getattr(attrs, "uid", None),
                "gid":         getattr(attrs, "gid", None),
                "owner":       (getattr(attrs, "owner", None)
                               or uid_map.get(getattr(attrs, "uid", None))
                               or str(getattr(attrs, "uid", "") or "")),
                "group":       (getattr(attrs, "group", None)
                               or gid_map.get(getattr(attrs, "gid", None))
                               or str(getattr(attrs, "gid", "") or "")),
            })
        # Verzeichnisse zuerst, dann Dateien, alphabetisch
        result.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        return web.json_response({"ok": True, "path": path, "entries": result})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def sftp_mkdir_handler(request):
    """POST /sftp/{id}/mkdir — Verzeichnis anlegen."""
    sftp_id = request.match_info["sftp_id"]
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)
    try:
        body = await request.json()
        path = body["path"]
        await session.sftp.mkdir(path)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def sftp_rename_handler(request):
    """POST /sftp/{id}/rename — Datei/Verzeichnis umbenennen."""
    sftp_id = request.match_info["sftp_id"]
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)
    try:
        body    = await request.json()
        old_path = body["old_path"]
        new_path = body["new_path"]
        await session.sftp.rename(old_path, new_path)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def _sftp_rmtree(sftp, path: str):
    """Löscht rekursiv ein Verzeichnis inkl. Inhalt via SFTP.
    Verwendet lstat um Symlinks nicht zu dereferenzieren."""
    import stat as _stat
    try:
        attrs  = await sftp.lstat(path)
        perms  = getattr(attrs, "permissions", 0) or 0
        is_link = _stat.S_ISLNK(perms)
        is_dir  = _stat.S_ISDIR(perms)
    except Exception:
        is_link = False
        is_dir  = False

    if is_link or not is_dir:
        # Symlinks und Dateien direkt löschen
        try:
            await sftp.remove(path)
        except Exception:
            pass
    else:
        try:
            entries = await sftp.readdir(path)
        except Exception:
            entries = []
        for entry in entries:
            if entry.filename in (".", ".."):
                continue
            child = f"{path.rstrip('/')}/{entry.filename}"
            await _sftp_rmtree(sftp, child)
        await sftp.rmdir(path)


async def sftp_delete_handler(request):
    """POST /sftp/{id}/delete — Datei(en)/Verzeichnis(se) löschen (rekursiv)."""
    sftp_id = request.match_info["sftp_id"]
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)
    try:
        body  = await request.json()
        paths = body["paths"]   # Liste von Pfaden
        for path in paths:
            await _sftp_rmtree(session.sftp, path)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def sftp_download_handler(request):
    """GET /sftp/{id}/download?path=... — Einzelne Datei an Browser schicken."""
    sftp_id = request.match_info["sftp_id"]
    path    = request.query.get("path", "")
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.Response(status=404, text="Nicht verbunden")
    try:
        filename = Path(path).name
        response = web.StreamResponse(headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": "application/octet-stream",
        })
        await response.prepare(request)
        async with session.sftp.open(path, "rb") as f:
            while True:
                chunk = await f.read(262144)
                if not chunk:
                    break
                await response.write(chunk)
        await response.write_eof()
        return response
    except Exception as e:
        return web.Response(status=500, text=str(e))


async def _zip_add_sftp_path(sftp, zip_file, remote_path: str, arcname: str):
    """Fügt remote_path (Datei oder Verzeichnis rekursiv) zum ZipFile hinzu.
    Kompatibel mit Python 3.9+ (kein zipfile.mkdir benötigt)."""
    import stat as _stat, zipfile as _zf
    try:
        attrs  = await sftp.stat(remote_path)
        is_dir = _stat.S_ISDIR(getattr(attrs, "permissions", 0) or 0)
    except Exception:
        is_dir = False

    if is_dir:
        # Verzeichnis-Eintrag kompatibel mit Python 3.9+ anlegen
        dir_info = _zf.ZipInfo(arcname.rstrip("/") + "/")
        dir_info.compress_type = _zf.ZIP_STORED
        zip_file.writestr(dir_info, "")
        entries = await sftp.readdir(remote_path)
        for entry in entries:
            if entry.filename in (".", ".."):
                continue
            child_remote = f"{remote_path.rstrip('/')}/{entry.filename}"
            child_arc    = f"{arcname}/{entry.filename}"
            await _zip_add_sftp_path(sftp, zip_file, child_remote, child_arc)
    else:
        data = bytearray()
        async with sftp.open(remote_path, "rb") as f:
            while True:
                chunk = await f.read(262144)
                if not chunk:
                    break
                data.extend(chunk)
        zip_file.writestr(arcname, bytes(data))


async def sftp_download_zip_handler(request):
    """POST /sftp/{id}/download-zip — Mehrere Dateien/Verzeichnisse als ZIP herunterladen."""
    sftp_id = request.match_info["sftp_id"]
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.Response(status=404, text="Nicht verbunden")
    try:
        body  = await request.json()
        paths = body.get("paths", [])
        name  = body.get("name", "download")   # Basis-Name für die ZIP-Datei
        if not paths:
            return web.Response(status=400, text="Keine Pfade angegeben")

        import zipfile as _zf, io as _io
        buf      = _io.BytesIO()
        zip_file = _zf.ZipFile(buf, "w", compression=_zf.ZIP_DEFLATED)

        for path in paths:
            arcname = Path(path).name
            await _zip_add_sftp_path(session.sftp, zip_file, path, arcname)

        zip_file.close()
        zip_bytes = buf.getvalue()

        return web.Response(
            body=zip_bytes,
            headers={
                "Content-Disposition": f'attachment; filename="{name}.zip"',
                "Content-Type": "application/zip",
            }
        )
    except Exception as e:
        return web.Response(status=500, text=str(e))


# Maximale Dateigröße für Vorschau (512 KB)
PREVIEW_MAX_BYTES = 524288

async def sftp_preview_handler(request):
    """GET /sftp/{id}/preview?path=... — Dateiinhalt als Text für Vorschau.
    Prüft ob die Datei Text (ASCII/UTF-8) ist, liefert max. PREVIEW_MAX_BYTES."""
    sftp_id = request.match_info["sftp_id"]
    path    = request.query.get("path", "")
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)
    try:
        # Größe prüfen
        attrs = await session.sftp.stat(path)
        size  = getattr(attrs, "size", 0) or 0

        # Erste 512 Bytes lesen um Typ zu erkennen
        async with session.sftp.open(path, "rb") as f:
            probe = await f.read(512)

        # Binär-Check: Nullbytes → Binärdatei
        if b"\x00" in probe:
            return web.json_response({"ok": False, "binary": True})

        # Versuche als UTF-8 zu dekodieren, dann als Latin-1
        truncated = size > PREVIEW_MAX_BYTES
        async with session.sftp.open(path, "rb") as f:
            raw = await f.read(PREVIEW_MAX_BYTES)

        try:
            text = raw.decode("utf-8")
            encoding = "UTF-8"
        except UnicodeDecodeError:
            try:
                text = raw.decode("latin-1")
                encoding = "Latin-1"
            except Exception:
                return web.json_response({"ok": False, "binary": True})

        return web.json_response({
            "ok":        True,
            "text":      text,
            "encoding":  encoding,
            "size":      size,
            "truncated": truncated,
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def sftp_upload_handler(request):
    """POST /sftp/{id}/upload — Datei vom Browser auf Server laden, mit Konfliktprüfung."""
    sftp_id = request.match_info["sftp_id"]
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)
    try:
        import uuid as _u
        reader   = await request.multipart()
        field    = await reader.next()
        dest_dir = request.query.get("path", "/")
        filename = field.filename
        dest     = f"{dest_dir.rstrip('/')}/{filename}"

        # Konfliktprüfung
        action = request.query.get("action", None)  # vorab-Entscheidung vom Frontend
        if action is None:
            dest_exists = False
            try:
                await session.sftp.stat(dest)
                dest_exists = True
            except Exception:
                pass
            if dest_exists:
                # Konflikt melden — Frontend muss erneut mit action= aufrufen
                return web.json_response({
                    "ok": False, "conflict": True, "file": filename
                }, status=409)

        if action == "skip":
            return web.json_response({"ok": True, "skipped": True, "path": dest})

        async with session.sftp.open(dest, "wb") as f:
            while True:
                chunk = await field.read_chunk(262144)
                if not chunk:
                    break
                await f.write(chunk)
        return web.json_response({"ok": True, "path": dest})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


# Laufende Kopier-Vorgänge: copy_id → asyncio.Event + Antwort
_copy_conflicts: dict[str, dict] = {}

# Grid-State pro client_id: { layout, cells: [{session_id, preset, side}] }
_grid_states: dict[str, dict] = {}


async def sftp_conflict_resolve_handler(request):
    """POST /sftp/conflict-resolve — Antwort auf Konflikt-Dialog."""
    try:
        body    = await request.json()
        copy_id = body["copy_id"]
        action  = body["action"]   # "overwrite" | "skip" | "overwrite_all" | "skip_all" | "abort"
    except Exception:
        return web.json_response({"ok": False}, status=400)

    if copy_id in _copy_conflicts:
        entry = _copy_conflicts[copy_id]
        if action == "abort":
            # Immer abort_event setzen — funktioniert auch ohne wartenden Konflikt-Dialog
            entry["aborted"] = True
            entry["abort"].set()
            entry["action"] = "abort"
            entry["event"].set()   # falls gerade auf Konflikt gewartet wird
        else:
            entry["action"] = action
            entry["event"].set()
        return web.json_response({"ok": True})
    return web.json_response({"ok": False, "error": "Unbekannte copy_id"}, status=404)


async def _sftp_count_files(sftp, path: str) -> int:
    """Zählt rekursiv alle Dateien (keine Verzeichnisse) unter path.
    Broken Symlinks werden als 1 Datei gezählt und still übersprungen."""
    import stat as _stat
    try:
        # lstat: Symlinks nicht folgen — werden als 1 gezählt (werden als Symlink kopiert)
        attrs  = await sftp.lstat(path)
        perms  = getattr(attrs, "permissions", 0) or 0
        is_dir = _stat.S_ISDIR(perms)
        if _stat.S_ISLNK(perms):
            return 1   # Symlink → zählt als eine Einheit
    except Exception:
        return 1
    if not is_dir:
        return 1
    try:
        entries = await sftp.readdir(path)
    except Exception:
        return 0
    total = 0
    for entry in entries:
        if entry.filename in (".", ".."):
            continue
        total += await _sftp_count_files(sftp, f"{path.rstrip('/')}/{entry.filename}")
    return total


async def _sftp_copy_recursive(src_sftp, src_path: str, dst_sftp, dst_path: str,
                               send, conflict_entry: dict,
                               counters: dict) -> bool:
    """
    Kopiert src_path (Datei oder Verzeichnis) rekursiv nach dst_path.
    Gibt False zurück wenn abgebrochen wurde.
    counters: {"copied": int, "errors": list, "global_action": str|None, "aborted": bool, "total": int}
    """
    import stat as _stat, json as _j

    # Typ bestimmen — lstat um Symlinks nicht zu dereferenzieren
    try:
        lattrs  = await src_sftp.lstat(src_path)
        lperms  = getattr(lattrs, "permissions", 0) or 0
        is_link = _stat.S_ISLNK(lperms)
        is_dir  = _stat.S_ISDIR(lperms)
    except Exception as e:
        counters["errors"].append(f"{Path(src_path).name}: lstat fehlgeschlagen: {e}")
        return True

    # Symlink als Symlink reproduzieren (nicht dereferenzieren)
    if is_link:
        filename = Path(src_path).name
        try:
            target = await src_sftp.readlink(src_path)
            await dst_sftp.symlink(target, dst_path)
            counters["copied"] += 1
        except Exception as e:
            counters["errors"].append(f"{filename}: symlink fehlgeschlagen: {e}")
        return True

    if is_dir:
        # Zielverzeichnis anlegen falls nicht vorhanden
        try:
            await dst_sftp.stat(dst_path)
        except Exception:
            try:
                await dst_sftp.mkdir(dst_path)
            except Exception as e:
                counters["errors"].append(f"{Path(src_path).name}: mkdir fehlgeschlagen: {e}")
                return True

        # Inhalt rekursiv kopieren
        try:
            entries = await src_sftp.readdir(src_path)
        except Exception as e:
            counters["errors"].append(f"{Path(src_path).name}: readdir fehlgeschlagen: {e}")
            return True

        for entry in entries:
            if entry.filename in (".", ".."):
                continue
            if counters["aborted"]:
                return False
            child_src = f"{src_path.rstrip('/')}/{entry.filename}"
            child_dst = f"{dst_path.rstrip('/')}/{entry.filename}"
            ok = await _sftp_copy_recursive(
                src_sftp, child_src, dst_sftp, child_dst,
                send, conflict_entry, counters
            )
            if not ok:
                return False
        return True

    else:
        # Datei kopieren — Konfliktbehandlung
        filename = Path(src_path).name

        # Abbruch prüfen
        if counters.get("abort_event") and counters["abort_event"].is_set():
            counters["aborted"] = True
            return False

        await send({"type": "progress", "file": filename,
                    "current": counters["copied"] + 1, "total": counters["total"]})

        dest_exists = False
        try:
            await dst_sftp.stat(dst_path)
            dest_exists = True
        except Exception:
            pass

        action = counters["global_action"]

        if dest_exists and action is None:
            conflict_entry["event"].clear()
            conflict_entry["action"] = None
            await send({"type": "conflict", "file": filename})
            try:
                await asyncio.wait_for(conflict_entry["event"].wait(), timeout=300)
            except asyncio.TimeoutError:
                counters["aborted"] = True
                return False
            action = conflict_entry["action"]
            if action == "overwrite_all":
                counters["global_action"] = "overwrite"
                action = "overwrite"
            elif action == "skip_all":
                counters["global_action"] = "skip"
                action = "skip"
            elif action == "abort":
                counters["aborted"] = True
                return False

        if action == "skip" or (dest_exists and action is None):
            await send({"type": "skipped", "file": filename})
            return True

        try:
            async with src_sftp.open(src_path, "rb") as src_f:
                async with dst_sftp.open(dst_path, "wb") as dst_f:
                    while True:
                        chunk = await src_f.read(262144)
                        if not chunk:
                            break
                        await dst_f.write(chunk)
            counters["copied"] += 1
        except Exception as e:
            counters["errors"].append(f"{filename}: {e}")
        return True


async def sftp_copy_handler(request):
    """POST /sftp/copy — Server-zu-Server Transfer (rekursiv) mit SSE-Fortschritt."""
    try:
        body     = await request.json()
        src_id   = body["src_sftp_id"]
        src_path = body["src_path"]      # Liste von Pfaden (Dateien und/oder Verzeichnisse)
        dst_id   = body["dst_sftp_id"]
        dst_dir  = body["dst_dir"]
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    src = await sftp_manager.get(src_id)
    dst = await sftp_manager.get(dst_id)
    if not src or not src.sftp:
        return web.json_response({"ok": False, "error": "Quell-SFTP nicht verbunden"}, status=404)
    if not dst or not dst.sftp:
        return web.json_response({"ok": False, "error": "Ziel-SFTP nicht verbunden"}, status=404)

    import json as _j, uuid as _u
    copy_id = str(_u.uuid4())

    response = web.StreamResponse(headers={
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "X-Accel-Buffering": "no",
    })
    await response.prepare(request)

    async def send(data: dict):
        await response.write(f"data: {_j.dumps(data)}\n\n".encode())

    abort_event    = asyncio.Event()
    conflict_entry = {"event": asyncio.Event(), "action": None, "abort": abort_event}
    _copy_conflicts[copy_id] = conflict_entry

    # Gesamtanzahl Dateien zählen (rekursiv) für korrekten Fortschrittsbalken
    await send({"type": "counting"})
    total_files = 0
    for path in src_path:
        total_files += await _sftp_count_files(src.sftp, path)
    total_files = max(total_files, 1)  # Division-by-zero Schutz

    await send({"type": "start", "copy_id": copy_id, "total": total_files})

    counters = {
        "copied":        0,
        "errors":        [],
        "global_action": None,
        "aborted":       False,
        "total":         total_files,
        "abort_event":   abort_event,
    }

    try:
        for path in src_path:
            if counters["aborted"]:
                break
            name     = Path(path).name
            dst_path = f"{dst_dir.rstrip('/')}/{name}"
            ok = await _sftp_copy_recursive(
                src.sftp, path, dst.sftp, dst_path,
                send, conflict_entry, counters
            )
            if not ok:
                break
    finally:
        _copy_conflicts.pop(copy_id, None)

    if counters["aborted"]:
        await send({"type": "done", "ok": False, "aborted": True, "copied": counters["copied"]})
    elif counters["errors"]:
        await send({"type": "done", "ok": False, "errors": counters["errors"], "copied": counters["copied"]})
    else:
        await send({"type": "done", "ok": True, "count": counters["copied"]})

    await response.write_eof()
    return response


async def login_page_handler(request):
    return web.FileResponse(BASE_DIR / "templates" / "login.html")


async def setup_page_handler(request):
    """Ersteinrichtung — wird angezeigt wenn kein Passwort gesetzt ist."""
    return web.FileResponse(BASE_DIR / "templates" / "setup.html")


async def setup_handler(request):
    """POST /auth/setup — erstes Passwort setzen."""
    if auth_manager.has_password():
        return web.json_response({"ok": False, "error": "Passwort bereits gesetzt"}, status=400)
    try:
        body     = await request.json()
        password = body.get("password", "")
        confirm  = body.get("confirm", "")
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    if len(password) < 8:
        return web.json_response({"ok": False, "error": "Mindestens 8 Zeichen"}, status=400)
    if password != confirm:
        return web.json_response({"ok": False, "error": "Passwörter stimmen nicht überein"}, status=400)

    auth_manager.set_password(password)
    logging.warning(f"Erstpasswort gesetzt von {request.remote}")

    # Direkt einloggen
    config       = load_config()
    sc           = get_session_config(config)
    token        = auth_manager.create_token(sc["session_mode"])
    cfg_auth     = config.get("auth", {})
    timeout      = cfg_auth.get("session_timeout", 86400)

    resp = web.json_response({"ok": True})
    resp.set_cookie("webssh_token", token, max_age=timeout, httponly=True, samesite="Strict")
    return resp


async def change_password_handler(request):
    """POST /auth/change-password — Passwort ändern (erfordert aktuelles Passwort)."""
    token = request.cookies.get("webssh_token", "")
    if not auth_manager.validate_token(token):
        return web.json_response({"ok": False, "error": "Nicht eingeloggt"}, status=401)

    try:
        body        = await request.json()
        current_pw  = body.get("current_password", "")
        new_pw      = body.get("new_password", "")
        confirm_pw  = body.get("confirm_password", "")
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    if not auth_manager.verify_password(current_pw):
        return web.json_response({"ok": False, "error": "Aktuelles Passwort falsch"}, status=401)
    if len(new_pw) < 8:
        return web.json_response({"ok": False, "error": "Mindestens 8 Zeichen"}, status=400)
    if new_pw != confirm_pw:
        return web.json_response({"ok": False, "error": "Neue Passwörter stimmen nicht überein"}, status=400)

    auth_manager.set_password(new_pw)
    logging.warning(f"Passwort geändert von {request.remote}")
    return web.json_response({"ok": True})


async def login_handler(request):
    """POST /auth/login — Passwort prüfen, Token setzen."""
    ip = request.remote

    # Rate-Limit prüfen
    allowed, retry_after = auth_manager.check_rate_limit(ip)
    if not allowed:
        return web.json_response(
            {"ok": False, "error": f"Zu viele Versuche", "retry_after": retry_after},
            status=429
        )

    try:
        body = await request.json()
        password = body.get("password", "")
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    auth_manager.record_attempt(ip)

    if not auth_manager.verify_password(password):
        logging.warning(f"Login fehlgeschlagen von {ip}")
        return web.json_response({"ok": False, "error": "Falsches Passwort"}, status=401)

    # Erfolg — Token erstellen
    auth_manager.clear_attempts(ip)
    config       = load_config()
    sc           = get_session_config(config)
    session_mode = sc["session_mode"]
    cfg_auth     = config.get("auth", {})
    timeout      = cfg_auth.get("session_timeout", 86400)
    token        = auth_manager.create_token(session_mode)

    logging.warning(f"Login erfolgreich von {ip} (mode={session_mode})")

    resp = web.json_response({"ok": True})
    resp.set_cookie(
        "webssh_token", token,
        max_age=timeout,
        httponly=True,
        samesite="Strict",
    )
    return resp


async def logout_handler(request):
    """POST+GET /auth/logout — Token ungültig machen, Sessions schließen, Cookie löschen."""
    token = request.cookies.get("webssh_token", "")
    auth_manager.revoke_token(token)

    # Alle aktiven Sessions beenden
    all_sessions = await session_manager.list_all()
    for session in all_sessions:
        logging.warning(f"Logout: Session beendet: {session.preset.get('title','?')} [{session.session_id[:8]}]")
        await session_manager._terminate_session(session)

    resp = web.HTTPFound("/auth/login")
    resp.set_cookie("webssh_token", "", max_age=0, httponly=True, samesite="Strict")
    return resp


async def index_handler(request):
    resp = web.FileResponse(BASE_DIR / "templates" / "index.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


async def presets_handler(request):
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
            "font":     p.get("font", None),  # optionale Font-Überschreibung
        }
        for i, p in enumerate(presets)
    ])


async def terminal_config_handler(request):
    config = load_config()
    term   = config.get("terminal", {})
    fonts  = config.get("fonts", {})
    tf     = fonts.get("terminal", {})
    uf     = fonts.get("ui", {})
    tbf    = fonts.get("toolbar", {})
    sc     = get_session_config(config)
    return web.json_response({
        # Terminal-Font (global)
        "font_size":           tf.get("size", 14),
        "font_family":         tf.get("family", "DejaVuSansMono"),
        "font_file":           "/fonts/" + Path(tf.get("file", "fonts/DejaVuSansMono.ttf")).name,
        "font_file_bold":      "/fonts/" + Path(tf.get("file_bold", "fonts/DejaVuSansMono-Bold.ttf")).name,
        "font_format":         FONT_FORMAT_MAP.get(Path(tf.get("file", ".ttf")).suffix.lower(), "truetype"),
        # UI
        "ui_font_size":        uf.get("size", 13),
        "kb_font_size":        tbf.get("size", 11),
        # Terminal-Verhalten
        "close_on_disconnect": term.get("close_on_disconnect", False),
        "close_delay":         term.get("close_delay", 3),
        "show_active_sessions": term.get("show_active_sessions", True),
        # Sessions
        "persist_sessions":    sc["persist"],
        "session_mode":        sc["session_mode"],
        "auth_enabled":        auth_manager.auth_required(),
        "sftp_font_size":      config.get("fonts", {}).get("sftp", {}).get("size", 12),
        "preview_font_size":   config.get("fonts", {}).get("preview", {}).get("size", 13),
        "preview_font_family": config.get("fonts", {}).get("preview", {}).get("family", ""),
        "settings_font_size":  config.get("fonts", {}).get("settings", {}).get("size", 13),
        "log_font_size":       config.get("fonts", {}).get("log", {}).get("size", 12),
        "log_font_family":     config.get("fonts", {}).get("log", {}).get("family", ""),
        "grid_fonts": {
            "2x1": config.get("fonts", {}).get("grid_2x1", {}),
            "1x2": config.get("fonts", {}).get("grid_1x2", {}),
            "2x2": config.get("fonts", {}).get("grid_2x2", {}),
        },
        "header_btn_size":     config.get("fonts", {}).get("header", {}).get("size", 14),
        "log_level":           config.get("log_level", "WARNING"),
    })


async def sessions_handler(request):
    """Liefert Liste der aktiven Sessions (gefiltert nach session_mode)."""
    config    = load_config()
    sc        = get_session_config(config)
    client_id = request.query.get("client_id", "")

    if sc["session_mode"] == "single_user":
        sessions = await session_manager.list_all()
    else:
        sessions = await session_manager.list_for_client(client_id)

    return web.json_response([s.to_dict() for s in sessions])


def save_config(config):
    """
    Schreibt die Konfiguration zurück in config.yml.
    Nutzt ruamel.yaml um Kommentare, Leerzeilen und Schlüsselreihenfolge zu erhalten.
    config kann ein ruamel.yaml CommentedMap oder ein normales dict sein.
    """
    global _config_cache, _config_mtime
    with open(CONFIG_FILE, "w") as f:
        _yaml.dump(config, f)
    # Cache invalidieren damit der nächste load_config() frisch liest
    _config_cache = None
    _config_mtime = 0.0


def load_config_raw():
    """
    Lädt config.yml als ruamel.yaml CommentedMap (erhält Kommentare).
    Nur für save_config verwenden.
    """
    with open(CONFIG_FILE) as f:
        return _yaml.load(f)


async def config_get_handler(request):
    """Liefert die gesamte Konfiguration ans Frontend."""
    config = load_config()
    import json as _json
    safe = _json.loads(_json.dumps(dict(config)))  # deep copy als plain dict
    return web.json_response(safe)


async def config_patch_handler(request):
    """
    Aktualisiert einen Teil der Konfiguration.
    Body: { "path": ["sessions", "persist"], "value": true }
    Oder für Presets: { "path": ["presets"], "value": [...] }
    """
    try:
        body = await request.json()
        path  = body["path"]    # Liste von Schlüsseln, z.B. ["fonts", "terminal", "size"]
        value = body["value"]
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    config = load_config()

    # Nested update — zum Pfad navigieren und Wert setzen
    node = config
    for key in path[:-1]:
        if key not in node:
            node[key] = {}
        node = node[key]

    last_key = path[-1]

    # Spezialfall: Preset-Array — mit Kommentarerhalt und Passwort-Handling
    if path == ["presets"] and isinstance(value, list):
        raw_config = load_config_raw()
        existing   = {str(p.get("title","")): p for p in raw_config.get("presets", [])}

        # Definierte Schlüsselreihenfolge pro Preset
        KEY_ORDER = ["title", "category", "host", "port", "username",
                     "private_key", "password", "font"]

        from ruamel.yaml.comments import CommentedMap
        ordered_presets = []
        for p in value:
            # Schlüssel in definierter Reihenfolge
            cm = CommentedMap()
            for key in KEY_ORDER:
                if key in p and p[key] is not None and p[key] != "":
                    cm[key] = p[key]
            # Unbekannte Schlüssel anhängen
            for key, val in p.items():
                if key not in KEY_ORDER:
                    cm[key] = val
            ordered_presets.append(cm)

        raw_config["presets"] = ordered_presets
        # Leerzeile nach jedem Preset: nach dem Dump per String einfügen
        import io, re as _re
        buf = io.StringIO()
        _yaml.dump(raw_config, buf)
        yml_str = buf.getvalue()
        yml_str = _re.sub(r'\n{2,}(- title:)', r'\n\n\1', yml_str)
        with open(CONFIG_FILE, "w") as _f:
            _f.write(yml_str)
        # Cache invalidieren
        global _config_cache, _config_mtime
        _config_cache = None
        _config_mtime = 0.0
        logging.warning("Config geändert: presets")
        return web.json_response({"ok": True})

    # Alle anderen Pfade: raw laden um Kommentare zu erhalten
    raw_config = load_config_raw()
    raw_node   = raw_config
    for key in path[:-1]:
        if key not in raw_node:
            from ruamel.yaml.comments import CommentedMap
            raw_node[key] = CommentedMap()
        raw_node = raw_node[key]
    raw_node[path[-1]] = value
    save_config(raw_config)

    logging.warning(f"Config geändert: {'.'.join(str(k) for k in path)}")
    # Log-Level live aktualisieren wenn er geändert wurde
    if "log_level" in path:
        new_level = get_log_level(load_config())
        logging.getLogger().setLevel(new_level)
        logging.warning(f"Log-Level geändert auf {logging.getLevelName(new_level)}")
    return web.json_response({"ok": True})


# Font-Formate die vom Browser unterstützt werden
FONT_EXTENSIONS = {".ttf", ".otf", ".woff", ".woff2"}
FONT_FORMAT_MAP = {
    ".ttf":   "truetype",
    ".otf":   "opentype",
    ".woff":  "woff",
    ".woff2": "woff2",
}
# Suffixe die als Regular-Variante erkannt werden (moderne Konvention)
REGULAR_SUFFIXES = ["-Regular", "_Regular", "-regular", "_regular"]
# Suffixe die als Bold-Variante erkannt werden
BOLD_SUFFIXES    = ["-Bold", "_Bold", "-bold", "_bold"]
# Andere Schnitte die ignoriert werden sollen
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
    Scannt das konfigurierte Fonts-Verzeichnis nach Font-Dateien und gruppiert
    sie in Regular+Bold Paare.

    Unterstützt zwei Konventionen:
      Modern:  FontName-Regular.ttf + FontName-Bold.ttf  → Name: "FontName"
      Klassisch: FontName.ttf + FontName-Bold.ttf        → Name: "FontName"

    Andere Schnitte (Italic, Light, Thin, etc.) werden ignoriert.
    """
    if config is None:
        config = load_config()
    fonts_dir_str = config.get("paths", {}).get("fonts", "")
    fonts_dir     = Path(fonts_dir_str) if fonts_dir_str else BASE_DIR / "static" / "fonts"
    if not fonts_dir.exists():
        return []

    files = {f for f in fonts_dir.iterdir() if f.suffix.lower() in FONT_EXTENSIONS}

    # Basis-URL für @font-face src

    # Dateien nach Typ klassifizieren
    regular_files = {f for f in files if any(f.stem.endswith(s) for s in REGULAR_SUFFIXES)}
    bold_files    = {f for f in files if any(f.stem.endswith(s) for s in BOLD_SUFFIXES)}
    ignore_files  = {f for f in files if any(f.stem.endswith(s) for s in IGNORE_SUFFIXES)}
    # Klassisch: weder Regular- noch Bold- noch anderer Schnitt → potenzielle Regular-Datei
    plain_files   = files - regular_files - bold_files - ignore_files

    result = []

    # 1. Moderne Konvention: -Regular Dateien als Basis
    for reg in sorted(regular_files):
        # Basis-Name: "FontName-Regular" → "FontName"
        base = reg.stem
        for s in REGULAR_SUFFIXES:
            if base.endswith(s):
                base = base[:-len(s)]
                break

        # Passende Bold-Datei suchen
        bold_file = None
        for s in BOLD_SUFFIXES:
            for ext in [reg.suffix, *[e for e in FONT_EXTENSIONS if e != reg.suffix]]:
                candidate = reg.with_name(base + s + ext)
                if candidate in bold_files:
                    bold_file = candidate
                    break
            if bold_file:
                break

        fmt = FONT_FORMAT_MAP.get(reg.suffix.lower(), "truetype")
        result.append({
            "name":      base,
            "file":      f"/fonts/{reg.name}",
            "file_bold": f"/fonts/{bold_file.name}" if bold_file else None,
            "format":    fmt,
        })

    # 2. Klassische Konvention: Dateien ohne Regular/Bold-Suffix
    for plain in sorted(plain_files):
        base = plain.stem

        # Passende Bold-Datei suchen
        bold_file = None
        for s in BOLD_SUFFIXES:
            candidate = plain.with_name(base + s + plain.suffix)
            if candidate in bold_files:
                bold_file = candidate
                break

        fmt = FONT_FORMAT_MAP.get(plain.suffix.lower(), "truetype")
        result.append({
            "name":      base,
            "file":      f"/fonts/{plain.name}",
            "file_bold": f"/fonts/{bold_file.name}" if bold_file else None,
            "format":    fmt,
        })

    return sorted(result, key=lambda f: f["name"].lower())


async def fonts_handler(request):
    """Liefert alle verfügbaren Fonts aus dem konfigurierten Fonts-Verzeichnis."""
    config = load_config()
    fonts  = scan_fonts(config)
    return web.json_response(fonts)


async def font_file_handler(request):
    """GET /fonts/{filename} — liefert Font-Datei aus dem konfigurierten Verzeichnis."""
    filename = request.match_info["filename"]
    config   = load_config()
    fonts_dir_str = config.get("paths", {}).get("fonts", "")
    fonts_dir = Path(fonts_dir_str) if fonts_dir_str else BASE_DIR / "static" / "fonts"
    font_path = (fonts_dir / filename).resolve()

    # Sicherheit: kein path traversal
    try:
        font_path.relative_to(fonts_dir.resolve())
    except ValueError:
        return web.Response(status=403)

    if not font_path.exists() or font_path.suffix.lower() not in FONT_EXTENSIONS:
        return web.Response(status=404)

    content_types = {
        ".ttf":  "font/ttf",
        ".otf":  "font/otf",
        ".woff": "font/woff",
        ".woff2":"font/woff2",
    }
    ct = content_types.get(font_path.suffix.lower(), "application/octet-stream")
    return web.FileResponse(font_path, headers={"Content-Type": ct})


async def keys_handler(request):
    """Liefert alle verfügbaren SSH-Keys aus dem konfigurierten Key-Ordner."""
    config   = load_config()
    key_dir  = config.get("paths", {}).get("ssh_keys", "")
    if not key_dir:
        return web.json_response([])

    key_path = Path(key_dir)
    if not key_path.exists() or not key_path.is_dir():
        return web.json_response([])

    # Ausschlussliste aus Config lesen (kommagetrennt)
    exclude_raw = config.get("paths", {}).get("ssh_keys_exclude", "")
    excludes    = {e.strip() for e in exclude_raw.split(",") if e.strip()}
    # Immer ausschließen: bekannte Nicht-Key-Dateien
    excludes.update({"authorized_keys", "authorized_keys2", "known_hosts",
                     "known_hosts.old", "config", "environment"})

    # Private Keys: nur Dateien OHNE Dateiendung (wie ssh-keygen Standard)
    keys = sorted([
        f.name for f in key_path.iterdir()
        if f.is_file()
        and not f.name.startswith(".")   # keine versteckten Dateien
        and f.suffix == ""               # keine Dateiendung → Private Key
        and f.name not in excludes       # nicht in Ausschlussliste
    ])
    return web.json_response(keys)


async def presets_hash_handler(request):
    """Liefert einen Hash der aktuellen Preset-Liste für Cache-Invalidierung."""
    config  = load_config()
    presets = config.get("presets", [])
    import hashlib, json as _json
    data = sorted(
        [{"title":    p.get("title", ""),
          "host":     p.get("host", ""),
          "port":     p.get("port", 22),
          "category": p.get("category", "")}
         for p in presets],
        key=lambda p: p["title"]
    )
    h = hashlib.md5(_json.dumps(data, sort_keys=True).encode()).hexdigest()[:8]
    return web.json_response({"hash": h})



# ============================================================
# Preset Export / Import
# ============================================================

def _derive_key(password: str, salt: bytes) -> bytes:
    """Leitet einen AES-256-GCM Schluessel aus password + salt ab (PBKDF2-HMAC-SHA256)."""
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=480000)
    return kdf.derive(password.encode())


def _encrypt_value(value: str, password: str) -> dict:
    """Verschluesselt einen String mit AES-256-GCM."""
    import os
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt  = os.urandom(16)
    nonce = os.urandom(12)
    key   = _derive_key(password, salt)
    ct    = AESGCM(key).encrypt(nonce, value.encode(), None)
    return {"salt": salt.hex(), "nonce": nonce.hex(), "ct": ct.hex()}


def _decrypt_value(enc: dict, password: str) -> str:
    """Entschluesselt einen mit _encrypt_value verschluesselten Wert."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
    salt  = bytes.fromhex(enc["salt"])
    nonce = bytes.fromhex(enc["nonce"])
    ct    = bytes.fromhex(enc["ct"])
    key   = _derive_key(password, salt)
    try:
        return AESGCM(key).decrypt(nonce, ct, None).decode()
    except (InvalidTag, Exception) as e:
        raise ValueError("Falsches Passwort oder beschaedigte Datei") from e


async def preset_export_handler(request):
    """POST /presets/export - Presets als verschluesselte JSON-Datei exportieren."""
    try:
        body     = await request.json()
        password = body.get("password", "")
    except Exception:
        return web.json_response({"ok": False, "error": "Ungultiger Body"}, status=400)

    if not password:
        return web.json_response({"ok": False, "error": "Kein Passwort angegeben"}, status=400)

    config  = load_config()
    presets = config.get("presets", [])

    EXPORT_FIELDS  = ["title", "category", "host", "port", "username",
                      "private_key", "password", "font"]
    ENCRYPT_FIELDS = {"password"}

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

    import json as _json
    payload = _json.dumps({"version": 2, "presets": export_presets},
                          ensure_ascii=False, indent=2)
    return web.Response(
        body=payload.encode(),
        headers={
            "Content-Disposition": 'attachment; filename="webssh-presets.json"',
            "Content-Type": "application/json",
        }
    )


async def preset_import_handler(request):
    """POST /presets/import - Verschluesselte Preset-Datei importieren."""
    try:
        reader    = await request.multipart()
        password  = ""
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

    import json as _json
    try:
        data = _json.loads(file_data.decode())
    except Exception:
        return web.json_response({"ok": False, "error": "Ungultige JSON-Datei"}, status=400)

    raw_presets = data.get("presets", [])
    if not isinstance(raw_presets, list):
        return web.json_response({"ok": False, "error": "Ungultiges Format"}, status=400)

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

    from ruamel.yaml.comments import CommentedMap
    KEY_ORDER = ["title", "category", "host", "port", "username",
                 "private_key", "password", "font"]
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
    logging.warning(f"Presets importiert: {len(imported)} Eintraege")
    return web.json_response({"ok": True, "count": len(imported)})


async def sftp_dirsize_handler(request):
    """GET /sftp/{id}/dirsize?path=... — Berechnet rekursiv die Größe eines Verzeichnisses."""
    sftp_id = request.match_info["sftp_id"]
    path    = request.query.get("path", "/")
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)
    try:
        import stat as _stat
        total = 0
        count = 0

        async def _sum(p):
            nonlocal total, count
            try:
                attrs  = await session.sftp.lstat(p)
                perms  = getattr(attrs, "permissions", 0) or 0
                if _stat.S_ISLNK(perms):
                    return
                if _stat.S_ISDIR(perms):
                    entries = await session.sftp.readdir(p)
                    for e in entries:
                        if e.filename in (".", ".."):
                            continue
                        await _sum(f"{p.rstrip('/')}/{e.filename}")
                else:
                    total += getattr(attrs, "size", 0) or 0
                    count += 1
            except Exception:
                pass

        await _sum(path)
        return web.json_response({"ok": True, "size": total, "files": count})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def log_handler(request):
    """GET /log?since=<timestamp> — Log-Einträge seit timestamp (Unix-Sekunden)."""
    since = float(request.query.get("since", 0))
    entries = _mem_log.get_entries(since)
    return web.json_response(entries)


async def close_session_handler(request):
    """Beendet eine Session explizit (DELETE /sessions/{id})."""
    session_id = request.match_info["session_id"]
    session    = await session_manager.get(session_id)
    if session:
        await session_manager._terminate_session(session)
        return web.json_response({"ok": True})
    return web.json_response({"ok": False, "error": "nicht gefunden"}, status=404)


# ============================================================
# App-Setup
# ============================================================

async def on_startup(app):
    asyncio.create_task(cleanup_task())




def create_app():
    app = web.Application(middlewares=[auth_middleware], client_max_size=2 * 1024**3)  # 2 GB Upload-Limit
    app.on_startup.append(on_startup)

    # SFTP
    app.router.add_post("/sftp/connect",             sftp_connect_handler)
    app.router.add_post("/sftp/copy",                sftp_copy_handler)
    app.router.add_post("/sftp/conflict-resolve",    sftp_conflict_resolve_handler)
    app.router.add_post("/grid-state",               grid_state_save_handler)
    app.router.add_get("/grid-state",                grid_state_load_handler)
    app.router.add_get("/sftp/sessions",             sftp_sessions_handler)
    app.router.add_get("/sftp/{sftp_id}",            sftp_status_handler)
    app.router.add_delete("/sftp/{sftp_id}",         sftp_disconnect_handler)
    app.router.add_get("/sftp/{sftp_id}/ls",         sftp_ls_handler)
    app.router.add_post("/sftp/{sftp_id}/mkdir",     sftp_mkdir_handler)
    app.router.add_post("/sftp/{sftp_id}/rename",    sftp_rename_handler)
    app.router.add_post("/sftp/{sftp_id}/delete",    sftp_delete_handler)
    app.router.add_get("/sftp/{sftp_id}/download",   sftp_download_handler)
    app.router.add_get("/sftp/{sftp_id}/preview",    sftp_preview_handler)
    app.router.add_post("/sftp/{sftp_id}/download-zip", sftp_download_zip_handler)
    app.router.add_post("/sftp/{sftp_id}/upload",    sftp_upload_handler)
    # Auth
    app.router.add_get("/auth/login",                login_page_handler)
    app.router.add_post("/auth/login",               login_handler)
    app.router.add_post("/auth/logout",              logout_handler)
    app.router.add_get("/auth/logout",               logout_handler)
    app.router.add_get("/auth/setup",                setup_page_handler)
    app.router.add_post("/auth/setup",               setup_handler)
    app.router.add_post("/auth/change-password",     change_password_handler)
    app.router.add_get("/",                          index_handler)
    app.router.add_get("/presets",                   presets_handler)
    app.router.add_get("/config/terminal",           terminal_config_handler)
    app.router.add_get("/sessions",                  sessions_handler)
    app.router.add_get("/presets/hash",              presets_hash_handler)
    app.router.add_post("/presets/export",           preset_export_handler)
    app.router.add_post("/presets/import",           preset_import_handler)
    app.router.add_get("/fonts",                     fonts_handler)
    app.router.add_get("/fonts/{filename}",          font_file_handler)
    app.router.add_get("/keys",                      keys_handler)
    app.router.add_get("/config",                    config_get_handler)
    app.router.add_patch("/config",                  config_patch_handler)
    app.router.add_delete("/sessions/{session_id}",  close_session_handler)
    app.router.add_get("/log",                       log_handler)
    app.router.add_get("/sftp/{sftp_id}/dirsize",    sftp_dirsize_handler)
    app.router.add_get("/ws",                        websocket_handler)
    app.router.add_static("/static",                 BASE_DIR / "static")

    return app


def main():
    startup_config = load_config()
    log_level      = get_log_level(startup_config)

    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )
    logging.getLogger("aiohttp.access").setLevel(logging.ERROR)
    logging.getLogger("aiohttp.server").setLevel(logging.ERROR)
    logging.getLogger().addHandler(_mem_log)
    # asyncssh-interne DEBUG-Meldungen aus dem Web-Log heraushalten
    logging.getLogger("asyncssh").setLevel(logging.WARNING)

    host = startup_config.get("host", "0.0.0.0")
    port = startup_config.get("port", 8282)

    # SSL/TLS-Konfiguration (optional)
    ssl_cfg  = startup_config.get("ssl", {})
    ssl_ctx  = None
    protocol = "http"
    if ssl_cfg.get("enabled", False):
        import ssl as _ssl
        cert = ssl_cfg.get("cert", "")
        key  = ssl_cfg.get("key",  "")
        if cert and key:
            ssl_ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_SERVER)
            ssl_ctx.load_cert_chain(cert, key)
            protocol = "https"
            logging.warning(f"SSL aktiviert: cert={cert}")
        else:
            logging.error("SSL aktiviert aber cert/key fehlen — starte ohne SSL")

    app = create_app()
    logging.warning(f"WebSSH startet auf {protocol}://{host}:{port} (log_level={logging.getLevelName(log_level)})")
    web.run_app(app, host=host, port=port, ssl_context=ssl_ctx, print=None, access_log=None)


if __name__ == "__main__":
    main()