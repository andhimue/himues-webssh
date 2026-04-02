#!/bin/bash
# WebSSH - Start-Skript
# Richtet venv ein (falls nötig) und startet den Server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
PYTHON="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"

# venv anlegen falls nicht vorhanden
if [ ! -d "$VENV_DIR" ]; then
    echo "[*] Erstelle venv..."
    python3 -m venv "$VENV_DIR"
fi

# requirements installieren / aktualisieren
echo "[*] Prüfe/installiere requirements..."
"$PIP" install --quiet -r "$SCRIPT_DIR/requirements.txt"

# Konfiguration prüfen
if [ ! -f "$SCRIPT_DIR/config/config.yml" ]; then
    echo "[!] Keine Konfiguration gefunden."
    echo "    Bitte config/config.yml anlegen (siehe config/config.example.json)"
    exit 1
fi

# Server starten
echo "[*] Starte WebSSH..."
cd "$SCRIPT_DIR"
exec "$PYTHON" server.py "$@"