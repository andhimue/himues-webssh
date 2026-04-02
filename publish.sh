#!/bin/bash
# ============================================================
# publish.sh — WebSSH auf Gitea und/oder GitHub veröffentlichen
#
# Verwendung:
#   ./publish.sh                       # Commit+Push → nur Gitea (Standard)
#   ./publish.sh "Nachricht"           # mit eigener Commit-Nachricht
#   ./publish.sh --github              # Commit+Push → nur GitHub
#   ./publish.sh --github "Nachricht"  # GitHub mit eigener Nachricht
#   ./publish.sh --all                 # Commit+Push → Gitea + GitHub
#   ./publish.sh --all "Nachricht"     # beide mit eigener Nachricht
#   ./publish.sh --init                # erstmalig einrichten (alle aktivierten Remotes)
#   ./publish.sh --init gitea          # nur Gitea einrichten
#   ./publish.sh --init github         # nur GitHub einrichten
#   ./publish.sh --test                # Verbindung zu allen Remotes testen
#   ./publish.sh --test gitea          # nur Gitea testen
#   ./publish.sh --test github         # nur GitHub testen
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="$SCRIPT_DIR/publish.conf"

# ── Farben ───────────────────────────────────────────────────
YLW='\033[1;33m'; GRN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${YLW}[*]${NC} $*"; }
success() { echo -e "${GRN}[✓]${NC} $*"; }
error()   { echo -e "${RED}[!]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${YLW}── $* ──${NC}"; }

# ── Konfiguration laden / anlegen ────────────────────────────
if [ ! -f "$CONF_FILE" ]; then
    cat > "$CONF_FILE" << 'CONF'
# publish.conf — Git-Konfiguration für publish.sh
# NICHT ins Git einchecken (steht in .gitignore)

# ── Gitea ────────────────────────────────────────────────────
GITEA_ENABLED="true"
GITEA_URL="https://gitea.himue.com"
GITEA_USER="andreas"
GITEA_REPO="webssh"
GITEA_TOKEN=""                    # Settings → Applications → Token generieren
GITEA_PRIVATE="true"              # true = privates Repository
SSL_VERIFY="false"                # false bei selbst-signiertem Zertifikat

# ── GitHub ───────────────────────────────────────────────────
GITHUB_ENABLED="false"            # auf true setzen um GitHub zu aktivieren
GITHUB_USER=""                    # GitHub-Benutzername
GITHUB_REPO="webssh"
GITHUB_TOKEN=""                   # github.com → Settings → Developer settings →
                                  # Personal access tokens → Fine-grained token
                                  # Berechtigungen: Contents (Read+Write)
GITHUB_PRIVATE="false"            # true = privates Repository

# ── Gemeinsam ────────────────────────────────────────────────
GIT_BRANCH="main"
GIT_AUTHOR_NAME=""
GIT_AUTHOR_EMAIL=""
CONF
    echo ""
    info "publish.conf wurde angelegt — bitte ausfüllen:"
    echo "  nano $CONF_FILE"
    echo ""
    exit 0
fi

source "$CONF_FILE"

# ── Hilfsfunktionen ──────────────────────────────────────────
CURL_SSL=""
GIT_SSL_OPT=""
if [ "${SSL_VERIFY}" = "false" ]; then
    CURL_SSL="--insecure"
    GIT_SSL_OPT="-c http.sslVerify=false"
fi

api_call() {
    local url="$1" method="$2" token="$3" data="$4"
    local response http_code body
    response=$(curl -s $CURL_SSL \
        --max-time 30 --connect-timeout 10 \
        -w "\n%{http_code}" \
        -X "$method" "$url" \
        -H "Authorization: token ${token}" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        ${data:+-d "$data"} 2>/dev/null)
    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | head -n -1)
    echo "${http_code}|${body}"
}

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
}

_push_remote() {
    local remote="$1"
    info "Push nach $remote (Branch: ${GIT_BRANCH})..."
    git $GIT_SSL_OPT push "$remote" "$GIT_BRANCH"
    success "Push nach $remote erfolgreich."
}

VERSION=$(grep -o '"[0-9.]*"' static/js/config.js 2>/dev/null | tr -d '"' | head -1 || echo "1.3")

# ── Gitea-Funktionen ─────────────────────────────────────────
setup_gitea() {
    [ "${GITEA_ENABLED}" = "true" ] || return 0
    [ -n "$GITEA_TOKEN" ] || { info "GITEA_TOKEN fehlt — Gitea übersprungen."; return 0; }

    header "Gitea"
    local remote_url="https://${GITEA_USER}:${GITEA_TOKEN}@${GITEA_URL#https://}/${GITEA_USER}/${GITEA_REPO}.git"

    info "Repository auf Gitea anlegen..."
    local result http_code body
    result=$(api_call "${GITEA_URL}/api/v1/user/repos" "POST" "$GITEA_TOKEN" \
        "{\"name\":\"${GITEA_REPO}\",\"description\":\"Selbst gehosteter Web-SSH-Client\",\"private\":${GITEA_PRIVATE},\"auto_init\":false}")
    http_code="${result%%|*}"; body="${result#*|}"

    if [ "$http_code" = "201" ]; then
        success "Repository '${GITEA_REPO}' auf Gitea angelegt."
    elif [ "$http_code" = "409" ]; then
        info "Repository existiert bereits."
    elif [ "$http_code" = "000" ]; then
        error "Keine Verbindung zu ${GITEA_URL}"
    else
        echo -e "${RED}Fehler HTTP $http_code:${NC} $body"
        error "Gitea: Repository konnte nicht angelegt werden."
    fi

    if git remote get-url gitea &>/dev/null 2>&1; then
        git remote set-url gitea "$remote_url"
    else
        git remote add gitea "$remote_url"
        success "Remote 'gitea' gesetzt."
    fi
}

test_gitea() {
    [ "${GITEA_ENABLED}" = "true" ] || return 0
    [ -n "$GITEA_TOKEN" ] || { info "GITEA_TOKEN fehlt — Gitea übersprungen."; return 0; }

    header "Gitea — ${GITEA_URL}"
    local result http_code body
    result=$(api_call "${GITEA_URL}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}" "GET" "$GITEA_TOKEN")
    http_code="${result%%|*}"; body="${result#*|}"

    if   [ "$http_code" = "200" ]; then success "Verbindung OK — Repository existiert."
    elif [ "$http_code" = "404" ]; then success "Verbindung OK — Repository noch nicht vorhanden (wird bei --init angelegt)."
    elif [ "$http_code" = "000" ]; then echo -e "${RED}[!]${NC} Keine Verbindung zu ${GITEA_URL}"
    else echo -e "${RED}[!] HTTP $http_code:${NC} $body"
    fi
}

push_gitea() {
    [ "${GITEA_ENABLED}" = "true" ] || return 0
    git remote get-url gitea &>/dev/null 2>&1 || { info "Gitea nicht eingerichtet — übersprungen."; return 0; }
    _push_remote gitea
}

# ── GitHub-Funktionen ─────────────────────────────────────────
setup_github() {
    [ "${GITHUB_ENABLED}" = "true" ] || return 0
    [ -n "$GITHUB_TOKEN" ] || { info "GITHUB_TOKEN fehlt — GitHub übersprungen."; return 0; }
    [ -n "$GITHUB_USER" ]  || { info "GITHUB_USER fehlt — GitHub übersprungen."; return 0; }

    header "GitHub"
    local remote_url="https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${GITHUB_REPO}.git"

    info "Repository auf GitHub anlegen..."
    local result http_code body
    result=$(api_call "https://api.github.com/user/repos" "POST" "$GITHUB_TOKEN" \
        "{\"name\":\"${GITHUB_REPO}\",\"description\":\"Selbst gehosteter Web-SSH-Client\",\"private\":${GITHUB_PRIVATE}}")
    http_code="${result%%|*}"; body="${result#*|}"

    if [ "$http_code" = "201" ]; then
        success "Repository '${GITHUB_REPO}' auf GitHub angelegt."
    elif [ "$http_code" = "422" ]; then
        info "Repository existiert bereits."
    else
        echo -e "${RED}Fehler HTTP $http_code:${NC} $body"
        error "GitHub: Repository konnte nicht angelegt werden."
    fi

    if git remote get-url github &>/dev/null 2>&1; then
        git remote set-url github "$remote_url"
    else
        git remote add github "$remote_url"
        success "Remote 'github' gesetzt."
    fi
}

test_github() {
    [ "${GITHUB_ENABLED}" = "true" ] || return 0
    [ -n "$GITHUB_TOKEN" ] || { info "GITHUB_TOKEN fehlt — GitHub übersprungen."; return 0; }
    [ -n "$GITHUB_USER" ]  || { info "GITHUB_USER fehlt — GitHub übersprungen."; return 0; }

    header "GitHub"
    local result http_code body
    result=$(api_call "https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}" "GET" "$GITHUB_TOKEN")
    http_code="${result%%|*}"; body="${result#*|}"

    if   [ "$http_code" = "200" ]; then success "Verbindung OK — Repository existiert."
    elif [ "$http_code" = "404" ]; then success "Verbindung OK — Repository noch nicht vorhanden."
    else echo -e "${RED}[!] HTTP $http_code:${NC} $body"
    fi
}

push_github() {
    [ "${GITHUB_ENABLED}" = "true" ] || return 0
    git remote get-url github &>/dev/null 2>&1 || { info "GitHub nicht eingerichtet — übersprungen."; return 0; }
    _push_remote github
}

# ── Modus: --test ────────────────────────────────────────────
if [ "$1" = "--test" ]; then
    case "${2:-all}" in
        gitea)  test_gitea ;;
        github) test_github ;;
        *)      test_gitea; test_github ;;
    esac
    exit 0
fi

# ── Modus: --init ────────────────────────────────────────────
if [ "$1" = "--init" ]; then
    cd "$SCRIPT_DIR"

    if [ ! -d ".git" ]; then
        git init
        git checkout -b "$GIT_BRANCH" 2>/dev/null || git branch -M "$GIT_BRANCH"
        success "Git-Repository initialisiert."
    fi
    [ -n "$GIT_AUTHOR_NAME" ]  && git config user.name  "$GIT_AUTHOR_NAME"
    [ -n "$GIT_AUTHOR_EMAIL" ] && git config user.email "$GIT_AUTHOR_EMAIL"

    case "${2:-all}" in
        gitea)  setup_gitea ;;
        github) setup_github ;;
        *)      setup_gitea; setup_github ;;
    esac

    git add -A
    git commit -m "Initial commit — WebSSH v${VERSION}" 2>/dev/null || true

    case "${2:-all}" in
        gitea)  push_gitea ;;
        github) push_github ;;
        *)      push_gitea; push_github ;;
    esac

    echo ""
    success "Einrichtung abgeschlossen."
    [ "${GITEA_ENABLED}"  = "true" ] && echo "  Gitea:  ${GITEA_URL}/${GITEA_USER}/${GITEA_REPO}"
    [ "${GITHUB_ENABLED}" = "true" ] && echo "  GitHub: https://github.com/${GITHUB_USER}/${GITHUB_REPO}"
    exit 0
fi

# ── Normaler Commit + Push ───────────────────────────────────
# Standard: nur Gitea
# --github : nur GitHub
# --all    : Gitea + GitHub
cd "$SCRIPT_DIR"
[ ! -d ".git" ] && error "Kein Git-Repository. Erst: ./publish.sh --init"

TARGET="gitea"
COMMIT_MSG=""

for arg in "$@"; do
    case "$arg" in
        --github) TARGET="github" ;;
        --all)    TARGET="all" ;;
        *)        COMMIT_MSG="$arg" ;;
    esac
done

[ -z "$COMMIT_MSG" ] && COMMIT_MSG="Aktualisierung $(date '+%Y-%m-%d %H:%M')"

_do_commit_and_push "$COMMIT_MSG"

case "$TARGET" in
    gitea)  push_gitea ;;
    github) push_github ;;
    all)    push_gitea; push_github ;;
esac

echo ""
success "Veröffentlicht."
case "$TARGET" in
    gitea|all)  [ "${GITEA_ENABLED}"  = "true" ] && echo "  Gitea:  ${GITEA_URL}/${GITEA_USER}/${GITEA_REPO}" ;;
esac
case "$TARGET" in
    github|all) [ "${GITHUB_ENABLED}" = "true" ] && echo "  GitHub: https://github.com/${GITHUB_USER}/${GITHUB_REPO}" ;;
esac