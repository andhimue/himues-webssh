/**
 * sftp.js — SFTP-Dateimanager
 *
 * Verantwortlich für:
 *   - SFTP-Tab (⇄) als eigener Browser-Tab neben SSH-Sessions
 *   - Zweispaltiger Dateimanager (links/rechts) mit unabhängigen Verbindungen
 *   - Verzeichnis-Navigation, Dateilisting
 *   - Server-zu-Server Kopieren mit SSE-Fortschrittsanzeige und Konfliktbehandlung
 *   - Upload vom Browser mit Konfliktbehandlung (HTTP 409)
 *   - Download auf den Browser (chunked streaming)
 *   - Ordner anlegen, Umbenennen, Löschen
 *   - State-Persistenz: SFTP-Sessions überleben Reload und Browser-Übernahme
 *
 * SFTP-Verbindungen sind serverseitige Objekte im SftpManager.
 * Sie sind unabhängig von SSH-Sessions.
 *
 * Abhängigkeiten: config.js, sessions.js, grid.js (closeSftpConnections referenziert in grid.js)
 * Wird verwendet von: main.js
 */

// ── DOM-Referenzen und Zustand ────────────────────────────────

/** SFTP-Pane (der gesamte Dateimanager-Bereich). */
const sftpPane = document.getElementById("sftp-pane");
/** ⇄-Button in der Header-Leiste. */
const sftpBtn  = document.getElementById("sftp-btn");
/** Tab-Element in der Tab-Leiste (null wenn nicht geöffnet). @type {HTMLElement|null} */
let   sftpTabEl = null;
/** Ob der SFTP-Tab gerade aktiv/sichtbar ist. @type {boolean} */
let   sftpOpen  = false;

/**
 * Zustand der beiden SFTP-Panels.
 * Jedes Panel hat: sftp_id (Server-Session-ID), path (aktuelles Verzeichnis),
 * selected (Set der ausgewählten Dateipfade), el (DOM-ID-Suffix).
 */
/**
 * Gibt die effektiv aktiven Pfade zurück:
 * Selektion wenn vorhanden, sonst den Eintrag unter dem Cursor.
 * @param {Object} panel - Panel-Objekt
 * @param {string} side  - "left" | "right"
 * @returns {string[]}
 */
function getEffectivePaths(panel, side) {
    if (panel.selected.size > 0) return [...panel.selected];
    const rows   = _getPanelRows(side);
    if (rows.length === 0) return [];
    // Cursor-Index: -1 → ersten Eintrag nehmen
    const curIdx = _panelCursor[side] >= 0 ? _panelCursor[side] : 0;
    const row    = rows[Math.min(curIdx, rows.length - 1)];
    const path   = row?.dataset.path;
    return path ? [path] : [];
}

/**
 * Prüft ob die aktuelle Auswahl eines Panels mindestens einen Ordner enthält.
 * Verwendet selectedDirs-Set das beim Anklicken der Checkboxen mitgepflegt wird.
 * @param {Object} panel - Panel-Objekt
 * @returns {boolean}
 */
function selectionHasDir(panel) {
    return panel.selectedDirs && panel.selectedDirs.size > 0;
}

// ── Schnellfilter ────────────────────────────────────────────

let _quickFilter = { left: "", right: "" };

/** Wendet Schnellfilter und Hidden-Filter auf die Einträge eines Panels an. */
/**
 * Wendet Schnellfilter und Versteckt-Filter auf alle Einträge eines Panels an.
 * @param {string} side - "left" | "right"
 */
function _applyQuickFilter(side) {
    const filter = _quickFilter[side].toLowerCase();
    const listEl = document.getElementById(`sftp-${side}-list`);
    if (!listEl) return;
    listEl.querySelectorAll(".sftp-entry[data-name]").forEach(row => {
        const name   = (row.dataset.name || "").toLowerCase();
        const hidden = !_showHidden && name.startsWith(".");
        const match  = !filter || name.includes(filter);
        row.style.display = (hidden || !match) ? "none" : "";
    });
}

/** Zeigt/versteckt Schnellfilter-Eingabefeld für ein Panel. */
/**
 * Öffnet das Schnellfilter-Eingabefeld im aktiven Panel.
 * @param {string} side - "left" | "right"
 */
function _openQuickFilter(side) {
    let el = document.getElementById(`sftp-${side}-filter`);
    if (!el) {
        el = document.createElement("div");
        el.id = `sftp-${side}-filter`;
        el.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 8px;background:var(--bg);border-bottom:1px solid var(--accent);";
        el.innerHTML = `<span style="color:var(--accent);font-family:var(--font-mono);font-size:var(--sftp-font-size,12px)">/</span>`
            + `<input id="sftp-${side}-filter-input" type="text" autocomplete="off" spellcheck="false"`
            + ` style="flex:1;background:transparent;border:none;outline:none;color:var(--text-bright);font-family:var(--font-mono);font-size:var(--sftp-font-size,12px)">`
            + `<span id="sftp-${side}-filter-clear" style="cursor:pointer;color:var(--text-muted);font-size:11px">✕</span>`;
        const list = document.getElementById(`sftp-${side}-list`);
        list.parentNode.insertBefore(el, list);

        const input = el.querySelector("input");
        input.addEventListener("input", () => {
            _quickFilter[side] = input.value;
            _applyQuickFilter(side);
            _resetCursor(side);
        });
        input.addEventListener("keydown", e => {
            if (e.key === "Escape" || e.key === "Enter") {
                e.stopPropagation();
                _closeQuickFilter(side);
            }
        });
        el.querySelector(`#sftp-${side}-filter-clear`).addEventListener("click", () => _closeQuickFilter(side));
    }
    el.style.display = "flex";
    el.querySelector("input").focus();
}

/**
 * Schließt den Schnellfilter und setzt den Filter zurück.
 * @param {string} side - "left" | "right"
 */
function _closeQuickFilter(side) {
    const el = document.getElementById(`sftp-${side}-filter`);
    if (el) el.style.display = "none";
    _quickFilter[side] = "";
    _applyQuickFilter(side);
    _resetCursor(side);
}

// ── Suchen-Button ───────────────────────────────────────────
document.getElementById("sftp-search-btn").addEventListener("click", () => {
    _openQuickFilter(activePanel);
});

// ── Owner/Perms Spalten Toggle ───────────────────────────────
let _showOwner = false;
let _showPerms = false;

/**
 * Setzt CSS-Variablen für Spaltenbreiten und Sichtbarkeit von Owner/Perms-Spalten.
 * Berechnet Pixelwerte aus der aktuellen SFTP-Schriftgröße für konsistente
 * Ausrichtung zwischen Header und Einträgen.
 */
function _applyColumnVisibility() {
    const root = document.documentElement;
    // Spaltenbreiten in px basierend auf der konfigurierten Schriftgröße
    const fs = parseFloat(getComputedStyle(document.documentElement)
                  .getPropertyValue("--sftp-font-size")) || 12;
    root.style.setProperty("--sftp-col-size",  (fs * 7)  + "px");
    root.style.setProperty("--sftp-col-mtime", (fs * 10) + "px");
    root.style.setProperty("--sftp-col-owner",  _showOwner ? (fs * 11) + "px" : "0px");
    root.style.setProperty("--sftp-show-owner", _showOwner ? "block" : "none");
    root.style.setProperty("--sftp-col-perms",  _showPerms ? (fs * 5)  + "px" : "0px");
    root.style.setProperty("--sftp-show-perms", _showPerms ? "block" : "none");
    root.style.setProperty("--sftp-col-name", "minmax(0, 1fr)");
    document.getElementById("sftp-owner-btn").classList.toggle("active", _showOwner);
    document.getElementById("sftp-perms-btn").classList.toggle("active", _showPerms);
}

document.getElementById("sftp-owner-btn").addEventListener("click", () => {
    _showOwner = !_showOwner;
    _applyColumnVisibility();
});

document.getElementById("sftp-perms-btn").addEventListener("click", () => {
    _showPerms = !_showPerms;
    _applyColumnVisibility();
});

// Initialzustand setzen
_applyColumnVisibility();

// ── Versteckte Dateien Toggle ─────────────────────────────────

document.getElementById("sftp-hidden-btn").addEventListener("click", () => {
    _showHidden = !_showHidden;
    document.getElementById("sftp-hidden-btn").classList.toggle("active", _showHidden);
    ["left", "right"].forEach(side => {
        if (panels[side].sftp_id) _applyQuickFilter(side);
    });
    _resetCursor(activePanel);
});

// Clipboard-Fallback für HTTP-Umgebungen (navigator.clipboard nur über HTTPS)
/**
 * Kopiert Text in die Zwischenablage. Nutzt execCommand als Fallback
 * wenn navigator.clipboard nicht verfügbar ist (HTTP ohne HTTPS).
 * @param {string} text - Zu kopierender Text
 * @param {Function} onSuccess - Callback bei Erfolg
 */
function fallbackCopy(text, onSuccess) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); if (onSuccess) onSuccess(); } catch(e) {}
    document.body.removeChild(ta);
}

let _showHidden = false;   // Versteckte Dateien anzeigen?
let _progressCopyId = null; // Aktuelle copy_id für Abbruch per ESC/Button

const panels = {
    left:  { sftp_id: null, path: "/", selected: new Set(), selectedDirs: new Set(), el: "left" },
    right: { sftp_id: null, path: "/", selected: new Set(), selectedDirs: new Set(), el: "right" },
};

/** Welches Panel gerade aktiv ist ("left" | "right"). */
let activePanel = "left";

/**
 * Setzt das aktive Panel und aktualisiert die visuelle Hervorhebung.
 * @param {string} side - "left" | "right"
 */
function setActivePanel(side) {
    activePanel = side;
    document.getElementById("sftp-left").classList.toggle("sftp-panel-active",  side === "left");
    document.getElementById("sftp-right").classList.toggle("sftp-panel-active", side === "right");
    updateSftpToolbar();
}

// ── SFTP als Tab ──────────────────────────────────────────────

/**
 * ⇄-Button: bei offenem SFTP-Tab dorthin wechseln, sonst öffnen.
 */
sftpBtn.addEventListener("click", () => {
    if (sftpOpen) activateSftp();
    else          openSftp();
});

/**
 * Öffnet den SFTP-Tab.
 * Legt den Tab in der Tab-Leiste an, hängt den sftpPane in den terminal-area
 * und befüllt die Server-Dropdowns (einmalig).
 */
function openSftp() {
    if (sftpTabEl) { activateSftp(); return; }

    sftpTabEl = document.createElement("div");
    sftpTabEl.className = "tab";
    sftpTabEl.id = "sftp-tab";
    sftpTabEl.innerHTML = `
        <div class="tab-dot"></div>
        <span>⇄ SFTP</span>
        <div class="tab-close" title="SFTP schließen">✕</div>`;
    sftpTabEl.addEventListener("click", e => {
        if (e.target.classList.contains("tab-close")) {
            showConfirm("SFTP schließen", "SFTP-Verbindungen trennen und Tab schließen?")
                .then(ok => { if (ok) closeSftp(); });
        }
        else activateSftp();
    });
    document.getElementById("tab-bar").appendChild(sftpTabEl);
    document.getElementById("terminal-area").appendChild(sftpPane);
    sftpBtn.classList.add("active");

    // Dropdowns nur befüllen wenn noch leer (z.B. nicht beim Restore)
    const leftSel = document.getElementById("sftp-left-server");
    if (!leftSel || leftSel.options.length === 0) initSftpPanels();
    activateSftp();
}

/**
 * Aktiviert den SFTP-Tab (setzt ihn als aktiven View).
 * Deaktiviert alle anderen Views via deactivateAll().
 */
function activateSftp() {
    deactivateAll();
    sftpOpen = true;
    sftpTabEl.classList.add("active");
    sftpPane.classList.add("active");
}

/**
 * Schließt den SFTP-Tab.
 * Trennt alle SFTP-Verbindungen serverseitig und bereinigt den State.
 * Wechselt zur letzten offenen Session, dem Grid oder dem Welcome-Screen.
 */
function closeSftp() {
    closeSftpConnections();
    if (sftpTabEl) { sftpTabEl.remove(); sftpTabEl = null; }
    sftpPane.classList.remove("active");
    sftpOpen = false;
    sftpBtn.classList.remove("active");

    if (sessions.length > 0) activateSession(sessions[sessions.length - 1].id);
    else if (gridActive) activateGrid();
    else { welcomeEl.style.display = "flex"; }
}

/**
 * Schließt alle SFTP-Verbindungen serverseitig und setzt den State zurück.
 * Wird auch von closeSftp() und beim beforeunload aufgerufen.
 */
function closeSftpConnections() {
    ["left","right"].forEach(side => {
        const panel = panels[side];
        if (panel.sftp_id) {
            fetch(`/sftp/${panel.sftp_id}`, { method: "DELETE" }).catch(()=>{});
            panel.sftp_id  = null;
            panel.preset   = null;
            panel.selected = new Set();
            const btn = document.getElementById(`sftp-${side}-connect`);
            if (btn) { btn.textContent = t("sftp.connect"); btn.classList.remove("connected"); }
            const list = document.getElementById(`sftp-${side}-list`);
            if (list) list.innerHTML = '<div class="sftp-placeholder">' + t('sftp.not_connected') + '</div>';
            document.getElementById(`sftp-${side}-path`).innerHTML = '<span class="sftp-bc-seg">/</span>';
        }
    });
    localStorage.removeItem("webssh_sftp");
    sftpOpen = false;
    hideSftpProgress();
    hideConflictDialog();
    updateSftpToolbar();
}

// ── Server-Dropdowns befüllen ─────────────────────────────────

/**
 * Befüllt die Server-Auswahlmenüs beider Panels mit den verfügbaren Presets.
 * Wird einmalig beim ersten Öffnen des SFTP-Tabs aufgerufen.
 */
async function initSftpPanels() {
    const resp    = await fetch("/presets");
    const presets = await resp.json();
    ["left","right"].forEach(side => {
        const sel = document.getElementById(`sftp-${side}-server`);
        sel.innerHTML = presets.map(p =>
            `<option value="${p.index}">${escHtml(p.title)} (${escHtml(p.host)}:${p.port})</option>`
        ).join("");
    });
}

// ── Verbinden / Trennen ───────────────────────────────────────

/**
 * Registriert Verbinden/Trennen-Handler für beide Panels.
 * Verbinden: öffnet SFTP-Verbindung zum gewählten Server,
 * Trennen:   schließt die Verbindung serverseitig.
 */
["left","right"].forEach(side => {
    document.getElementById(`sftp-${side}-connect`).addEventListener("click", async () => {
        const panel = panels[side];
        const btn   = document.getElementById(`sftp-${side}-connect`);

        if (panel.sftp_id) {
            // Trennen
            await fetch(`/sftp/${panel.sftp_id}`, { method: "DELETE" });
            panel.sftp_id  = null;
            panel.preset   = null;
            panel.selected = new Set();
            btn.textContent = t("sftp.connect");
            btn.classList.remove("connected");
            document.getElementById(`sftp-${side}-list`).innerHTML =
                '<div class="sftp-placeholder">' + t('sftp.not_connected') + '</div>';
            document.getElementById(`sftp-${side}-path`).innerHTML = '<span class="sftp-bc-seg">/</span>';
            updateSftpToolbar();
            return;
        }

        // Verbinden
        const presetIdx = document.getElementById(`sftp-${side}-server`).value;
        showSftpProgress(t("sftp.connecting"));
        await new Promise(r => requestAnimationFrame(r));
        btn.disabled = true;

        try {
            const resp = await fetch("/sftp/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ preset: parseInt(presetIdx), client_id: CLIENT_ID, side }),
            });
            const data = await resp.json();
            if (data.ok) {
                panel.sftp_id = data.sftp_id;
                panel.preset  = data;
                btn.textContent = t("sftp.disconnect");
                btn.classList.add("connected");
                hideSftpProgress();
                setSftpStatus(`${data.title} verbunden`, "ok");
                setActivePanel(side);
                await sftpLoadDir(side, "/");
            } else {
                hideSftpProgress();
                setSftpStatus(data.error, "error");
            }
        } catch(e) {
            hideSftpProgress();
            setSftpStatus(`Fehler: ${e.message || e}`, "error");
        } finally {
            btn.disabled = false;
        }
    });
});

// ── Verzeichnis laden ─────────────────────────────────────────

/**
 * Lädt ein Verzeichnis vom Server und rendert die Dateiliste.
 * Zeigt ".." für Navigation zum Elternverzeichnis (außer bei "/").
 * Unterstützt Checkboxen für Mehrfachauswahl und Doppelklick zum Wechseln.
 * @param {string} side - "left" | "right"
 * @param {string} path - Zu ladendes Verzeichnis
 */
async function sftpLoadDir(side, path) {
    const panel = panels[side];
    if (!panel.sftp_id) return;

    const listEl = document.getElementById(`sftp-${side}-list`);
    const pathEl = document.getElementById(`sftp-${side}-path`);
    listEl.innerHTML = '<div class="sftp-placeholder">Lade…</div>';

    try {
        const resp = await fetch(`/sftp/${panel.sftp_id}/ls?path=${encodeURIComponent(path)}`);
        const data = await resp.json();
        if (!data.ok) { setSftpStatus(data.error, "error"); return; }

        panel.path         = data.path;
        panel.selected     = new Set();
        panel.selectedDirs = new Set();

        // Breadcrumb rendern
        pathEl.innerHTML = "";

        // Root-Segment "/" immer anzeigen
        const rootSeg = document.createElement("span");
        rootSeg.className = "sftp-bc-seg";
        rootSeg.textContent = "/";
        rootSeg.addEventListener("click", () => sftpLoadDir(side, "/"));
        pathEl.appendChild(rootSeg);

        // Weitere Segmente (nur wenn Pfad nicht "/")
        const nonRootParts = data.path === "/" ? [] : data.path.split("/").filter(p => p !== "");
        let builtPath = "";
        nonRootParts.forEach(part => {
            builtPath += "/" + part;
            const capturedPath = builtPath;

            const sep = document.createElement("span");
            sep.className = "sftp-bc-sep";
            sep.textContent = "/";
            pathEl.appendChild(sep);

            const seg = document.createElement("span");
            seg.className = "sftp-bc-seg";
            seg.textContent = part;
            seg.addEventListener("click", () => sftpLoadDir(side, capturedPath));
            pathEl.appendChild(seg);
        });

        // Clipboard-Button mit HTTP-Fallback
        const copyBtn = document.createElement("span");
        copyBtn.className = "sftp-bc-copy";
        copyBtn.title = "Pfad kopieren";
        copyBtn.textContent = "⎘";
        copyBtn.addEventListener("click", () => {
            const text = data.path;
            const flash = () => {
                copyBtn.textContent = "✓";
                setTimeout(() => { copyBtn.textContent = "⎘"; }, 1200);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(flash).catch(() => fallbackCopy(text, flash));
            } else {
                fallbackCopy(text, flash);
            }
        });
        pathEl.appendChild(copyBtn);

        listEl.innerHTML = `
            <div class="sftp-list-header">
                <span class="sh-placeholder"></span>
                <span class="sh-placeholder"></span>
                <span class="sh-name">Name</span>
                <span class="sh-size">Gr\u00F6\u00DFe</span>
                <span class="sh-mtime">Ge\u00E4ndert</span>
                <span class="sh-owner">Eigent\u00FCmer</span>
                <span class="sh-perms">Rechte</span>
            </div>`;

        // ".." Eintrag
        if (data.path !== "/") {
            const up = document.createElement("div");
            up.className = "sftp-entry";
            up.innerHTML = `<span></span><span class="se-icon">📁</span>
                <span class="se-name is-dir">..</span><span class="se-size"></span><span class="se-mtime"></span><span class="se-owner"></span><span class="se-perms"></span>`;
            up.addEventListener("dblclick", () => {
                const parent = data.path.split("/").slice(0,-1).join("/") || "/";
                sftpLoadDir(side, parent);
            });
            listEl.appendChild(up);
        }

        data.entries.forEach(e => {
            const row = document.createElement("div");
            row.className = "sftp-entry";
            row.dataset.path  = `${data.path.replace(/\/$/, "")}/${e.name}`;
            row.dataset.isDir = e.is_dir;
            row.dataset.name  = e.name;
            row.dataset.size  = e.size  || 0;
            row.dataset.mtime = e.mtime || 0;
            row.dataset.perms = e.permissions || "";
            row.dataset.owner = e.owner || "";
            row.dataset.group = e.group || "";
            row.dataset.size  = e.size || 0;
            row.dataset.mtime = e.mtime || 0;
            row.dataset.perms = e.permissions || "";
            row.dataset.name  = e.name;

            const size  = e.is_dir ? "" : formatSize(e.size);
            const mtime = e.mtime ? (() => {
                const d   = new Date(e.mtime * 1000);
                const pad = n => String(n).padStart(2,"0");
                const now = Date.now();
                const age = now - d.getTime();
                // Älter als 180 Tage: Datum mit Jahr, sonst mit Uhrzeit (wie ls -l)
                if (age > 180 * 86400 * 1000) {
                    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${String(d.getFullYear()).slice(-2)}`;
                }
                return `${pad(d.getDate())}.${pad(d.getMonth()+1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            })() : "";

            const icon = e.is_dir
                ? (e.is_link ? "🔗" : "📁")
                : (e.is_link ? "🔗" : "📄");
            row.innerHTML = `
                <input type="checkbox" class="sftp-cb">
                <span class="se-icon">${icon}</span>
                <span class="se-name ${e.is_dir ? "is-dir" : ""}">${escHtml(e.name)}${e.is_link ? " <span class=\"sftp-symlink-badge\">↪</span>" : ""}</span>
                <span class="se-size">${size}</span>
                <span class="se-mtime">${mtime}</span>
                <span class="se-owner">${escHtml((e.owner||"") + ":" + (e.group||""))}</span>
                <span class="se-perms">${escHtml(e.permissions||"")}</span>`;

            row.addEventListener("mousedown", () => {
                setActivePanel(side);
                // Mausklick setzt Cursor auf diesen Eintrag
                const rows = _getPanelRows(side);
                const idx  = rows.indexOf(row);
                if (idx >= 0) _setCursor(side, idx);
            });

            row.querySelector(".sftp-cb").addEventListener("change", function() {
                setActivePanel(side);
                if (this.checked) {
                    panel.selected.add(row.dataset.path);
                    if (row.dataset.isDir === "true") panel.selectedDirs.add(row.dataset.path);
                    row.classList.add("selected");
                } else {
                    panel.selected.delete(row.dataset.path);
                    panel.selectedDirs.delete(row.dataset.path);
                    row.classList.remove("selected");
                }
                updateSftpToolbar();
            });

            if (e.is_dir) {
                row.addEventListener("dblclick", () => sftpLoadDir(side, row.dataset.path));
            } else if (!e.is_link) {
                // Einzelklick auf Datei → Vorschau versuchen
                row.addEventListener("dblclick", () => sftpPreview(panel, row.dataset.path));
            }

            // Versteckte Dateien ausblenden wenn gewünscht
            if (!_showHidden && e.name.startsWith(".")) {
                row.style.display = "none";
            }

            listEl.appendChild(row);
        });

        _applyQuickFilter(side);
        _resetCursor(side);
        updateSftpToolbar();
        _applyColumnVisibility();   // Spaltenbreiten nach jedem Verzeichnisladen neu berechnen
    } catch(err) {
        setSftpStatus(`${t("sftp.load_error")}: ${err.message || err}`, "error");
    }
}

// ── Tastaturnavigation ───────────────────────────────────────
//
// Wenn das SFTP-Tab offen ist und kein Modal/Overlay aktiv ist:
//   ArrowUp / ArrowDown  — Cursor in der Dateiliste bewegen
//   Space                — Eintrag selektieren/deselektieren
//   Enter                — Verzeichnis öffnen
//   Backspace            — übergeordnetes Verzeichnis
//   Tab                  — zwischen linkem und rechtem Panel wechseln

/** Aktueller Cursor-Index pro Panel (Index in den sichtbaren sftp-entry Zeilen). */
const _panelCursor = { left: -1, right: -1 };

/** Gibt alle navigierbaren Einträge eines Panels zurück (ohne Header, gefiltert). */
/**
 * Gibt alle sichtbaren, navigierbaren Einträge eines Panels zurück.
 * Gefiltert nach display:none (Schnellfilter, versteckte Dateien).
 * @param {string} side - "left" | "right"
 * @returns {HTMLElement[]}
 */
function _getPanelRows(side) {
    return Array.from(
        document.querySelectorAll(`#sftp-${side}-list .sftp-entry[data-path]`)
    ).filter(r => r.style.display !== "none");
}

/**
 * Setzt den visuellen Cursor auf einen bestimmten Index und scrollt ihn sichtbar.
 * @param {string} side - "left" | "right"
 * @param {number} idx - Ziel-Index in den sichtbaren Einträgen
 */
function _setCursor(side, idx) {
    const rows = _getPanelRows(side);
    rows.forEach((r, i) => r.classList.toggle("sftp-cursor", i === idx));
    _panelCursor[side] = idx;
    if (rows[idx]) rows[idx].scrollIntoView({ block: "nearest" });
}

/** Stellt sicher dass der Cursor nach einem Verzeichniswechsel zurückgesetzt wird. */
/**
 * Setzt den Cursor auf den ersten Eintrag zurück (nach Verzeichniswechsel).
 * @param {string} side - "left" | "right"
 */
function _resetCursor(side) { _setCursor(side, 0); }

// Nach jedem Verzeichnis-Load Cursor zurücksetzen
const _origSftpLoadDir = sftpLoadDir;
// (wird unten durch Patch ergänzt — direkt im sftpLoadDir-Aufruf via updateSftpToolbar)

document.addEventListener("keydown", async e => {
    if (!sftpOpen) return;
    // Kein Nav wenn ein Eingabefeld, Modal oder Overlay fokussiert ist
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (document.getElementById("sftp-conflict-overlay")?.classList.contains("open")) return;
    if (document.getElementById("confirm-overlay")?.classList.contains("open")) return;
    if (document.getElementById("sftp-input-overlay")?.classList.contains("open")) return;
    if (document.getElementById("sftp-preview-overlay")?.classList.contains("open")) return;
    if (document.getElementById("settings-overlay")?.style.display === "flex") return;
    if (_progressCopyId) return;   // Kopiervorgang läuft

    const side  = activePanel;
    const panel = panels[side];
    const rows  = _getPanelRows(side);
    let   cur   = _panelCursor[side];

    switch (e.key) {
        case "ArrowDown":
            e.preventDefault();
            _setCursor(side, Math.min(cur + 1, rows.length - 1));
            break;

        case "ArrowUp":
            e.preventDefault();
            _setCursor(side, Math.max(cur - 1, 0));
            break;

        case "Enter": {
            e.preventDefault();
            const row = rows[cur];
            if (!row) break;
            if (row.dataset.isDir === "true") {
                await sftpLoadDir(side, row.dataset.path);
                _resetCursor(side);
            }
            break;
        }

        case " ": {
            e.preventDefault();
            const row = rows[cur];
            if (!row) break;
            const cb = row.querySelector(".sftp-cb");
            if (!cb) break;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change"));
            // Cursor automatisch einen Schritt weiter
            _setCursor(side, Math.min(cur + 1, rows.length - 1));
            break;
        }

        case "Backspace": {
            e.preventDefault();
            if (!panel.sftp_id) break;
            const parent = panel.path === "/"
                ? "/"
                : panel.path.split("/").slice(0, -1).join("/") || "/";
            if (parent !== panel.path) {
                await sftpLoadDir(side, parent);
                _resetCursor(side);
            }
            break;
        }

        case "Tab": {
            e.preventDefault();
            setActivePanel(side === "left" ? "right" : "left");
            break;
        }

        case "Home": {
            e.preventDefault();
            if (rows.length > 0) _setCursor(side, 0);
            break;
        }
        case "End": {
            e.preventDefault();
            if (rows.length > 0) _setCursor(side, rows.length - 1);
            break;
        }
        case "PageUp": {
            e.preventDefault();
            if (rows.length > 0) {
                const listEl  = document.getElementById(`sftp-${side}-list`);
                const rowH    = rows[0].getBoundingClientRect().height || 24;
                const pageRows = Math.max(1, Math.floor(listEl.clientHeight / rowH));
                _setCursor(side, Math.max(0, cur - pageRows));
            }
            break;
        }
        case "PageDown": {
            e.preventDefault();
            if (rows.length > 0) {
                const listEl  = document.getElementById(`sftp-${side}-list`);
                const rowH    = rows[0].getBoundingClientRect().height || 24;
                const pageRows = Math.max(1, Math.floor(listEl.clientHeight / rowH));
                _setCursor(side, Math.min(rows.length - 1, cur + pageRows));
            }
            break;
        }

        case "/": {
            e.preventDefault();
            _openQuickFilter(side);
            break;
        }
        case "F2": {
            e.preventDefault();
            const renameBtn = document.getElementById("sftp-rename-btn");
            if (!renameBtn.disabled) renameBtn.click();
            break;
        }
        case "F3": {
            e.preventDefault();
            // Vorschau: Eintrag unter Cursor oder ersten selektierten Eintrag
            const previewPaths = getEffectivePaths(panel, side);
            if (previewPaths.length === 1) {
                const row = _getPanelRows(side).find(r => r.dataset.path === previewPaths[0]);
                if (row && row.dataset.isDir !== "true") sftpPreview(panel, previewPaths[0]);
            }
            break;
        }
        case "F5": {
            e.preventDefault();
            const copyBtn = document.getElementById("sftp-copy-btn");
            if (!copyBtn.disabled) copyBtn.click();
            break;
        }
        case "F7": {
            e.preventDefault();
            const mkdirBtn = document.getElementById("sftp-mkdir-btn");
            if (!mkdirBtn.disabled) mkdirBtn.click();
            break;
        }
        case "F8":
        case "Delete": {
            e.preventDefault();
            const deleteBtn = document.getElementById("sftp-delete-btn");
            if (!deleteBtn.disabled) deleteBtn.click();
            break;
        }
    }
});

// Cursor nach jedem sftpLoadDir zurücksetzen
const _sftpLoadDirOrig = sftpLoadDir;
// Cursor-Reset wird direkt am Ende von sftpLoadDir eingehängt (nach updateSftpToolbar)

// ── Toolbar-Buttons aktivieren/deaktivieren ───────────────────

/**
 * Aktualisiert den Enabled/Disabled-Zustand aller Toolbar-Buttons.
 * Wird aufgerufen wenn sich Verbindungsstatus oder Selektion ändert.
 */
function updateSftpToolbar() {
    const actPanel  = panels[activePanel];
    const inactSide = activePanel === "left" ? "right" : "left";
    const actConn   = !!actPanel.sftp_id;
    const inactConn = !!panels[inactSide].sftp_id;
    const actSel    = actPanel.selected.size > 0;
    // Cursor-Eintrag als Fallback wenn nichts selektiert
    const curIdx    = _panelCursor[activePanel];
    const curRows   = _getPanelRows(activePanel);
    // hasCursor: Cursor explizit gesetzt ODER mind. 1 Eintrag vorhanden (Cursor wäre auf erstem)
    const hasCursor = curRows.length > 0 && (curIdx >= 0 || true);
    // "etwas aktiv" = Selektion ODER Einträge vorhanden (Cursor greift auf ersten)
    const actSelOrCur = actSel || (curRows.length > 0);

    const copyBtn = document.getElementById("sftp-copy-btn");
    copyBtn.innerHTML = activePanel === "left" ? "→ Kopieren <span class=\"sftp-fkey\">(F5)</span>" : "← Kopieren <span class=\"sftp-fkey\">(F5)</span>";
    copyBtn.disabled    = !(actConn && inactConn && actSelOrCur);

    const dlBtn = document.getElementById("sftp-download-btn");
    dlBtn.disabled = !(actConn && actSelOrCur);
    // ZIP wenn: mind. 1 Ordner selektiert ODER mind. 2 Einträge selektiert
    const selPaths = [...actPanel.selected];
    const hasDir   = selectionHasDir(actPanel);
    const needsZip = hasDir || selPaths.length > 1;
    dlBtn.textContent = needsZip ? "⬇ " + t("sftp.download_zip") : "⬇ " + t("sftp.download");
    document.getElementById("sftp-mkdir-btn").disabled    = !actConn;
    // Umbenennen: genau 1 Eintrag (Selektion oder Cursor), nicht mehrere
    document.getElementById("sftp-rename-btn").disabled   =
        !(actConn && actSelOrCur && actPanel.selected.size <= 1);
    document.getElementById("sftp-delete-btn").disabled   = !(actConn && actSelOrCur);
    document.getElementById("sftp-upload-btn").disabled   = !actConn;
}

// ── Kopieren (Server-zu-Server) ───────────────────────────────

/**
 * Kopiert Dateien vom aktiven Panel ins inaktive Panel.
 */
document.getElementById("sftp-copy-btn").addEventListener("click", async () => {
    const inactSide = activePanel === "left" ? "right" : "left";
    await sftpCopy(activePanel, inactSide);
});

/**
 * Führt den Server-zu-Server Kopiervorgang durch.
 * Nutzt SSE (Server-Sent Events) für Fortschrittsmeldungen.
 * Bei Konflikten (Datei existiert) wird ein Dialog angezeigt
 * und die Antwort per POST /sftp/conflict-resolve zurückgeschickt.
 * @param {string} src - Quell-Panel-Seite ("left" | "right")
 * @param {string} dst - Ziel-Panel-Seite
 */
async function sftpCopy(src, dst) {
    const srcPanel = panels[src];
    const dstPanel = panels[dst];
    const paths    = getEffectivePaths(srcPanel, src);
    const total    = paths.length;
    let   copyId   = null;

    showSftpProgress(t("sftp.ready"));
    await new Promise(r => requestAnimationFrame(r));

    return new Promise((resolve) => {
        fetch("/sftp/copy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                src_sftp_id: srcPanel.sftp_id,
                src_path:    paths,
                dst_sftp_id: dstPanel.sftp_id,
                dst_dir:     dstPanel.path,
            }),
        }).then(resp => {
            const reader  = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";

            function pump() {
                reader.read().then(({ done, value }) => {
                    if (done) { resolve(); return; }
                    buf += decoder.decode(value, { stream: true });
                    const lines = buf.split("\n");
                    buf = lines.pop();
                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        try {
                            const msg = JSON.parse(line.slice(6));
                            if (msg.type === "counting") {
                                showSftpProgress(t("sftp.counting"));
                            } else if (msg.type === "start") {
                                copyId = msg.copy_id;
                                setProgressCopyId(copyId);
                                showSftpProgress("Bereit", `0 von ${msg.total}`);
                            } else if (msg.type === "progress") {
                                showSftpProgress(msg.file, `${msg.current} von ${msg.total}`);
                            } else if (msg.type === "conflict") {
                                showConflictDialog(copyId, msg.file, msg.index, msg.total);
                            } else if (msg.type === "skipped") {
                                showSftpProgress(msg.file, "übersprungen");
                            } else if (msg.type === "done") {
                                hideSftpProgress();
                                hideConflictDialog();
                                if (msg.aborted) {
                                    setSftpStatus(t("sftp.aborted"), "");
                                    sftpLoadDir(dst, dstPanel.path);
                                } else if (msg.ok) {
                                    setSftpStatus(`${msg.count} Datei(en) kopiert ✓`, "ok");
                                    sftpLoadDir(dst, dstPanel.path);
                                } else {
                                    setSftpStatus(msg.errors ? msg.errors[0] : "Fehler", "error");
                                    sftpLoadDir(dst, dstPanel.path);
                                }
                            }
                        } catch(e) {}
                    }
                    pump();
                }).catch(() => { hideSftpProgress(); hideConflictDialog(); resolve(); });
            }
            pump();
        }).catch(e => {
            hideSftpProgress();
            setSftpStatus(`Kopier-Fehler: ${e.message}`, "error");
            resolve();
        });
    });
}

// ── Konflikt-Dialog ───────────────────────────────────────────

/**
 * Zeigt den Konflikt-Dialog wenn eine Datei am Zielort bereits existiert.
 * Der Benutzer kann wählen: Überschreiben, Überspringen, Alle überschreiben,
 * Alle überspringen, Abbrechen.
 * Die Entscheidung wird per POST /sftp/conflict-resolve an den Server gesendet,
 * der auf die Antwort wartet (asyncio.Event).
 * @param {string} copyId - ID des laufenden Kopiervorgangs
 * @param {string} filename - Name der konfliktierenden Datei
 * @param {number} index - Aktueller Datei-Index
 * @param {number} total - Gesamtzahl der zu kopierenden Dateien
 */
function showConflictDialog(copyId, filename, index, total) {
    document.getElementById("sftp-conflict-msg").textContent =
        `"${filename}" (${index} von ${total})`;
    document.getElementById("sftp-conflict-overlay").classList.add("open");

    document.querySelectorAll(".sca-btn").forEach(btn => {
        btn.onclick = () => {
            hideConflictDialog();
            fetch("/sftp/conflict-resolve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ copy_id: copyId, action: btn.dataset.action }),
            });
        };
    });
}

/** Schließt den Konflikt-Dialog. */
/** Versteckt den Kopier-Konflikt-Dialog und löst ggf. ein ausstehende Promise auf. */
function hideConflictDialog() {
    document.getElementById("sftp-conflict-overlay").classList.remove("open");
}

// ── Ordner anlegen ────────────────────────────────────────────

document.getElementById("sftp-mkdir-btn").addEventListener("click", async () => {
    const side  = activePanel;
    const panel = panels[side];
    const name  = await showPrompt("📁 Neuer Ordner");
    if (!name) return;
    const path = `${panel.path.replace(/\/$/, "")}/${name}`;
    const resp = await fetch(`/sftp/${panel.sftp_id}/mkdir`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
    });
    const data = await resp.json();
    if (data.ok) { setSftpStatus(t("sftp.mkdir_done") + " ✓", "ok"); await sftpLoadDir(side, panel.path); }
    else setSftpStatus(data.error, "error");
});

// ── Umbenennen ────────────────────────────────────────────────

document.getElementById("sftp-rename-btn").addEventListener("click", async () => {
    const side  = activePanel;
    const panel = panels[side];
    const paths = getEffectivePaths(panel, side);
    if (paths.length !== 1) { setSftpStatus("Genau eine Datei auswählen", "error"); return; }
    const oldPath = paths[0];
    const oldName = oldPath.split("/").pop();
    const newName = await showPrompt("✏ Umbenennen", oldName);
    if (!newName || newName === oldName) return;
    const newPath = oldPath.replace(/[^/]+$/, newName);
    const resp = await fetch(`/sftp/${panel.sftp_id}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
    });
    const data = await resp.json();
    if (data.ok) { setSftpStatus(t("sftp.renamed") + " ✓", "ok"); await sftpLoadDir(side, panel.path); }
    else setSftpStatus(data.error, "error");
});

// ── Löschen ───────────────────────────────────────────────────

document.getElementById("sftp-delete-btn").addEventListener("click", async () => {
    const side  = activePanel;
    const panel = panels[side];
    const paths = getEffectivePaths(panel, side);
    const serverName = panels[activePanel].preset?.title || activePanel;
    // Dateinamen für den Dialog aufbereiten (max. 4, dann "... und X weitere")
    const names    = paths.map(p => p.split("/").pop());
    const MAX_SHOW = 4;
    let nameList;
    if (names.length <= MAX_SHOW) {
        nameList = names.map(n => "\u2022 " + n).join("\n");
    } else {
        nameList = names.slice(0, MAX_SHOW).map(n => "\u2022 " + n).join("\n")
            + "\n\u2022 \u2026 und " + (names.length - MAX_SHOW) + " weitere";
    }
    const confirmed = await showConfirm(
        "\uD83D\uDDD1 L\u00F6schen \u2014 " + serverName,
        t("sftp.delete_confirm", {n: paths.length}) + "\n\n" + nameList
    );
    if (!confirmed) return;
    showSftpProgress(t("sftp.loading"), `${paths.length} Element(e)`);
    document.getElementById("sftp-progress-abort").style.display = "none";
    await new Promise(r => requestAnimationFrame(r));
    try {
        const resp = await fetch(`/sftp/${panel.sftp_id}/delete`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths }),
        });
        const data = await resp.json();
        if (data.ok) { setSftpStatus(t("sftp.deleted") + " ✓", "ok"); await sftpLoadDir(side, panel.path); }
        else setSftpStatus(data.error, "error");
    } finally {
        hideSftpProgress();
        document.getElementById("sftp-progress-abort").style.display = "";
    }
});

// ── Download ──────────────────────────────────────────────────

/**
 * Einzelne Datei: direkter Browser-Download per <a> Link.
 * Mehrere Dateien / Verzeichnisse: ZIP-Download via POST /download-zip.
 */
document.getElementById("sftp-download-btn").addEventListener("click", async () => {
    const panel = panels[activePanel];
    const paths = getEffectivePaths(panel, activePanel);
    if (paths.length === 0) return;

    // ZIP wenn: mind. 1 Ordner selektiert ODER mind. 2 Einträge
    const hasDir   = selectionHasDir(panel);
    const needsZip = hasDir || paths.length > 1;

    if (!needsZip) {
        // Einzelne Datei — direkter Download
        const a = document.createElement("a");
        a.href     = `/sftp/${panel.sftp_id}/download?path=${encodeURIComponent(paths[0])}`;
        a.download = paths[0].split("/").pop();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
    }

    // Verzeichnis oder mehrere Einträge — als ZIP herunterladen
    showSftpProgress(t("sftp.zipping"), `${paths.length} Einträge`);
    await new Promise(r => requestAnimationFrame(r));
    try {
        // ZIP-Name aus dem aktuellen Verzeichnisnamen ableiten
        const pathParts = panel.path.split("/").filter(Boolean);
        const dirName   = pathParts.length > 0 ? pathParts[pathParts.length - 1] : "download";
        const resp = await fetch(`/sftp/${panel.sftp_id}/download-zip`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ paths, name: dirName }),
        });
        if (!resp.ok) { setSftpStatus(`ZIP-Fehler: ${await resp.text()}`, "error"); return; }
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = `${dirName}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch(e) {
        setSftpStatus(`ZIP-Fehler: ${e.message || e}`, "error");
    } finally {
        hideSftpProgress();
    }
});

// ── Upload ────────────────────────────────────────────────────

document.getElementById("sftp-upload-btn").addEventListener("click", () => {
    document.getElementById("sftp-upload-input").click();
});

/**
 * Lädt ausgewählte Dateien vom Browser auf den Server hoch.
 * Bei Konflikten (HTTP 409) wird ein Dialog angezeigt.
 * Unterstützt "Alle überschreiben" / "Alle überspringen" für mehrere Dateien.
 */
async function _uploadFiles(side, files) {
    const panel = panels[side];
    const total   = files.length;
    showSftpProgress(t("sftp.uploading"), `0 von ${total}`);
    await new Promise(r => requestAnimationFrame(r));

    let ok = 0, skipped = 0, globalAction = null, aborted = false;

    for (let i = 0; i < files.length; i++) {
        if (aborted) break;
        const file = files[i];
        showSftpProgress(file.name, `${i+1} von ${total}`);

        const url    = `/sftp/${panel.sftp_id}/upload?path=${encodeURIComponent(panel.path)}`;
        let action   = globalAction;
        try {
            const fd = new FormData();
            fd.append("file", file);
            const resp = await fetch(action ? `${url}&action=${action}` : url,
                { method: "POST", body: fd });

            // 413: Datei zu groß (Proxy oder Server begrenzt Upload-Größe)
            if (resp.status === 413) {
                hideSftpProgress();
                setSftpStatus(`"${file.name}" ist zu groß für den Upload (HTTP 413 — Proxy-Limit). Bitte client_max_body_size in nginx erhöhen.`, "error");
                aborted = true;
                break;
            }

            const data = await resp.json();

            if (resp.status === 409 && data.conflict && action === null) {
                // Konflikt — Dialog anzeigen
                const decision = await showUploadConflictDialog(file.name, i+1, total);
                if (decision === "abort")         { aborted = true; break; }
                if (decision === "skip")          { skipped++; continue; }
                if (decision === "skip_all")      { globalAction = "skip"; skipped++; continue; }
                if (decision === "overwrite_all") { globalAction = "overwrite"; action = "overwrite"; }
                else if (decision === "overwrite"){ action = "overwrite"; }

                // Nochmal mit Aktion senden
                const fd2 = new FormData();
                fd2.append("file", file);
                const resp2 = await fetch(`${url}&action=${action}`, { method: "POST", body: fd2 });
                const data2 = await resp2.json();
                if (data2.ok && !data2.skipped) ok++;
                else if (data2.skipped) skipped++;
            } else if (data.ok && !data.skipped) {
                ok++;
            } else if (data.skipped) {
                skipped++;
            }
        } catch(e) {}
    }

    hideSftpProgress();
    const parts = [];
    if (ok > 0)      parts.push(`${ok} ${t("sftp.uploaded")}`);
    if (skipped > 0) parts.push(`${skipped} ${t("sftp.skipped")}`);
    setSftpStatus((aborted ? "Abgebrochen: " : "") + parts.join(", ") + " ✓", "ok");
    await sftpLoadDir(side, panel.path);
}

document.getElementById("sftp-upload-input").addEventListener("change", async function() {
    await _uploadFiles(activePanel, [...this.files]);
    this.value = "";
});

/**
 * Zeigt den Upload-Konflikt-Dialog (gleicher Dialog wie beim Kopieren).
 * Gibt ein Promise zurück das mit der Benutzerentscheidung aufgelöst wird.
 * @param {string} filename - Dateiname
 * @param {number} index - Aktueller Datei-Index
 * @param {number} total - Gesamtzahl
 * @returns {Promise<string>} Entscheidung: "overwrite"|"skip"|"overwrite_all"|"skip_all"|"abort"
 */
function showUploadConflictDialog(filename, index, total) {
    return new Promise(resolve => {
        document.getElementById("sftp-conflict-msg").textContent =
            `"${filename}" (${index} von ${total})`;
        document.getElementById("sftp-conflict-overlay").classList.add("open");
        document.querySelectorAll(".sca-btn").forEach(btn => {
            btn.onclick = () => {
                document.getElementById("sftp-conflict-overlay").classList.remove("open");
                resolve(btn.dataset.action);
            };
        });
    });
}

// ── Bestätigungs-Dialog ───────────────────────────────────────

/**
 * Zeigt einen modalen Bestätigungs-Dialog.
 * Unterstützt Enter (OK) und Escape (Abbrechen) als Tastatur-Shortcuts.
 * @param {string} title - Dialog-Titel
 * @param {string} message - Bestätigungstext
 * @returns {Promise<boolean>} true wenn OK, false wenn Abbrechen
 */
function showConfirm(title, message) {
    return new Promise(resolve => {
        document.getElementById("confirm-title").textContent = title;
        // pre-line: \n wird als Zeilenumbruch gerendert (fuer Dateilisten)
        const msgEl = document.getElementById("confirm-message");
        msgEl.style.whiteSpace = "pre-line";
        msgEl.textContent = message;
        document.getElementById("confirm-overlay").classList.add("open");

        const ok     = document.getElementById("confirm-ok");
        const cancel = document.getElementById("confirm-cancel");

        function cleanup(result) {
            document.getElementById("confirm-overlay").classList.remove("open");
            ok.removeEventListener("click", onOk);
            cancel.removeEventListener("click", onCancel);
            document.removeEventListener("keydown", onKey);
            resolve(result);
        }
        const onOk     = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onKey    = e => {
            if (e.key === "Enter")  { e.preventDefault(); cleanup(true);  }
            if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
        };
        ok.addEventListener("click", onOk);
        cancel.addEventListener("click", onCancel);
        document.addEventListener("keydown", onKey);
        setTimeout(() => ok.focus(), 50);
    });
}

// ── Status und Fortschritt ────────────────────────────────────

/**
 * Zeigt das Fortschritts-Popup mit Spinner und Nachricht.
 * @param {string} msg - Anzeigetext
 */
// Aktuelle copy_id für Abbruch per ESC/Button (Deklaration oben)

/**
 * Zeigt das Fortschritts-Popup mit Dateiname und Zähler.
 * @param {string} file  - Dateiname oder Status-Text (links, gekürzt)
 * @param {string} count - Zähler-Text (rechts, fest)
 */
function showSftpProgress(file, count = "") {
    document.getElementById("sftp-progress-file").textContent  = file;
    document.getElementById("sftp-progress-count").textContent = count;
    document.getElementById("sftp-progress-popup").classList.add("visible");
}

/** Versteckt das Fortschritts-Popup. */
/** Versteckt das Fortschritts-Popup und aktiviert den Abbrechen-Button wieder. */
function hideSftpProgress() {
    document.getElementById("sftp-progress-popup").classList.remove("visible");
    _progressCopyId = null;
}

/** Setzt die copy_id für den Abbruch-Button/ESC. */
/**
 * Setzt die aktuelle Copy-ID für den Abbrech-Mechanismus.
 * @param {string|null} copyId - Server-seitige Copy-ID oder null
 */
function setProgressCopyId(copyId) {
    _progressCopyId = copyId;
}

/** Sendet einen Abbruch-Request an den Server für den laufenden Kopiervorgang. */
async function abortCurrentCopy() {
    if (!_progressCopyId) return;
    try {
        await fetch("/sftp/conflict-resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ copy_id: _progressCopyId, action: "abort" }),
        });
    } catch(e) {}
    _progressCopyId = null;
}

// Abbruch per ESC
document.addEventListener("keydown", e => {
    if (e.key === "Escape" && _progressCopyId) {
        abortCurrentCopy();
    }
});

// Abbruch per Button
document.getElementById("sftp-progress-abort").addEventListener("click", () => {
    abortCurrentCopy();
});

/**
 * Setzt den Status-Text in der SFTP-Toolbar.
 * @param {string} msg - Statustext
 * @param {string} type - CSS-Klasse ("ok" | "error" | "busy" | "")
 * @param {boolean} spinner - Spinner anzeigen
 */
function setSftpStatus(msg, type = "", spinner = false) {
    const el = document.getElementById("sftp-status");
    el.className = type;
    if (spinner) {
        el.innerHTML = `<span class="sftp-spinner"></span>${escHtml(msg)}`;
    } else {
        el.textContent = msg;
    }
}

/**
 * Formatiert eine Dateigröße in lesbare Einheiten (B, KB, MB, GB).
 * @param {number} bytes - Größe in Bytes
 * @returns {string} Formatierte Größe
 */
function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B","KB","MB","GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

// ── Drag & Drop Upload ───────────────────────────────────────

["left", "right"].forEach(side => {
    const listEl = document.getElementById(`sftp-${side}-list`);

    listEl.addEventListener("dragover", e => {
        if (!panels[side].sftp_id) return;
        e.preventDefault();
        listEl.classList.add("sftp-drop-target");
    });
    listEl.addEventListener("dragleave", e => {
        if (!e.currentTarget.contains(e.relatedTarget))
            listEl.classList.remove("sftp-drop-target");
    });
    listEl.addEventListener("drop", async e => {
        e.preventDefault();
        listEl.classList.remove("sftp-drop-target");
        if (!panels[side].sftp_id) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        setActivePanel(side);
        // Upload-Logik wiederverwenden
        await _uploadFiles(side, files);
    });
});

// ── SFTP-State Persistenz ─────────────────────────────────────

/**
 * Stellt SFTP-Verbindungen nach Browser-Reload oder Übernahme wieder her.
 * Fragt den Server nach aktiven SFTP-Sessions dieser client_id.
 * Im single_user-Modus werden alle Sessions zurückgegeben (auch von anderen Browsern).
 * Die side-Zuordnung wird aus localStorage, dann aus server-side _side, dann Fallback bestimmt.
 */
async function restoreSftpState() {
    try {
        const resp = await fetch(`/sftp/sessions?client_id=${CLIENT_ID}`);
        if (!resp.ok) return;
        const sessions = await resp.json();
        if (!sessions.length) return;

        await initSftpPanels();

        let anyRestored = false;
        const raw = localStorage.getItem("webssh_sftp");
        const localState = raw ? JSON.parse(raw) : {};

        for (const s of sessions) {
            // Side-Priorität: localStorage > server-side _side > Fallback
            const side = (localState.left?.sftp_id  === s.sftp_id) ? "left"  :
                         (localState.right?.sftp_id === s.sftp_id) ? "right" :
                         (s.side === "left" || s.side === "right")  ? s.side  :
                         (!panels.left.sftp_id ? "left" : "right");

            panels[side].sftp_id = s.sftp_id;
            panels[side].preset  = { title: s.title };

            const sel = document.getElementById(`sftp-${side}-server`);
            if (sel) {
                const match = [...sel.options].find(o => o.text.startsWith(s.title));
                if (match) sel.value = match.value;
            }

            const btn = document.getElementById(`sftp-${side}-connect`);
            btn.textContent = t("sftp.disconnect");
            btn.classList.add("connected");
            await sftpLoadDir(side, s.current_path || "/");
            anyRestored = true;
        }

        if (anyRestored) {
            openSftp();
            setSftpStatus(t("sftp.connections_restored"), "ok");
        }
    } catch(e) {}
}
// ── Datei-Vorschau ────────────────────────────────────────────

/**
 * Lädt eine Datei vom Server und zeigt sie im Vorschau-Modal an.
 * Nur für Text-Dateien (ASCII/UTF-8/Latin-1). Binärdateien werden abgelehnt.
 * @param {Object} panel - Panel-Objekt mit sftp_id
 * @param {string} path  - Vollständiger Pfad der Datei
 */
async function sftpPreview(panel, path) {
    if (!panel.sftp_id) return;
    const filename = path.split("/").pop();

    // Modal öffnen mit Ladeindikator
    const overlay  = document.getElementById("sftp-preview-overlay");
    const titleEl  = document.getElementById("sftp-preview-title");
    const metaEl   = document.getElementById("sftp-preview-meta");
    const contentEl = document.getElementById("sftp-preview-content");
    const footerEl = document.getElementById("sftp-preview-footer");

    titleEl.textContent   = filename;
    metaEl.textContent    = "";
    contentEl.textContent = "Lade…";
    footerEl.textContent  = "";
    overlay.classList.add("open");

    try {
        const resp = await fetch(`/sftp/${panel.sftp_id}/preview?path=${encodeURIComponent(path)}`);
        const data = await resp.json();

        if (!data.ok) {
            if (data.binary) {
                contentEl.textContent = "[Binärdatei — keine Vorschau möglich]";
            } else {
                contentEl.textContent = `[Fehler: ${data.error || "Unbekannt"}]`;
            }
            return;
        }

        contentEl.textContent = data.text;
        metaEl.textContent    = `${data.encoding} · ${formatSize(data.size)}`;
        if (data.truncated) {
            footerEl.textContent = `⚠ Vorschau auf ${formatSize(524288)} begrenzt — Datei ist größer`;
        }
    } catch(e) {
        contentEl.textContent = `[Ladefehler: ${e.message || e}]`;
    }
}

// ── Eingabe-Dialog ───────────────────────────────────────────

/**
 * Zeigt einen eigenen Eingabe-Dialog (ersetzt prompt()).
 * @param {string} title     - Titelzeile
 * @param {string} defaultVal - Vorbelegter Wert
 * @returns {Promise<string|null>} Eingabe oder null bei Abbrechen
 */
function showPrompt(title, defaultVal = "") {
    return new Promise(resolve => {
        const overlay = document.getElementById("sftp-input-overlay");
        const field   = document.getElementById("sftp-input-field");
        const okBtn   = document.getElementById("sftp-input-ok");
        const cancelBtn = document.getElementById("sftp-input-cancel");

        document.getElementById("sftp-input-title").textContent = title;
        field.value = defaultVal;
        overlay.classList.add("open");
        setTimeout(() => {
            field.focus();
            field.select();
        }, 50);

        function finish(result) {
            overlay.classList.remove("open");
            okBtn.removeEventListener("click", onOk);
            cancelBtn.removeEventListener("click", onCancel);
            field.removeEventListener("keydown", onKey);
            resolve(result);
        }

        function onOk()     { finish(field.value.trim() || null); }
        function onCancel() { finish(null); }
        function onKey(e) {
            if (e.key === "Enter")  { e.preventDefault(); finish(field.value.trim() || null); }
            if (e.key === "Escape") { e.preventDefault(); finish(null); }
        }

        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        field.addEventListener("keydown", onKey);
    });
}

// Vorschau schließen
document.getElementById("sftp-preview-close").addEventListener("click", () => {
    document.getElementById("sftp-preview-overlay").classList.remove("open");
});
document.getElementById("sftp-preview-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget)
        e.currentTarget.classList.remove("open");
});
document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
        document.getElementById("sftp-preview-overlay").classList.remove("open");
    }
});