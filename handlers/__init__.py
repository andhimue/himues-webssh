"""
handlers/ — WebSSH Request-Handler-Paket (v1.4)

Module:
    core     — Config, AuthManager, MemLogHandler, gemeinsame Hilfsfunktionen
    sessions — ManagedSession, SessionManager, SSH-WebSocket-Handler
    sftp     — SftpSession, SftpManager, alle SFTP-Handler
    auth     — Login, Logout, Setup, Passwort, Auth-Middleware
    config   — /config GET/PATCH, /config/terminal, /presets, /presets/hash
    assets   — /fonts, /keys, Font-Scanner
    presets  — Preset-Export/Import (AES-256-GCM)
    log      — /log Verbindungslog-Endpunkt

Singletons (alle in core definiert, von anderen Modulen importiert):
    auth_manager    — AuthManager-Instanz
    session_manager — SessionManager-Instanz
    sftp_manager    — SftpManager-Instanz
    mem_log         — _MemLogHandler-Instanz
"""

__version__ = "1.4"