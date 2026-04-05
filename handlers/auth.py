"""
handlers/auth.py — Authentifizierung

Zuständig für:
    - Auth-Middleware (prüft Token bei jedem Request)
    - Login (GET/POST /auth/login)
    - Logout (GET/POST /auth/logout)
    - Setup (GET/POST /auth/setup) — Ersteinrichtung Passwort
    - Passwort ändern (POST /auth/change-password)
"""

import logging

from aiohttp import web

from .core import auth_manager, load_config, get_session_config, BASE_DIR

UNPROTECTED_PATHS = {"/auth/login", "/auth/logout", "/auth/setup"}


@web.middleware
async def auth_middleware(request, handler):
    """Prüft Auth-Token bei jedem Request außer Login-Seite und statischen Dateien."""
    if not auth_manager.auth_required():
        return await handler(request)

    path = request.path

    if path in UNPROTECTED_PATHS or path.startswith("/static/"):
        return await handler(request)

    token = request.cookies.get("webssh_token", "")

    if not auth_manager.validate_token(token):
        if not auth_manager.has_password():
            if path not in {"/auth/setup", "/auth/login"}:
                return web.HTTPFound("/auth/setup")
            return await handler(request)
        if path == "/ws":
            return web.Response(status=401, text="Unauthorized")
        return web.HTTPFound("/auth/login")

    return await handler(request)


async def login_page_handler(request):
    """GET /auth/login — Zeigt die Login-Seite."""
    return web.FileResponse(BASE_DIR / "templates" / "login.html")


async def login_handler(request):
    """POST /auth/login — Passwort prüfen, Token setzen."""
    ip = request.remote
    allowed, retry_after = auth_manager.check_rate_limit(ip)
    if not allowed:
        return web.json_response(
            {"ok": False, "error": "Zu viele Versuche", "retry_after": retry_after},
            status=429
        )

    try:
        body     = await request.json()
        password = body.get("password", "")
    except Exception:
        return web.json_response({"ok": False, "error": "Ungültiger Body"}, status=400)

    auth_manager.record_attempt(ip)

    if not auth_manager.verify_password(password):
        logging.warning(f"Login fehlgeschlagen von {ip}")
        return web.json_response({"ok": False, "error": "Falsches Passwort"}, status=401)

    auth_manager.clear_attempts(ip)
    config       = load_config()
    sc           = get_session_config(config)
    cfg_auth     = config.get("auth", {})
    timeout      = cfg_auth.get("session_timeout", 86400)
    token        = auth_manager.create_token(sc["session_mode"])

    logging.warning(f"Login erfolgreich von {ip} (mode={sc['session_mode']})")
    resp = web.json_response({"ok": True})
    resp.set_cookie("webssh_token", token, max_age=timeout, httponly=True, samesite="Strict")
    return resp


async def logout_handler(request):
    """POST+GET /auth/logout — Token ungültig machen, Sessions schließen, Cookie löschen."""
    from .sessions import session_manager
    token = request.cookies.get("webssh_token", "")
    auth_manager.revoke_token(token)

    all_sessions = await session_manager.list_all()
    for session in all_sessions:
        logging.warning(f"Logout: Session beendet: {session.preset.get('title','?')} [{session.session_id[:8]}]")
        await session_manager._terminate_session(session)

    resp = web.HTTPFound("/auth/login")
    resp.set_cookie("webssh_token", "", max_age=0, httponly=True, samesite="Strict")
    return resp


async def setup_page_handler(request):
    """GET /auth/setup — Ersteinrichtung, wird angezeigt wenn kein Passwort gesetzt ist."""
    return web.FileResponse(BASE_DIR / "templates" / "setup.html")


async def setup_handler(request):
    """POST /auth/setup — Erstes Passwort setzen."""
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

    config   = load_config()
    sc       = get_session_config(config)
    cfg_auth = config.get("auth", {})
    timeout  = cfg_auth.get("session_timeout", 86400)
    token    = auth_manager.create_token(sc["session_mode"])

    resp = web.json_response({"ok": True})
    resp.set_cookie("webssh_token", token, max_age=timeout, httponly=True, samesite="Strict")
    return resp


async def change_password_handler(request):
    """POST /auth/change-password — Passwort ändern (erfordert aktuelles Passwort)."""
    token = request.cookies.get("webssh_token", "")
    if not auth_manager.validate_token(token):
        return web.json_response({"ok": False, "error": "Nicht eingeloggt"}, status=401)

    try:
        body       = await request.json()
        current_pw = body.get("current_password", "")
        new_pw     = body.get("new_password", "")
        confirm_pw = body.get("confirm_password", "")
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