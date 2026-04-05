#!/usr/bin/env python3
"""
WebSSH v1.4 — Web-SSH-Client mit persistenten Sessions
server.py — Einstiegspunkt: App-Konfiguration, Routen, Start

Handler-Module (handlers/):
    core     — Config, AuthManager, MemLogHandler, Hilfsfunktionen
    sessions — ManagedSession, SessionManager, SSH-WebSocket, HTTP-Handler
    sftp     — SftpSession, SftpManager, alle SFTP-Handler
    auth     — Login, Logout, Setup, Passwort, Auth-Middleware
    config   — /config GET/PATCH, /presets/hash
    assets   — /fonts, /keys, Font-Scanner
    presets  — Preset-Export/Import (AES-256-GCM)
    log      — /log Verbindungslog-Endpunkt
"""

import asyncio
import logging

from aiohttp import web

from handlers.core     import load_config, get_log_level, mem_log, BASE_DIR, auth_manager
from handlers.auth     import (auth_middleware, login_page_handler, login_handler,
                                logout_handler, setup_page_handler, setup_handler,
                                change_password_handler)
from handlers.sessions import (session_manager, websocket_handler, index_handler,
                                presets_handler, terminal_config_handler,
                                sessions_handler, close_session_handler,
                                grid_state_save_handler, grid_state_load_handler,
                                cleanup_task)
from handlers.sftp     import (sftp_manager, sftp_connect_handler, sftp_sessions_handler,
                                sftp_status_handler, sftp_disconnect_handler,
                                sftp_ls_handler, sftp_mkdir_handler, sftp_rename_handler,
                                sftp_delete_handler, sftp_download_handler,
                                sftp_download_zip_handler, sftp_preview_handler,
                                sftp_upload_handler, sftp_conflict_resolve_handler,
                                sftp_copy_handler, sftp_dirsize_handler)
from handlers.config   import config_get_handler, config_patch_handler, presets_hash_handler
from handlers.assets   import fonts_handler, font_file_handler, keys_handler
from handlers.presets  import preset_export_handler, preset_import_handler
from handlers.log      import log_handler


async def on_startup(app):
    """aiohttp-Startup-Hook: startet Hintergrundaufgaben (Session-Cleanup-Timer)."""
    app["cleanup_task"] = asyncio.create_task(cleanup_task())


def create_app() -> web.Application:
    """Erstellt und konfiguriert die aiohttp-Anwendung mit allen Routen und Middleware."""
    app = web.Application(middlewares=[auth_middleware], client_max_size=2 * 1024**3)
    app.on_startup.append(on_startup)
    app.router.add_static("/static", BASE_DIR / "static")

    # ── Auth ──────────────────────────────────────────────────
    app.router.add_get ("/auth/login",           login_page_handler)
    app.router.add_post("/auth/login",           login_handler)
    app.router.add_get ("/auth/logout",          logout_handler)
    app.router.add_post("/auth/logout",          logout_handler)
    app.router.add_get ("/auth/setup",           setup_page_handler)
    app.router.add_post("/auth/setup",           setup_handler)
    app.router.add_post("/auth/change-password", change_password_handler)

    # ── Haupt-App ─────────────────────────────────────────────
    app.router.add_get("/",   index_handler)
    app.router.add_get("/ws", websocket_handler)

    # ── Sessions ──────────────────────────────────────────────
    app.router.add_get   ("/sessions",              sessions_handler)
    app.router.add_delete("/sessions/{session_id}", close_session_handler)

    # ── Presets & Config ──────────────────────────────────────
    app.router.add_get  ("/presets",          presets_handler)
    app.router.add_get  ("/presets/hash",     presets_hash_handler)
    app.router.add_post ("/presets/export",   preset_export_handler)
    app.router.add_post ("/presets/import",   preset_import_handler)
    app.router.add_get  ("/config",           config_get_handler)
    app.router.add_patch("/config",           config_patch_handler)
    app.router.add_get  ("/config/terminal",  terminal_config_handler)

    # ── Assets ────────────────────────────────────────────────
    app.router.add_get("/fonts",            fonts_handler)
    app.router.add_get("/fonts/{filename}", font_file_handler)
    app.router.add_get("/keys",             keys_handler)

    # ── Grid-State ────────────────────────────────────────────
    app.router.add_post("/grid-state", grid_state_save_handler)
    app.router.add_get ("/grid-state", grid_state_load_handler)

    # ── SFTP ──────────────────────────────────────────────────
    app.router.add_post  ("/sftp/connect",               sftp_connect_handler)
    app.router.add_post  ("/sftp/copy",                  sftp_copy_handler)
    app.router.add_post  ("/sftp/conflict-resolve",      sftp_conflict_resolve_handler)
    app.router.add_get   ("/sftp/sessions",              sftp_sessions_handler)
    app.router.add_get   ("/sftp/{sftp_id}",             sftp_status_handler)
    app.router.add_delete("/sftp/{sftp_id}",             sftp_disconnect_handler)
    app.router.add_get   ("/sftp/{sftp_id}/ls",          sftp_ls_handler)
    app.router.add_post  ("/sftp/{sftp_id}/mkdir",       sftp_mkdir_handler)
    app.router.add_post  ("/sftp/{sftp_id}/rename",      sftp_rename_handler)
    app.router.add_post  ("/sftp/{sftp_id}/delete",      sftp_delete_handler)
    app.router.add_get   ("/sftp/{sftp_id}/download",    sftp_download_handler)
    app.router.add_post  ("/sftp/{sftp_id}/download-zip", sftp_download_zip_handler)
    app.router.add_get   ("/sftp/{sftp_id}/preview",     sftp_preview_handler)
    app.router.add_post  ("/sftp/{sftp_id}/upload",      sftp_upload_handler)
    app.router.add_get   ("/sftp/{sftp_id}/dirsize",     sftp_dirsize_handler)
    app.router.add_post  ("/sftp/{sftp_id}/dirsize",     sftp_dirsize_handler)

    # ── Log ───────────────────────────────────────────────────
    app.router.add_get("/log", log_handler)

    return app


def main():
    """Einstiegspunkt: lädt Konfiguration, richtet Logging ein und startet den Server."""
    config    = load_config()
    log_level = get_log_level(config)

    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )
    logging.getLogger("aiohttp.access").setLevel(logging.ERROR)
    logging.getLogger("aiohttp.server").setLevel(logging.ERROR)
    logging.getLogger("asyncssh").setLevel(logging.WARNING)
    logging.getLogger().addHandler(mem_log)

    host = config.get("host", "0.0.0.0")
    port = config.get("port", 8282)

    ssl_cfg  = config.get("ssl", {})
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
    logging.warning(
        f"WebSSH v1.4 startet auf {protocol}://{host}:{port} "
        f"(log_level={logging.getLevelName(log_level)})"
    )
    web.run_app(app, host=host, port=port, ssl_context=ssl_ctx,
                print=None, access_log=None)


if __name__ == "__main__":
    main()