"""
handlers/sftp.py — SFTP-Dateimanager Handler

Enthält: SftpSession, SftpManager, alle /sftp/* Endpunkte
"""
import asyncio
import io
import json
import logging
import stat as _stat
import time as _time
import uuid as _uuid
import zipfile
from pathlib import Path

import asyncssh
from aiohttp import web

from .core     import load_config, auth_manager, BASE_DIR, get_session_config
from .sessions import _build_connect_kwargs


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
    now = _time.time()
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

        buf      = io.BytesIO()
        zip_file = zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED)

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
    _j = json

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

    _j = json
    _u = _uuid
    copy_id = str(_uuid.uuid4())

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


async def sftp_dirsize_handler(request):
    """GET /sftp/{id}/dirsize?path=... — Berechnet rekursiv die Größe eines Verzeichnisses."""
    sftp_id = request.match_info["sftp_id"]
    path    = request.query.get("path", "/")
    session = await sftp_manager.get(sftp_id)
    if not session or not session.sftp:
        return web.json_response({"ok": False, "error": "Nicht verbunden"}, status=404)
    try:
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