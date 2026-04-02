FROM python:3.12-slim

LABEL maintainer="WebSSH"
LABEL description="Selbst gehosteter Web-SSH-Client"

# Systemabhängigkeiten
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Requirements zuerst (besseres Layer-Caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App-Code
COPY . .

# Verzeichnisse für Volumes anlegen
RUN mkdir -p config keys static/fonts

EXPOSE 8282

CMD ["python", "server.py"]