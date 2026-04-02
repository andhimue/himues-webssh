/**
 * log.js — Verbindungslog als eigener Tab
 *
 * - Polling läuft immer im Hintergrund (auch wenn Tab geschlossen)
 *   damit beim Öffnen der aktuelle Stand sofort sichtbar ist.
 * - DOM wird auf LOG_MAX_ENTRIES begrenzt.
 * - Tab-Schließen erfordert Bestätigung (showConfirm).
 * - Rechtsklick nutzt das bestehende tab-context-menu aus grid.js.
 */

const LOG_MAX_ENTRIES = 500;
const LOG_POLL_MS     = 2000;

let _logActive    = false;
let _logSince     = 0;
let _logPollTimer = null;
let _logTabEl     = null;

// Hintergrund-Puffer: Einträge die ankommen während Tab geschlossen ist
const _logBuffer  = [];

const logPane    = document.getElementById("log-pane");
const logEntries = document.getElementById("log-entries");
const logBtn     = document.getElementById("log-btn");

// ── Hintergrund-Polling (immer aktiv) ────────────────────────

async function _bgPoll() {
    try {
        const resp    = await fetch("/log?since=" + _logSince);
        const entries = await resp.json();
        entries.forEach(e => {
            if (e.ts > _logSince) _logSince = e.ts;
            if (_logActive) {
                _appendEntry(e);
            } else {
                // Im Hintergrund puffern, Limit beachten
                _logBuffer.push(e);
                if (_logBuffer.length > LOG_MAX_ENTRIES) _logBuffer.shift();
            }
        });
    } catch(e) {}
    _logPollTimer = setTimeout(_bgPoll, LOG_POLL_MS);
}

function _appendEntry(e) {
    const atBottom = logEntries.scrollHeight - logEntries.scrollTop
        <= logEntries.clientHeight + 10;
    const d   = new Date(e.ts * 1000);
    const pad = n => String(n).padStart(2, "0");
    const ts  = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    const div = document.createElement("div");
    div.className   = "log-entry " + e.level;
    div.textContent = ts + "  " + e.msg;
    logEntries.appendChild(div);
    while (logEntries.children.length > LOG_MAX_ENTRIES) {
        logEntries.removeChild(logEntries.firstChild);
    }
    if (atBottom) logEntries.scrollTop = logEntries.scrollHeight;
}

function _flushBuffer() {
    _logBuffer.forEach(e => _appendEntry(e));
    _logBuffer.length = 0;
}

// Polling sofort starten (unabhängig ob Tab offen)
_bgPoll();

// ── Tab anlegen ───────────────────────────────────────────────

function _ensureLogTab() {
    if (_logTabEl) return;
    _logTabEl = document.createElement("div");
    _logTabEl.className = "tab";
    _logTabEl.id        = "log-tab";
    _logTabEl.innerHTML =
        '<span class="tab-dot"></span>' +
        '<span class="tab-title">Log</span>' +
        '<div class="tab-close" title="Schlie\u00DFen">\u2715</div>';

    _logTabEl.addEventListener("click", e => {
        if (e.target.classList.contains("tab-close")) {
            _confirmCloseLog();
            return;
        }
        if (!_logActive) activateLog();
    });

    // Rechtsklick: bestehendes tab-context-menu nutzen
    // grid.js filtert mit .tab:not(#grid-tab) — log-tab wird also erfasst
    // ctx-close in grid.js ruft confirmCloseSession(id) auf — wir überschreiben
    // das für log-tab per data-Attribut
    _logTabEl.dataset.logTab = "1";

    document.getElementById("tab-bar").appendChild(_logTabEl);
}

async function _confirmCloseLog() {
    const ok = await showConfirm("Tab schlie\u00DFen", "Log-Tab schlie\u00DFen?\nDer Puffer l\u00E4uft im Hintergrund weiter.");
    if (ok) _closeLogTab();
}

function _closeLogTab() {
    deactivateLog();
    if (_logTabEl) {
        _logTabEl.remove();
        _logTabEl = null;
    }
    if (typeof sessions !== "undefined" && sessions.length > 0) {
        activateSession(sessions[sessions.length - 1].id);
    }
}

// ── Rechtsklick-Menü: ctx-close für Log-Tab abfangen ─────────
// grid.js hört auf tab-bar contextmenu und setzt contextMenuTabId.
// ctx-close ruft confirmCloseSession(id) auf — wir patchen das
// so dass beim Log-Tab stattdessen _confirmCloseLog() läuft.

const _origCtxClose = document.getElementById("ctx-close");
if (_origCtxClose) {
    _origCtxClose.addEventListener("click", () => {
        // Wenn das Rechtsklick-Ziel der Log-Tab war, eigene Funktion
        const menu = document.getElementById("tab-context-menu");
        if (menu && menu._targetIsLogTab) {
            menu._targetIsLogTab = false;
            _confirmCloseLog();
        }
        // normaler Fall wird von grid.js behandelt
    }, true); // capture: vor grid.js-Handler
}

document.getElementById("tab-bar").addEventListener("contextmenu", e => {
    const tab = e.target.closest("#log-tab");
    if (!tab) return;
    // Markieren dass Log-Tab das Ziel war
    const menu = document.getElementById("tab-context-menu");
    if (menu) menu._targetIsLogTab = true;
}, true); // capture: vor grid.js

// ── Aktivieren / Deaktivieren ─────────────────────────────────

function activateLog() {
    deactivateAll();
    _ensureLogTab();
    _logActive = true;
    logBtn.classList.add("active");
    logPane.style.display = "flex";
    if (_logTabEl) _logTabEl.classList.add("active");
    _flushBuffer();  // gepufferte Einträge nachladen
}

function deactivateLog() {
    _logActive = false;
    logBtn.classList.remove("active");
    logPane.style.display = "none";
    if (_logTabEl) _logTabEl.classList.remove("active");
}

// ── Log-Button ────────────────────────────────────────────────

logBtn.addEventListener("click", () => {
    if (_logActive) {
        if (typeof sessions !== "undefined" && sessions.length > 0) {
            activateSession(sessions[sessions.length - 1].id);
        } else {
            deactivateLog();
        }
    } else {
        activateLog();
    }
});

// ── Leeren ────────────────────────────────────────────────────

document.getElementById("log-clear-btn").addEventListener("click", () => {
    logEntries.innerHTML = "";
    _logBuffer.length = 0;
});

// ── ESC ───────────────────────────────────────────────────────

document.addEventListener("keydown", e => {
    if (e.key === "Escape" && _logActive) {
        if (typeof sessions !== "undefined" && sessions.length > 0) {
            activateSession(sessions[sessions.length - 1].id);
        } else {
            deactivateLog();
        }
    }
});