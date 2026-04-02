# WebSSH v1.2

Selbst gehosteter Web-SSH-Client mit persistenten Sessions, SFTP-Dateimanager,
Split-View Grid und Verbindungslog.
Gebaut mit Python (aiohttp + asyncssh) und xterm.js.

---

## Features

| Feature | Beschreibung |
|---|---|
| **SSH-Sessions** | Mehrere parallele Verbindungen als Browser-Tabs |
| **Session-Persistenz** | Sessions überleben Browser-Reload, Browser-Übernahme möglich |
| **Split-View Grid** | 2×1, 1×2 oder 2×2 Terminals gleichzeitig (⊞) |
| **SFTP-Dateimanager** | Zweispaltiger Dateimanager mit Upload, Download, Kopieren, Umbenennen, Löschen, Vorschau |
| **Drag & Drop Upload** | Dateien direkt in ein SFTP-Panel ziehen |
| **Tastaturnavigation** | Pfeiltasten, Enter, Backspace, F2–F8, Entf, Pos1/End, Bild↑/↓, / für Schnellsuche |
| **Spalten ein-/ausblenden** | Eigentümer:Gruppe und Rechte als optionale Spalten |
| **Verbindungslog** | Eigener Tab mit SSH/SFTP-Ereignissen, konfigurierbarer Schrift |
| **Server-Presets** | Konfigurierbare Server mit Kategorien, Key- oder Passwort-Auth |
| **Font-Vorschau** | Schriftartnamen im Dropdown in der jeweiligen Schrift angezeigt |
| **Mehrsprachigkeit** | Deutsch und Englisch, umschaltbar in Einstellungen → Sprache |
| **Login-Schutz** | Optionales Passwort-Login mit bcrypt, konfigurierbarem Timeout |
| **HTTPS** | Direkte TLS-Unterstützung ohne Proxy (optional) |
| **Eigene Fonts** | Beliebige `.ttf`-Schriften einbindbar, pro Preset konfigurierbar |

---

## Voraussetzungen

- Python 3.9+
- Debian/Ubuntu: `apt install python3 python3-venv`

---

## Einrichtung

```bash
cp config/config.example.yml config/config.yml
# config/config.yml anpassen (mindestens presets eintragen)
chmod +x start.sh
./start.sh
```

`start.sh` legt beim ersten Start automatisch ein venv an und installiert alle
Abhängigkeiten aus `requirements.txt`.

Der Server ist danach erreichbar unter `http://<host>:8282`.

---

## Betrieb hinter einem Reverse Proxy (Nginx)

Der Normalbetrieb erfolgt hinter Nginx. Wichtig: WebSocket-Support und
ausreichend großes Upload-Limit einstellen.

```nginx
server {
    listen 443 ssl;
    server_name ssh.example.com;

    ssl_certificate     /etc/ssl/certs/example.crt;
    ssl_certificate_key /etc/ssl/private/example.key;

    # Upload-Limit für SFTP-Uploads (an eigene Bedürfnisse anpassen)
    client_max_body_size 2G;

    location / {
        proxy_pass         http://127.0.0.1:8282;
        proxy_http_version 1.1;

        # WebSocket-Support (zwingend erforderlich für SSH-Sessions)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts für langlebige SSH-Verbindungen
        proxy_read_timeout  3600;
        proxy_send_timeout  3600;
        proxy_connect_timeout 10;
    }
}

# HTTP → HTTPS weiterleiten
server {
    listen 80;
    server_name ssh.example.com;
    return 301 https://$host$request_uri;
}
```

> **Hinweis:** `client_max_body_size` begrenzt die maximale Upload-Größe.
> Der Standard ist 1 MB — für große Dateien muss dieser Wert erhöht werden.
> WebSSH selbst erlaubt bis zu 2 GB.

---

## HTTPS direkt (ohne Proxy)

Alternativ kann WebSSH TLS selbst terminieren — sinnvoll für einfache
Installationen ohne vorgelagerten Proxy:

```yaml
ssl:
  enabled: true
  cert: "/etc/ssl/certs/webssh.crt"
  key:  "/etc/ssl/private/webssh.key"
```

---

## Installation als Docker-Container

### Voraussetzungen

- Docker + Docker Compose Plugin (`apt install docker.io docker-compose-plugin`)

### Verzeichnisstruktur auf dem Host

Die App liegt vollständig auf dem Host-Laufwerk — kein Rebuild nötig wenn
Konfiguration, Fonts oder Keys geändert werden:

```
/opt/webssh/
├── server.py
├── requirements.txt
├── config/
│   ├── config.yml          ← eigene Konfiguration
│   └── config.example.yml
├── keys/                   ← SSH-Private-Keys
├── static/
│   ├── fonts/              ← eigene Schriftarten
│   └── ...
├── templates/
├── Dockerfile
└── docker-compose.yml
```

### Einrichtung

```bash
# 1. App-Dateien auf den Host kopieren
cp -r webssh/ /opt/webssh/

# 2. Konfiguration anlegen
cp /opt/webssh/config/config.example.yml /opt/webssh/config/config.yml
# config.yml anpassen (presets, auth, etc.)

# 3. Image bauen
cd /opt/webssh
docker build -t webssh:latest .

# 4. Container starten
docker compose up -d
```

### docker-compose.yml

```yaml
services:
  webssh:
    image: webssh:latest          # oder: build: .
    container_name: webssh
    restart: unless-stopped

    ports:
      - "127.0.0.1:8282:8282"    # Nur lokal — Nginx übernimmt externen Zugang

    volumes:
      # Gesamte App liegt auf dem Host: Änderungen sofort wirksam
      - /opt/webssh:/app

    environment:
      - TZ=Europe/Berlin           # Zeitzone für Log-Zeitstempel

    healthcheck:
      test: ["CMD", "python", "-c",
             "import urllib.request; urllib.request.urlopen(\'http://localhost:8282/\').read()"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### Dockerfile

```dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p config keys static/fonts

EXPOSE 8282
CMD ["python", "server.py"]
```

### Nützliche Befehle

```bash
# Status prüfen
docker compose ps

# Logs anzeigen (live)
docker compose logs -f webssh

# Container neustarten (z.B. nach config.yml-Änderung)
docker compose restart webssh

# Image neu bauen (nach Code-Updates)
docker build -t webssh:latest /opt/webssh/
docker compose up -d

# Container stoppen
docker compose down
```

### Konfiguration zur Laufzeit ändern

Da `/opt/webssh` direkt in den Container gemountet ist, werden Änderungen an
`config/config.yml` über das Einstellungen-Modal (⚙) sofort auf dem Host
gespeichert. Ein Container-Neustart ist nur nötig wenn `server.py` selbst
geändert wird.

Keys (`keys/`) und Fonts (`static/fonts/`) können ebenfalls ohne Neustart
hinzugefügt werden — ein Reload im Browser reicht.


---

## Projektstruktur

```
webssh/
├── server.py                    # Haupt-Server (aiohttp + asyncssh)
├── start.sh                     # Start-Skript mit automatischem venv-Setup
├── requirements.txt             # Python-Abhängigkeiten
├── config/
│   ├── config.yml               # Aktive Konfiguration (nicht ins Git!)
│   └── config.example.yml       # Vorlage mit allen Optionen und Kommentaren
├── templates/
│   ├── index.html               # Haupt-App
│   ├── login.html               # Login-Seite
│   └── setup.html               # Ersteinrichtung Passwort
├── static/
│   ├── webssh.css               # Stylesheet
│   ├── favicon.ico              # App-Icon
│   ├── fonts/                   # Schriftarten (.ttf)
│   ├── i18n/                    # Übersetzungen
│   │   ├── de.json              # Deutsch
│   │   └── en.json              # Englisch
│   └── js/
│       ├── config.js            # VERSION, CLIENT_ID
│       ├── i18n.js              # Internationalisierung (t(), setLang())
│       ├── launcher.js          # Server-Launcher, Presets, Session-Cache
│       ├── sessions.js          # SSH-Sessions, WebSocket, Persistenz
│       ├── keyboard.js          # Keyboard-Toolbar, Key-Intercept, Font-Sizes
│       ├── grid.js              # Split-View Grid
│       ├── sftp.js              # SFTP-Dateimanager
│       ├── settings.js          # Einstellungen-Modal, Preset-Verwaltung
│       ├── log.js               # Verbindungslog-Tab
│       ├── ui.js                # Takeover-Banner, beforeunload
│       └── main.js              # Initialisierung
└── tools/
    └── hash-password.py         # Hilfsskript: Passwort-Hash generieren
```

---

## Konfiguration

Die Konfiguration erfolgt in `config/config.yml` (YAML-Format).
Alle Einstellungen können auch über das Einstellungen-Modal (⚙) geändert werden.

### Server

```yaml
host: "0.0.0.0"      # Bind-Adresse
port: 8282           # Port
log_level: WARNING   # DEBUG / INFO / WARNING / ERROR
```

### SSL/TLS (optional)

```yaml
ssl:
  enabled: false           # true = HTTPS direkt aktivieren
  # cert: "/etc/ssl/certs/webssh.crt"
  # key:  "/etc/ssl/private/webssh.key"
```

### Authentifizierung

```yaml
auth:
  enable_login: false          # Login aktivieren
  password_hash: ""            # bcrypt-Hash (über ⚙ → Passwort setzen)
  session_timeout: 86400       # Token-Gültigkeit in Sekunden (24h)
  max_attempts: 5              # Fehlversuche bis Sperre
  lockout_duration: 300        # Sperrdauer in Sekunden
```

Passwort-Hash manuell generieren:
```bash
python3 tools/hash-password.py
```

### Sessions

```yaml
sessions:
  persist: true                # Sessions über Reload erhalten
  session_mode: single_user    # single_user oder multi_user
  reconnect_timeout: 86400     # Sekunden bis verwaiste Session endet
  buffer_size: 524288          # Scrollback-Buffer pro Session (Bytes)
```

| Modus | Verhalten |
|---|---|
| `single_user` | Alle Sessions global sichtbar. Zweiter Browser kann Sessions übernehmen. |
| `multi_user` | Jeder Browser sieht nur seine eigenen Sessions (anhand `client_id`). |

### Terminal

```yaml
terminal:
  close_on_disconnect: false   # Tab bei Session-Ende automatisch schließen
  close_delay: 3               # Sekunden bis Tab geschlossen wird
  show_active_sessions: true   # Aktive Sessions im Launcher anzeigen
```

### Schriftarten

```yaml
fonts:
  terminal:
    family: DejaVuSansMono
    size: 14
    file: fonts/DejaVuSansMono.ttf
    file_bold: fonts/DejaVuSansMono-Bold.ttf
  sftp:
    size: 12                   # SFTP-Dateiliste
  log:
    size: 12                   # Verbindungslog
    family: ""                 # leer = wie Terminal
  settings:
    size: 13                   # Einstellungs-Dialog
  ui:
    size: 13                   # Launcher, Dialoge
  header:
    size: 14                   # Header-Buttons
  toolbar:
    size: 11                   # Keyboard-Toolbar
  grid_2x1:                    # Optional: separater Font für Grid-Layouts
    family: DejaVuSansMono
    size: 12
  preview:
    family: ""                 # SFTP-Dateivorschau
    size: 13
```

Eigene Fonts: `.ttf`-Datei nach `static/fonts/` kopieren, dann über ⚙ → Fonts
auswählen oder direkt in `config.yml` eintragen.

### Pfade

```yaml
paths:
  keys: keys/            # Verzeichnis mit SSH-Private-Keys
  fonts: static/fonts/   # Verzeichnis mit Schriftarten
```

### Server-Presets

```yaml
presets:
  - title: Mein Server
    category: Produktion
    host: 192.168.1.1
    port: 22
    username: root
    private_key: id_ansible    # Dateiname im keys/-Verzeichnis (ohne Pfad)
    font:                      # Optionale Font-Überschreibung für diesen Server
      size: 12
      family: ""

  - title: Anderer Server
    host: 192.168.1.2
    port: 22
    username: admin
    password: geheim           # Alternativ zu private_key
```

Presets können auch über ⚙ → Server verwaltet, exportiert und importiert werden.
Der Export ist AES-256-GCM-verschlüsselt.

---

## Bedienung

### Tastenkürzel

| Taste | Aktion |
|---|---|
| `Leertaste` | Launcher öffnen |
| `Esc` | Launcher / Dialoge / Log-Tab schließen |

### Launcher
- **+** oder **Leertaste** — Launcher öffnen
- Suchfeld — Server filtern (Name, Adresse, Kategorie)
- Klick auf Server-Karte — neue SSH-Session öffnen
- Klick auf aktive Session — zur offenen Session wechseln

### Session-Tabs
- **✕** im Tab — Schließen mit Bestätigungsdialog
- **Rechtsklick** auf Tab — Kontextmenü

### Split-View Grid (⊞)
- ⊞-Button → Grid-Menü öffnen (2×1 / 1×2 / 2×2)
- Jede Zelle hat einen eigenen Verbinden-Button
- Grid-Sessions werden bei Reload und Browser-Übernahme wiederhergestellt

### Verbindungslog (☰)
- ☰-Button → Log-Tab öffnen
- Zeigt SSH-Verbindungsereignisse und Fehler
- Puffert im Hintergrund auch wenn der Tab geschlossen ist (max. 500 Einträge)
- **Leeren**-Button oben rechts im Tab

### SFTP-Dateimanager (⇄)

#### Buttons und Funktionstasten

| Button | Taste | Funktion |
|---|---|---|
| Umbenennen | F2 | Ausgewählte Datei/Ordner umbenennen |
| → Kopieren | F5 | Aktives Panel → inaktives Panel kopieren |
| Neuer Ordner | F7 | Neuen Ordner anlegen |
| Löschen | F8 / Entf | Ausgewählte Elemente löschen |
| Suchen | / | Schnellfilter im aktiven Panel |
| .Dateien | — | Versteckte Dateien ein-/ausblenden |
| 👥 owner | — | Eigentümer:Gruppe-Spalte ein-/ausblenden |
| 0644 | — | Rechte-Spalte ein-/ausblenden |
| Upload | — | Dateien hochladen (auch per Drag & Drop) |
| Download | — | Dateien herunterladen (ZIP bei mehreren/Ordnern) |

#### Tastaturnavigation in der Dateiliste

| Taste | Funktion |
|---|---|
| ↑ / ↓ | Cursor bewegen |
| Enter | Verzeichnis öffnen |
| Backspace | Übergeordnetes Verzeichnis |
| Space | Eintrag selektieren/deselektieren |
| Tab | Zwischen linkem und rechtem Panel wechseln |
| Pos1 / End | Zum ersten / letzten Eintrag springen |
| Bild↑ / Bild↓ | Eine Seite hoch / runter |
| / | Schnellfilter öffnen |
| Esc | Schnellfilter schließen |

#### Kopieren (Server-zu-Server)
Beide Panels müssen verbunden sein. Das Kopieren läuft serverseitig mit
Fortschrittsanzeige. Bei Konflikten (Datei existiert) erscheint ein Dialog:
Überschreiben / Überspringen / Alle überschreiben / Alle überspringen / Abbrechen.

#### Upload-Limit
WebSSH erlaubt Uploads bis 2 GB. Bei Betrieb hinter Nginx muss
`client_max_body_size` entsprechend gesetzt werden (siehe Nginx-Konfiguration).

### Keyboard-Toolbar (⌨)
Ctrl- und F-Key-Buttons für Browser, die Tastenkombinationen abfangen.
- **Ctrl+W** über Toolbar sendet Ctrl+W ans Terminal
- **F1–F12** senden xterm-256color ESC-Sequenzen

### Browser-Übernahme (single_user)
Öffnet man WebSSH in einem zweiten Browser, werden alle offenen Sessions
(inkl. Grid und SFTP) automatisch übernommen. Der erste Browser zeigt ein
Banner und muss neu geladen werden.

---

## WEBSSH_SESSION Umgebungsvariable

WebSSH setzt beim Verbindungsaufbau `WEBSSH_SESSION=1`.
Damit kann in `.bashrc` erkannt werden ob die Verbindung über WebSSH kommt:

```bash
if [[ "$WEBSSH_SESSION" == "1" ]]; then
    export PS1="\[\e[36m\][webssh] \[\e[0m\]$PS1"
fi
```

Voraussetzung — in der `sshd_config` des Zielservers:
```
AcceptEnv WEBSSH_SESSION
```
Danach: `systemctl reload sshd`

---

## HTTP-API

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/` | Haupt-App |
| GET/POST | `/auth/login` | Login |
| GET/POST | `/auth/logout` | Logout |
| GET | `/presets` | Server-Presets laden |
| GET | `/presets/hash` | Hash der Presets (Change-Detection) |
| GET | `/config/terminal` | Terminal-Konfiguration |
| GET/PATCH | `/config` | Konfiguration lesen/ändern |
| GET | `/sessions` | Aktive Sessions |
| DELETE | `/sessions/{id}` | Session beenden |
| GET | `/fonts` | Verfügbare Fonts |
| GET | `/keys` | Verfügbare SSH-Keys |
| GET | `/log` | Verbindungslog-Einträge (`?since=<timestamp>`) |
| GET/POST | `/grid-state` | Grid-State |
| POST | `/sftp/connect` | SFTP-Verbindung öffnen |
| GET | `/sftp/sessions` | Aktive SFTP-Sessions |
| DELETE | `/sftp/{id}` | SFTP-Verbindung schließen |
| GET | `/sftp/{id}/ls` | Verzeichnis auflisten |
| GET | `/sftp/{id}/download` | Datei herunterladen |
| GET | `/sftp/{id}/download-zip` | Mehrere Dateien/Ordner als ZIP |
| POST | `/sftp/{id}/upload` | Datei hochladen (max. 2 GB) |
| POST | `/sftp/{id}/mkdir` | Verzeichnis anlegen |
| POST | `/sftp/{id}/rename` | Umbenennen |
| POST | `/sftp/{id}/delete` | Löschen (rekursiv) |
| GET | `/sftp/{id}/preview` | Dateiinhalt vorschauen |
| GET | `/sftp/{id}/dirsize` | Verzeichnisgröße berechnen |
| POST | `/sftp/copy` | Server-zu-Server kopieren (SSE) |
| POST | `/sftp/conflict-resolve` | Kopier-Konflikt auflösen |
| GET | `/ws` | WebSocket (SSH-Session) |

---

## .gitignore

```
venv/
config/config.yml
__pycache__/
static/fonts/*.ttf
keys/
```