# Gitea-Einrichtung — Schritt-für-Schritt

Diese Anleitung beschreibt die einmalige Einrichtung für das automatisierte
Publishing von WebSSH auf deinem privaten Gitea-Server.

---

## 1. Access Token in Gitea generieren

1. Im Browser: `https://gitea.example.com` → einloggen
2. Oben rechts: Profilbild → **Einstellungen**
3. Linke Seite: **Anwendungen**
4. Unter **Token generieren**:
   - Name: `webssh-publish`
   - Ablaufdatum: nach Wunsch (oder kein Ablaufdatum)
   - Berechtigungen: **Repository** → Lesen + Schreiben
5. Klick auf **Token generieren**
6. Token sofort kopieren — er wird nur einmal angezeigt!

---

## 2. publish.sh erstmalig ausführen (legt publish.conf an)

```bash
cd /opt/webssh
./publish.sh
```

Ausgabe:
```
[*] publish.conf wurde angelegt.
[*] Bitte ausfüllen und dann erneut ausführen:
    nano /opt/webssh/publish.conf
```

---

## 3. publish.conf ausfüllen

```bash
nano /opt/webssh/publish.conf
```

```bash
GITEA_URL="https://gitea.example.com"   # URL deines Gitea-Servers (mit https://)
GITEA_USER="himue"                       # Dein Gitea-Benutzername
GITEA_REPO="webssh"                      # Gewünschter Repository-Name
GITEA_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxx"   # Token aus Schritt 1
GIT_BRANCH="main"
GIT_AUTHOR_NAME="himue"
GIT_AUTHOR_EMAIL="himue@example.com"
```

> **Wichtig:** `publish.conf` enthält deinen Token und steht in `.gitignore` —
> sie wird niemals ins Git eingecheckt.

---

## 4. Repository erstmalig einrichten und publizieren

```bash
./publish.sh --init
```

Das Script:
- Legt das Repository auf Gitea per API an (privat)
- Initialisiert das lokale Git-Repository
- Setzt den Remote auf Gitea
- Macht den ersten Commit mit allen Dateien
- Pusht nach Gitea

Erwartete Ausgabe:
```
[*] Repository auf Gitea anlegen und initialisieren...
[✓] Repository 'webssh' auf Gitea angelegt.
[✓] Git-Repository initialisiert.
[✓] Remote 'origin' gesetzt.
[*] Initialer Commit und Push...
[*] Push nach https://gitea.example.com/himue/webssh...
[✓] Veröffentlicht: https://gitea.example.com/himue/webssh
```

---

## 5. Ergebnis prüfen

Im Browser: `https://gitea.example.com/himue/webssh`

Folgende Dateien sollten vorhanden sein (Auszug):
```
config/config.example.yml   ← Vorlage (config.yml ist ausgeschlossen)
docker/Dockerfile
docker/docker-compose.yml
GIT-INSTALL.md
README.md
server.py
start.sh
static/
templates/
...
```

Folgendes ist **nicht** im Repository:
```
venv/                        ← durch .gitignore ausgeschlossen
config/config.yml            ← durch .gitignore ausgeschlossen
keys/                        ← durch .gitignore ausgeschlossen
static/fonts/*.ttf           ← durch .gitignore ausgeschlossen
publish.conf                 ← durch .gitignore ausgeschlossen
```

---

## 6. Spätere Updates publizieren

Nach Änderungen am Code einfach:

```bash
cd /opt/webssh
./publish.sh "Beschreibung der Änderung"

# oder ohne Nachricht (automatisches Datum):
./publish.sh
```

---

## 7. Installation auf einem anderen Server (aus Gitea)

```bash
git clone https://gitea.example.com/himue/webssh.git /opt/webssh
cd /opt/webssh
cp config/config.example.yml config/config.yml
nano config/config.yml
./start.sh
```

Vollständige Anleitung: **GIT-INSTALL.md**

---

## Troubleshooting

**Push schlägt fehl (403 Forbidden):**
- Token prüfen: muss Repository-Schreibrecht haben
- URL prüfen: kein abschließendes `/`

**Push schlägt fehl (Repository nicht gefunden):**
- `./publish.sh --init` erneut ausführen
- Oder manuell in Gitea ein leeres Repository anlegen

**Zertifikatsfehler bei selbst-signiertem Zertifikat:**
```bash
git config --global http.sslVerify false
# oder besser: CA-Zertifikat des Gitea-Servers installieren
```