# WebSSH — Installation vom Git-Server

## Voraussetzungen

- Python 3.9+
- Git
- `apt install python3 python3-venv git`

---

## Installation

```bash
# 1. Repository klonen
git clone https://gitea.example.com/himue/webssh.git /opt/webssh
cd /opt/webssh

# 2. Konfiguration anlegen
cp config/config.example.yml config/config.yml
nano config/config.yml   # Mindestens: presets eintragen

# 3. SSH-Keys ins keys/-Verzeichnis legen (falls genutzt)
cp ~/.ssh/id_rsa keys/id_ansible

# 4. Starten
chmod +x start.sh
./start.sh
```

Der Server ist erreichbar unter `http://<host>:8282`.

---

## Systemd-Service (optional)

```ini
# /etc/systemd/system/webssh.service
[Unit]
Description=WebSSH
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/webssh
ExecStart=/opt/webssh/venv/bin/python /opt/webssh/server.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now webssh
```

---

## Updates

```bash
cd /opt/webssh
git pull
systemctl restart webssh
```

---

## Docker

Siehe `docker/docker-compose.yml` und `docker/Dockerfile`.

```bash
cd /opt/webssh
docker build -t webssh:latest -f docker/Dockerfile .
docker compose -f docker/docker-compose.yml up -d
```