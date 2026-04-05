"""
handlers/core.py — Gemeinsame Grundlage für alle Handler

Enthält:
    - YAML-Instanz und Config-Funktionen (load_config, load_config_raw, save_config)
    - BASE_DIR, CONFIG_FILE
    - _MemLogHandler + mem_log  (In-Memory Log-Puffer für /log)
    - AuthManager + auth_manager
    - Hilfsfunktionen: get_log_level, get_session_config, filter_term_responses
"""

import asyncio
import logging
import os
import re
import time as _time
import uuid as _uuid
from pathlib import Path

from ruamel.yaml import YAML

# ── YAML-Instanz ──────────────────────────────────────────────
_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.default_flow_style = False
_yaml.width = 120

# ── Pfade ─────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent


def _resolve_config_file() -> Path:
    """Config-Pfad: --config Argument > WEBSSH_CONFIG Env > Standard."""
    import sys
    if "--config" in sys.argv:
        idx = sys.argv.index("--config")
        if idx + 1 < len(sys.argv):
            return Path(sys.argv[idx + 1])
    env = os.environ.get("WEBSSH_CONFIG", "")
    if env:
        return Path(env)
    return BASE_DIR / "config" / "config.yml"


CONFIG_FILE = _resolve_config_file()


# ── Config-Funktionen ─────────────────────────────────────────

def load_config() -> dict:
    """Lädt config.yml und gibt ein normales dict zurück (für Lese-Zugriffe)."""
    with open(CONFIG_FILE) as f:
        return _yaml.load(f)


def load_config_raw():
    """Lädt config.yml als ruamel.yaml CommentedMap (erhält Kommentare). Nur für save_config verwenden."""
    with open(CONFIG_FILE) as f:
        return _yaml.load(f)


def save_config(raw):
    """Schreibt die Konfiguration zurück in config.yml. Erhält Kommentare und Formatierung."""
    with open(CONFIG_FILE, "w") as f:
        _yaml.dump(raw, f)


def get_log_level(config) -> int:
    """Liest den Log-Level aus der Konfiguration und gibt die logging-Konstante zurück."""
    level_str = config.get("log_level", "WARNING").upper()
    return getattr(logging, level_str, logging.WARNING)


def get_session_config(config) -> dict:
    """Extrahiert den sessions-Abschnitt aus der Konfiguration mit Standardwerten."""
    s = config.get("sessions", {})
    return {
        "persist":           s.get("persist", True),
        "session_mode":      s.get("session_mode", "single_user"),
        "reconnect_timeout": s.get("reconnect_timeout", 86400),
        "buffer_size":       s.get("buffer_size", 524288),
    }


# ── Terminal-Filter ───────────────────────────────────────────
_TERM_RESPONSE_RE = re.compile(rb"\x1b\[[\x30-\x3f]*[\x20-\x2f]*[cRn]")


def filter_term_responses(data: bytes) -> bytes:
    """Entfernt Terminal-Antwort-Sequenzen die beim Reconnect falsch dargestellt würden."""
    return _TERM_RESPONSE_RE.sub(b"", data)


# ── In-Memory Log-Handler ─────────────────────────────────────

class _MemLogHandler(logging.Handler):
    """Speichert Log-Einträge im Arbeitsspeicher für den /log-Endpunkt."""

    def __init__(self, maxlen: int = 500):
        super().__init__()
        self._entries = []
        self._maxlen  = maxlen

    def emit(self, record: logging.LogRecord):
        entry = {
            "ts":    record.created,
            "level": record.levelname,
            "msg":   self.format(record),
        }
        self._entries.append(entry)
        if len(self._entries) > self._maxlen:
            self._entries = self._entries[-self._maxlen:]

    def get_entries(self, since: float = 0.0) -> list:
        """Gibt alle Einträge zurück die neuer als since (Unix-Timestamp) sind."""
        return [e for e in self._entries if e["ts"] > since]


mem_log = _MemLogHandler()
mem_log.setLevel(logging.INFO)
mem_log.setFormatter(logging.Formatter("%(name)s: %(message)s"))


# ── AuthManager ───────────────────────────────────────────────

class AuthManager:
    """
    Verwaltet Login-Tokens und Rate-Limiting.
    - single_user: nur ein aktives Token, neuer Login verdrängt alten
    - multi_user:  mehrere aktive Tokens gleichzeitig
    """

    def __init__(self):
        self._tokens:   dict[str, float] = {}  # token → expiry timestamp
        self._attempts: dict[str, list]  = {}  # ip → [timestamp, ...]

    def _get_auth_config(self) -> dict:
        try:
            return load_config().get("auth", {})
        except Exception:
            return {}

    # ── Rate-Limiting ──────────────────────────────────────────
    def check_rate_limit(self, ip: str) -> tuple[bool, int]:
        """Gibt (erlaubt, retry_after_seconds) zurück."""
        cfg       = self._get_auth_config()
        max_tries = cfg.get("rate_limit_attempts", 5)
        window    = cfg.get("rate_limit_window", 60)
        now       = _time.time()
        hits      = [t for t in self._attempts.get(ip, []) if now - t < window]
        self._attempts[ip] = hits
        if len(hits) >= max_tries:
            return False, max(int(window - (now - min(hits))), 1)
        return True, 0

    def record_attempt(self, ip: str):
        """Zählt einen fehlgeschlagenen Login-Versuch für die IP."""
        self._attempts.setdefault(ip, []).append(_time.time())

    def clear_attempts(self, ip: str):
        """Löscht die Login-Versuche für eine IP nach erfolgreichem Login."""
        self._attempts.pop(ip, None)

    # ── Passwort ───────────────────────────────────────────────
    def verify_password(self, password: str) -> bool:
        """Prüft ein Passwort gegen den gespeicherten bcrypt-Hash."""
        hash_ = self._get_auth_config().get("password_hash", "")
        if not hash_:
            return False
        try:
            import bcrypt
            return bcrypt.checkpw(password.encode(), hash_.encode())
        except Exception:
            return False

    def auth_required(self) -> bool:
        """Login aktiv wenn enable_login: true in der Config."""
        return bool(self._get_auth_config().get("enable_login", False))

    def has_password(self) -> bool:
        """Prüft ob bereits ein Passwort-Hash gesetzt ist."""
        return bool(self._get_auth_config().get("password_hash", ""))

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
        """Erstellt einen neuen Auth-Token. Im single_user-Modus werden alle alten gelöscht."""
        cfg     = self._get_auth_config()
        timeout = cfg.get("session_timeout", 86400)
        token   = str(_uuid.uuid4())
        if session_mode == "single_user":
            self._tokens.clear()
        self._tokens[token] = _time.time() + timeout
        return token

    def validate_token(self, token: str) -> bool:
        """Prüft ob ein Token gültig und nicht abgelaufen ist."""
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
        """Macht einen Token sofort ungültig."""
        self._tokens.pop(token, None)

    def cleanup_expired(self):
        """Entfernt alle abgelaufenen Tokens."""
        now = _time.time()
        self._tokens = {t: e for t, e in self._tokens.items() if e > now}


auth_manager = AuthManager()