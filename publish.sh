#!/bin/bash
# ============================================================
# publish.sh — WebSSH auf Gitea veröffentlichen
#
# Verwendung:
#   ./publish.sh                    # normaler Commit+Push
#   ./publish.sh "Commit-Nachricht" # mit eigener Nachricht
#   ./publish.sh --init             # Repository erstmalig einrichten
#   ./publish.sh --test             # Verbindung testen
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="$SCRIPT_DIR/publish.conf"

# ── Farben ───────────────────────────────────────────────────
YLW='\033[1;33m'; GRN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${YLW}[*]${NC} $*"; }
success() { echo -e "${GRN}[✓]${NC} $*"; }
error()   { echo -e "${RED}[!]${NC} $*" >&2; exit 1; }

# ── Konfiguration laden / anlegen ────────────────────────────
if [ ! -f "$CONF_FILE" ]; then
    cat > "$CONF_FILE" << 'CONF'
# publish.conf — Gitea-Konfiguration für publish.sh
# Diese Datei NICHT ins Git einchecken (steht in .gitignore)

GITEA_URL="https://gitea.example.com"   # URL deines Gitea-Servers
GITEA_USER="himue"                       # Dein Gitea-Benutzername
GITEA_REPO="webssh"                      # Repository-Name
GITEA_TOKEN=""                           # Access Token
GIT_BRANCH="main"
GIT_AUTHOR_NAME="himue"
GIT_AUTHOR_EMAIL="himue@example.com"

# Auf true setzen wenn Gitea ein selbst-signiertes Zertifikat nutzt
SSL_VERIFY="true"
CONF
    echo ""
    info "publish.conf wurde angelegt — bitte ausfüllen:"
    echo "  nano $CONF_FILE"
    echo ""
    exit 0
fi

source "$CONF_FILE"

# Pflichtfelder prüfen
[ -z "$GITEA_URL" ]   && error "GITEA_URL fehlt in publish.conf"
[ -z "$GITEA_USER" ]  && error "GITEA_USER fehlt in publish.conf"
[ -z "$GITEA_REPO" ]  && error "GITEA_REPO fehlt in publish.conf"
[ -z "$GITEA_TOKEN" ] && error "GITEA_TOKEN fehlt in publish.conf"

# SSL-Option für curl und git
CURL_SSL=""
GIT_SSL=""
if [ "${SSL_VERIFY}" = "false" ]; then
    CURL_SSL="--insecure"
    GIT_SSL="-c http.sslVerify=false"
    info "SSL-Verifikation deaktiviert (selbst-signiertes Zertifikat)"
fi

# Remote-URL mit Token
REMOTE_URL="https://${GITEA_USER}:${GITEA_TOKEN}@${GITEA_URL#https://}/${GITEA_USER}/${GITEA_REPO}.git"

# ── API-Aufruf mit Fehlerausgabe ──────────────────────────────
gitea_api() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    local response
    response=$(curl -s $CURL_SSL \
        --max-time 15 \
        -w "\n%{http_code}" \
        -X "$method" \
        "${GITEA_URL}/api/v1${endpoint}" \
        -H "Authorization: token ${GITEA_TOKEN}" \
        -H "Content-Type: application/json" \
        ${data:+-d "$data"})

    local http_code body
    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | head -n -1)

    echo "$http_code|$body"
}

# ── Modus: --test ────────────────────────────────────────────
if [ "$1" = "--test" ]; then
    info "Teste Verbindung zu ${GITEA_URL}..."

    result=$(gitea_api GET "/user")
    http_code="${result%%|*}"
    body="${result#*|}"

    if [ "$http_code" = "200" ]; then
        login=$(echo "$body" | grep -o '"login":"[^"]*"' | cut -d'"' -f4)
        success "Verbindung OK — eingeloggt als: $login"
    else
        echo -e "${RED}Fehler HTTP $http_code:${NC}"
        echo "$body"
        error "Verbindungstest fehlgeschlagen"
    fi
    exit 0
fi

# ── Commit + Push ─────────────────────────────────────────────
_do_commit_and_push() {
    local msg="$1"
    cd "$SCRIPT_DIR"

    [ -n "$GIT_AUTHOR_NAME" ]  && git config user.name  "$GIT_AUTHOR_NAME"
    [ -n "$GIT_AUTHOR_EMAIL" ] && git config user.email "$GIT_AUTHOR_EMAIL"

    git add -A

    if git diff --cached --quiet; then
        info "Keine Änderungen — nichts zu committen."
        return 0
    fi

    git commit -m "$msg"

    info "Push nach ${GITEA_URL}/${GITEA_USER}/${GITEA_REPO} (Branch: ${GIT_BRANCH})..."
    git $GIT_SSL push origin "$GIT_BRANCH"
    success "Push erfolgreich."
}

# ── Modus: --init ────────────────────────────────────────────
if [ "$1" = "--init" ]; then
    info "Repository auf Gitea anlegen..."

    result=$(gitea_api POST "/user/repos" "{
        \"name\": \"${GITEA_REPO}\",
        \"description\": \"Selbst gehosteter Web-SSH-Client\",
        \"private\": true,
        \"auto_init\": false
    }")
    http_code="${result%%|*}"
    body="${result#*|}"

    if [ "$http_code" = "201" ]; then
        success "Repository '${GITEA_REPO}' angelegt."
    elif [ "$http_code" = "409" ]; then
        info "Repository existiert bereits — überspringe Anlegen."
    elif [ "$http_code" = "000" ]; then
        error "Keine Verbindung zu ${GITEA_URL} — URL und SSL_VERIFY prüfen."
    else
        echo -e "${RED}Fehler HTTP $http_code:${NC}"
        echo "$body"
        error "Repository konnte nicht angelegt werden."
    fi

    cd "$SCRIPT_DIR"

    if [ ! -d ".git" ]; then
        git init
        git checkout -b "$GIT_BRANCH" 2>/dev/null || git branch -M "$GIT_BRANCH"
        success "Git-Repository initialisiert."
    fi

    if git remote get-url origin &>/dev/null 2>&1; then
        git remote set-url origin "$REMOTE_URL"
        info "Remote 'origin' aktualisiert."
    else
        git remote add origin "$REMOTE_URL"
        success "Remote 'origin' gesetzt."
    fi

    _do_commit_and_push "Initial commit — WebSSH v$(grep VERSION static/js/config.js 2>/dev/null | grep -o '"[0-9.]*"' | tr -d '"' || echo '1.3')"

    echo ""
    success "Fertig: ${GITEA_URL}/${GITEA_USER}/${GITEA_REPO}"
    exit 0
fi

# ── Normaler Commit + Push ───────────────────────────────────
cd "$SCRIPT_DIR"
[ ! -d ".git" ] && error "Kein Git-Repository. Erst: ./publish.sh --init"

COMMIT_MSG="${1:-Aktualisierung $(date '+%Y-%m-%d %H:%M')}"
_do_commit_and_push "$COMMIT_MSG"

echo ""
success "Veröffentlicht: ${GITEA_URL}/${GITEA_USER}/${GITEA_REPO}"