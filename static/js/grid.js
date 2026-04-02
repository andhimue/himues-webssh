/**
 * grid.js — Split-View Grid System
 *
 * Verantwortlich für:
 *   - Grid-Tab (⊞) mit 2×1, 1×2 und 2×2 Layouts
 *   - Jede Grid-Zelle hat eine eigene SSH-Session und ein eigenes xterm-Terminal
 *   - Grid-Sessions erscheinen nicht in der normalen Tab-Leiste
 *   - Grid-State Persistenz: beim Reload und Browser-Übernahme wird das Grid
 *     mit allen Sessions wiederhergestellt
 *   - Serverseitige Speicherung des Grid-State für Browser-Übernahme
 *
 * Grid-Layouts:
 *   2x1: Zwei Spalten nebeneinander (vertikal geteilt)
 *   1x2: Zwei Zeilen übereinander (horizontal geteilt)
 *   2x2: Vier Zellen im 2×2-Raster
 *
 * Abhängigkeiten: config.js, sessions.js, launcher.js
 * Wird verwendet von: sftp.js (closeSftpConnections), ui.js, main.js
 */

// ── Grid-Zustand ──────────────────────────────────────────────

/** Aktuelles Grid-Layout ("2x1" | "1x2" | "2x2"). @type {string} */
let gridLayout   = "1x1";
/** Das Tab-Element des Grid-Tabs in der Tab-Leiste. @type {HTMLElement|null} */
let gridTabEl    = null;
/** Ob der Grid-Tab gerade aktiv/sichtbar ist. @type {boolean} */
let gridActive   = false;
/**
 * Array der Grid-Zellen. Jede Zelle hat:
 *   preset, term, fitAddon, pane, ws, session_id, state
 * @type {Array}
 */
let gridCells    = [];
/**
 * Index der Grid-Zelle die auf eine Serverauswahl im Launcher wartet.
 * null wenn keine Zelle wartet.
 * @type {number|null}
 */
let pendingCell  = null;

/** Anzahl der Zellen pro Layout. */
const layoutCellCount = { "2x1": 2, "1x2": 2, "2x2": 4 };

// ── DOM-Referenzen ────────────────────────────────────────────
const termArea  = document.getElementById("terminal-area");
const splitBtn  = document.getElementById("split-btn");
const splitMenu = document.getElementById("split-menu");
const welcomeEl = document.getElementById("welcome");

// ── Split-Menü ────────────────────────────────────────────────

/**
 * Split-Button: bei offenem Grid zum Grid wechseln,
 * sonst Menü anzeigen.
 */
splitBtn.addEventListener("click", e => {
    e.stopPropagation();
    if (gridTabEl) {
        activateGrid();
        return;
    }
    const rect = splitBtn.getBoundingClientRect();
    splitMenu.style.top  = (rect.bottom + 4) + "px";
    splitMenu.style.left = rect.left + "px";
    splitMenu.classList.toggle("open");
});
document.addEventListener("click", () => splitMenu.classList.remove("open"));

splitMenu.querySelectorAll(".split-menu-item").forEach(btn => {
    btn.addEventListener("click", () => {
        splitMenu.classList.remove("open");
        if (btn.dataset.layout === "1x1") closeGrid();
        else openGrid(btn.dataset.layout);
    });
});

// ── Grid öffnen ───────────────────────────────────────────────

/**
 * Öffnet ein neues Grid mit dem angegebenen Layout.
 * Ein bereits offenes Grid wird vorher sauber geschlossen.
 * Legt den Grid-Tab in der Tab-Leiste an und aktiviert ihn.
 * @param {string} layout - "2x1" | "1x2" | "2x2"
 */
function openGrid(layout) {
    if (gridTabEl) {
        gridCells.forEach((gc, i) => closeGridCell(i, true));
        gridCells = [];
        if (gridTabEl) { gridTabEl.remove(); gridTabEl = null; }
    }

    gridLayout = layout;
    const count = layoutCellCount[layout];
    gridCells = Array.from({ length: count }, () => ({
        preset: null, term: null, fitAddon: null, pane: null,
        ws: null, session_id: null, state: "empty"
    }));

    if (!gridTabEl) {
        gridTabEl = document.createElement("div");
        gridTabEl.className = "tab";
        gridTabEl.id = "grid-tab";
        gridTabEl.innerHTML = `
            <div class="tab-dot"></div>
            <span>⊞ Grid</span>
            <div class="tab-close" title="Grid schließen">✕</div>`;
        gridTabEl.addEventListener("click", e => {
            if (e.target.classList.contains("tab-close")) {
                showConfirm("Grid schließen", "Alle Grid-Sessions schließen?")
                    .then(ok => { if (ok) closeGrid(); });
            }
            else activateGrid();
        });
        document.getElementById("tab-bar").appendChild(gridTabEl);
    }

    splitBtn.classList.add("active");
    splitMenu.innerHTML = '<div class="split-menu-info">⊞ Grid bereits geöffnet</div>';
    activateGrid();
}

/**
 * Aktiviert den Grid-Tab und rendert die Grid-Ansicht.
 * Deaktiviert alle anderen Views (Sessions, SFTP) via deactivateAll().
 */
function activateGrid() {
    deactivateAll();
    gridActive = true;
    gridTabEl.classList.add("active");
    renderGridView();
}

// ── Grid-Ansicht rendern ──────────────────────────────────────

/**
 * Rendert die Grid-Ansicht im terminal-area.
 * Setzt das CSS-Layout (split-2x1 etc.), entfernt alte Zellen
 * und erstellt neue Grid-Cell-Divs mit Terminal oder Leerzelle.
 * Registriert Event-Listener für Schließen- und Verbinden-Buttons.
 */
function renderGridView() {
    const count = layoutCellCount[gridLayout];
    termArea.className = `split-${gridLayout}`;

    sessions.forEach(s => s.pane.classList.remove("active"));
    termArea.querySelectorAll(".grid-cell").forEach(el => el.remove());
    if (termArea.contains(welcomeEl)) welcomeEl.style.display = "none";

    for (let i = 0; i < count; i++) {
        const cell = document.createElement("div");
        cell.className = "grid-cell";
        cell.dataset.cell = i;

        const gc = gridCells[i];
        if (gc && gc.term) {
            const hdr = document.createElement("div");
            hdr.className = "grid-cell-header";
            hdr.innerHTML = `
                <span class="grid-cell-title">${escHtml(gc.preset?.title || "")}</span>
                <div class="grid-cell-actions">
                    <span class="grid-cell-state state-${gc.state}"></span>
                    <button class="grid-cell-btn grid-close-btn" data-cell="${i}" title="Zelle schließen">✕</button>
                </div>`;
            cell.appendChild(hdr);
            gc.pane.style.cssText = "display:block;position:relative;inset:auto;flex:1;min-height:0;width:100%;padding:4px 4px 4px 6px;";
            cell.appendChild(gc.pane);
            cell.addEventListener("mousedown", () => focusGridCell(i));
        } else {
            const empty = document.createElement("div");
            empty.className = "grid-cell-empty";
            empty.innerHTML = `<button class="grid-pick-session-btn" data-cell="${i}">＋ Server verbinden</button>`;
            cell.appendChild(empty);
        }
        termArea.appendChild(cell);
    }

    termArea.querySelectorAll(".grid-close-btn").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            closeGridCell(parseInt(btn.dataset.cell));
        });
    });
    termArea.querySelectorAll(".grid-pick-session-btn").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            pendingCell = parseInt(btn.dataset.cell);
            openLauncher();
        });
    });

    requestAnimationFrame(() => requestAnimationFrame(() => {
        gridCells.forEach(gc => {
            if (gc && gc.fitAddon) try { gc.fitAddon.fit(); } catch(e) {}
        });
    }));
}

// ── Session in Grid-Zelle starten ────────────────────────────

/**
 * Startet eine neue SSH-Session in einer Grid-Zelle.
 * Erstellt ein neues xterm-Terminal, baut die Grid-Zelle auf
 * und öffnet die WebSocket-Verbindung.
 * Font-Hierarchie: Preset-Grid-Font > Globaler Grid-Font > Terminal-Font
 * @param {number} cellIdx - Index der Zielzelle
 * @param {Object} preset - Server-Preset
 * @param {string|null} existingSessionId - Session-ID beim Reconnect
 */
async function startGridSession(cellIdx, preset, existingSessionId = null) {
    const gc = gridCells[cellIdx];
    if (!gc) return;

    if (gc.ws)   { try { gc.ws.close();    } catch(e) {} }
    if (gc.term) { try { gc.term.dispose(); } catch(e) {} }

    const pane = document.createElement("div");
    const cfg         = window.terminalConfig || {};
    const gridFontCfg = (cfg.grid_fonts || {})[gridLayout] || {};
    const gridFontKey = `grid_font_${gridLayout}`;
    const presetFont  = preset?.[gridFontKey] || preset?.font || {};
    const termFamily  = presetFont.family || gridFontCfg.family || cfg.font_family || "DejaVuSansMono";
    const termSize    = presetFont.size   || gridFontCfg.size   || cfg.font_size   || 14;

    const term = new Terminal({
        fontFamily: `'${termFamily}', 'Courier New', monospace`,
        fontSize: termSize, lineHeight: 1.0, cursorBlink: true, cursorStyle: "block",
        theme: {
            background:"#0d1117", foreground:"#c9d1d9", cursor:"#388bfd", cursorAccent:"#0d1117",
            black:"#484f58", red:"#ff7b72", green:"#3fb950", yellow:"#d29922",
            blue:"#388bfd", magenta:"#bc8cff", cyan:"#39c5cf", white:"#b1bac4",
            brightBlack:"#6e7681", brightRed:"#ffa198", brightGreen:"#56d364",
            brightYellow:"#e3b341", brightBlue:"#79c0ff", brightMagenta:"#d2a8ff",
            brightCyan:"#56d4dd", brightWhite:"#f0f6fc",
        },
        scrollback: 5000, allowProposedApi: true,
    });
    const fitAddon = new FitAddon.FitAddon();
    const webLinks = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);
    term.open(pane);

    gridCells[cellIdx] = { preset, term, fitAddon, pane, ws: null, session_id: null, state: "connecting" };
    renderGridView();

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch(e) {}
        resolve();
    })));

    connectGridWebSocket(cellIdx, preset, existingSessionId);
}

// ── WebSocket für Grid-Zelle ──────────────────────────────────

/**
 * Baut die WebSocket-Verbindung für eine Grid-Zelle auf.
 * Analog zu connectWebSocket() für normale Sessions.
 * Bei session_created wird saveGridState() aufgerufen um den State
 * sofort serverseitig zu speichern.
 * @param {number} cellIdx - Index der Grid-Zelle
 * @param {Object} preset - Server-Preset
 * @param {string|null} existingSessionId - Session-ID beim Reconnect
 */
function connectGridWebSocket(cellIdx, preset, existingSessionId = null) {
    const gc = gridCells[cellIdx];
    if (!gc || !gc.term) return;

    gc._wsTerminated     = false;
    gc._reconnectAttempt = 0;
    gc._reconnectTimer   = null;

    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";

    function buildUrl(sessionId) {
        return sessionId
            ? `${wsProto}//${location.host}/ws?session_id=${sessionId}&client_id=${CLIENT_ID}`
            : `${wsProto}//${location.host}/ws?preset=${preset.index}&client_id=${CLIENT_ID}`;
    }

    function connect(sessionId) {
        const currentGc = gridCells[cellIdx];
        if (!currentGc || !currentGc.term) return;

        const ws = new WebSocket(buildUrl(sessionId));
        currentGc.ws = ws;

        ws.onopen = () => {
            currentGc._reconnectAttempt = 0;
            try { currentGc.fitAddon.fit(); } catch(e) {}
            ws.send(JSON.stringify({ type: "resize", cols: currentGc.term.cols, rows: currentGc.term.rows }));
        };

        ws.onmessage = event => {
            const msg = JSON.parse(event.data);
            const g   = gridCells[cellIdx];
            if (!g) return;
            if (msg.type === "session_created") {
                g.session_id = msg.session_id;
                g.state = "connected";
                updateGridCellHeader(cellIdx);
                saveGridState();
            } else if (msg.type === "attached") {
                g.state = "connected";
                updateGridCellHeader(cellIdx);
                saveGridState();
            } else if (msg.type === "data") {
                g.term.write(msg.data);
            } else if (msg.type === "session_ended") {
                g._wsTerminated = true;
                g.state = "error";
                g.term.writeln("\r\n\x1b[33m[Session beendet]\x1b[0m");
                updateGridCellHeader(cellIdx);
            } else if (msg.type === "error") {
                g._wsTerminated = true;
                g.state = "error";
                g.term.writeln(`\r\n\x1b[31m[Fehler] ${msg.data}\x1b[0m`);
                updateGridCellHeader(cellIdx);
            } else if (msg.type === "session_taken_over") {
                g._wsTerminated = true;
                g.state = "error";
                updateGridCellHeader(cellIdx);
                showTakeoverBanner();
            }
        };

        ws.onerror = () => {
            const g = gridCells[cellIdx];
            if (g) { g.state = "error"; updateGridCellHeader(cellIdx); }
        };

        ws.onclose = () => {
            const g = gridCells[cellIdx];
            if (!g || g._wsTerminated) return;

            const delay = WS_RECONNECT_DELAYS[Math.min(g._reconnectAttempt, WS_RECONNECT_DELAYS.length - 1)];
            if (g.state === "connected") {
                g.term.writeln(`\r\n\x1b[33m[Verbindung getrennt — Reconnect in ${delay/1000}s...]\x1b[0m`);
            }
            g.state = "reconnecting";
            updateGridCellHeader(cellIdx);

            g._reconnectAttempt++;
            g._reconnectTimer = setTimeout(() => {
                const gc2 = gridCells[cellIdx];
                if (!gc2 || gc2._wsTerminated) return;
                gc2.term.writeln(`\x1b[33m[Reconnect-Versuch ${gc2._reconnectAttempt}...]\x1b[0m`);
                connect(gc2.session_id);
            }, delay);
        };

        currentGc.term.onData(data => {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: "data", data }));
        });
        currentGc.term.onResize(({ cols, rows }) => {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: "resize", cols, rows }));
        });
    }

    connect(existingSessionId);
}

/**
 * Aktualisiert den Status-Indikator im Header einer Grid-Zelle.
 * @param {number} cellIdx - Index der Grid-Zelle
 */
function updateGridCellHeader(cellIdx) {
    const gc  = gridCells[cellIdx];
    if (!gc) return;
    const hdr = termArea.querySelector(`.grid-cell[data-cell="${cellIdx}"] .grid-cell-state`);
    if (hdr) hdr.className = `grid-cell-state state-${gc.state}`;
}

// ── Grid-Zelle schließen ──────────────────────────────────────

/**
 * Schließt eine einzelne Grid-Zelle.
 * Sendet "close_session" an den Server, schließt WebSocket und
 * disposed das Terminal. Die Zelle wird auf "empty" zurückgesetzt.
 * @param {number} cellIdx - Index der zu schließenden Zelle
 * @param {boolean} skipRender - Wenn true, wird renderGridView() nicht aufgerufen
 */
function closeGridCell(cellIdx, skipRender = false) {
    const gc = gridCells[cellIdx];
    if (!gc || gc.state === "empty") return;

    // Reconnect-Timer abbrechen und Session als terminiert markieren
    gc._wsTerminated = true;
    if (gc._reconnectTimer) { clearTimeout(gc._reconnectTimer); gc._reconnectTimer = null; }

    if (gc.ws && gc.ws.readyState === WebSocket.OPEN) {
        try { gc.ws.send(JSON.stringify({ type: "close_session" })); } catch(e) {}
        const wsRef = gc.ws;
        setTimeout(() => { try { wsRef.close(); } catch(e) {} }, 100);
        gc.ws = null;
    } else if (gc.ws) {
        try { gc.ws.close(); } catch(e) {}
        gc.ws = null;
    }
    if (gc.term) { try { gc.term.dispose(); } catch(e) {} }
    gridCells[cellIdx] = { preset: null, term: null, fitAddon: null, pane: null, ws: null, session_id: null, state: "empty" };
    if (!skipRender) renderGridView();
}

// ── Grid komplett schließen ───────────────────────────────────

/**
 * Schließt das gesamte Grid inklusive aller Sessions.
 * Stellt die normalen Tab-Ansicht wieder her und reaktiviert
 * das Split-Menü. Bereinigt localStorage und Server-State.
 */
function closeGrid() {
    gridCells.forEach((gc, i) => closeGridCell(i, true));
    gridCells  = [];
    gridActive = false;
    gridLayout = "1x1";

    if (gridTabEl) { gridTabEl.remove(); gridTabEl = null; }
    splitBtn.classList.remove("active");

    // State lokal und serverseitig löschen
    localStorage.removeItem("webssh_grid");
    fetch("/grid-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, state: null }),
    }).catch(() => {});

    // Split-Menü wiederherstellen
    splitBtn.title = "Split-View";
    splitMenu.innerHTML = `
        <button class="split-menu-item" data-layout="2x1" title="Vertikal teilen">⬜⬜ Vertikal</button>
        <button class="split-menu-item" data-layout="1x2" title="Horizontal teilen">Horizontal</button>
        <button class="split-menu-item" data-layout="2x2" title="4 Panels">⊞ 2×2</button>`;
    splitMenu.querySelectorAll(".split-menu-item").forEach(btn => {
        btn.addEventListener("click", () => {
            openGrid(btn.dataset.layout);
            splitMenu.classList.remove("open");
        });
    });

    termArea.className = "";
    termArea.querySelectorAll(".grid-cell").forEach(el => el.remove());
    if (!termArea.contains(welcomeEl)) termArea.prepend(welcomeEl);

    if (sessions.length > 0) activateSession(sessions[sessions.length - 1].id);
    else { welcomeEl.style.display = "flex"; }
}

/**
 * Fokussiert eine Grid-Zelle visuell und setzt den Terminal-Fokus.
 * @param {number} idx - Index der zu fokussierenden Zelle
 */
function focusGridCell(idx) {
    termArea.querySelectorAll(".grid-cell").forEach((c, i) =>
        c.classList.toggle("focused", i === idx));
    const gc = gridCells[idx];
    if (gc && gc.term) gc.term.focus();
}

// ── Grid-State Persistenz ─────────────────────────────────────

/**
 * Speichert den aktuellen Grid-State im localStorage und auf dem Server.
 * Wird aufgerufen bei:
 *   - session_created / attached (sofortige Speicherung)
 *   - beforeunload (beim Verlassen der Seite)
 * Der Server-State ermöglicht die Wiederherstellung bei Browser-Übernahme
 * auch wenn der neue Browser keinen localStorage-Eintrag hat.
 */
function saveGridState() {
    if (!gridTabEl) { localStorage.removeItem("webssh_grid"); return; }
    const state = {
        layout: gridLayout,
        active: gridActive,
        cells:  gridCells.map(gc => gc && gc.session_id ? {
            session_id: gc.session_id,
            preset: gc.preset ? {
                title:    gc.preset.title    || "",
                host:     gc.preset.host     || "",
                port:     gc.preset.port     || 22,
                username: gc.preset.username || "",
                index:    gc.preset.index,
            } : null
        } : null)
    };
    localStorage.setItem("webssh_grid", JSON.stringify(state));
    // Auch serverseitig speichern für Browser-Übernahme
    fetch("/grid-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, state }),
        keepalive: true,
    }).catch(() => {});
}

// ── Grid-State wiederherstellen ──────────────────────────────

/**
 * Stellt den Grid-State nach Browser-Reload oder Übernahme wieder her.
 * Fragt zuerst den Server (funktioniert bei Übernahme ohne localStorage),
 * dann als Fallback localStorage.
 * Prüft für jede gespeicherte Zelle ob die Session noch auf dem Server lebt.
 * Nur wenn mindestens eine Session noch aktiv ist wird das Grid geöffnet.
 */
async function restoreGridState() {
    let state = null;
    try {
        const resp = await fetch(`/grid-state?client_id=${CLIENT_ID}`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.state?.layout) state = data.state;
        }
    } catch(e) {}

    if (!state) {
        const raw = localStorage.getItem("webssh_grid");
        if (!raw) return;
        try { state = JSON.parse(raw); } catch(e) { return; }
    }
    if (!state?.layout || !state?.cells) return;

    // Prüfen ob Sessions noch aktiv sind
    const validCells = [];
    for (let i = 0; i < state.cells.length; i++) {
        const saved = state.cells[i];
        if (!saved?.session_id) { validCells.push(null); continue; }
        try {
            const resp = await fetch(`/sessions?client_id=${CLIENT_ID}`);
            const serverSessions = await resp.json();
            const exists = serverSessions.some(s => s.session_id === saved.session_id);
            validCells.push(exists ? saved : null);
        } catch(e) { validCells.push(null); }
    }

    if (!validCells.some(c => c !== null)) {
        localStorage.removeItem("webssh_grid");
        return;
    }

    openGrid(state.layout);

    for (let i = 0; i < validCells.length; i++) {
        const saved = validCells[i];
        if (!saved?.session_id || !saved.preset) continue;
        await startGridSessionReconnect(i, saved.session_id, saved.preset);
    }
}

/**
 * Reconnectet eine Grid-Session nach Browser-Reload oder Übernahme.
 * Analog zu startGridSession() aber mit existierender session_id.
 * @param {number} cellIdx - Index der Grid-Zelle
 * @param {string} sessionId - Server-Session-ID
 * @param {Object} preset - Gespeichertes Preset
 */
async function startGridSessionReconnect(cellIdx, sessionId, preset) {
    const gc = gridCells[cellIdx];
    if (gc && gc.ws)   { try { gc.ws.close();    } catch(e) {} }
    if (gc && gc.term) { try { gc.term.dispose(); } catch(e) {} }

    const pane = document.createElement("div");
    const cfg         = window.terminalConfig || {};
    const gridFontCfg = (cfg.grid_fonts || {})[gridLayout] || {};
    const presetFont  = preset ? (preset.grid_font || preset.font || {}) : {};
    const termFamily  = presetFont.family || gridFontCfg.family || cfg.font_family || "DejaVuSansMono";
    const termSize    = presetFont.size   || gridFontCfg.size   || cfg.font_size   || 14;

    const term = new Terminal({
        fontFamily: `'${termFamily}', 'Courier New', monospace`,
        fontSize: termSize, lineHeight: 1.0, cursorBlink: true, cursorStyle: "block",
        theme: {
            background:"#0d1117", foreground:"#c9d1d9", cursor:"#388bfd", cursorAccent:"#0d1117",
            black:"#484f58", red:"#ff7b72", green:"#3fb950", yellow:"#d29922",
            blue:"#388bfd", magenta:"#bc8cff", cyan:"#39c5cf", white:"#b1bac4",
            brightBlack:"#6e7681", brightRed:"#ffa198", brightGreen:"#56d364",
            brightYellow:"#e3b341", brightBlue:"#79c0ff", brightMagenta:"#d2a8ff",
            brightCyan:"#56d4dd", brightWhite:"#f0f6fc",
        },
        scrollback: 5000, allowProposedApi: true,
    });
    const fitAddon = new FitAddon.FitAddon();
    const webLinks = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);
    term.open(pane);

    gridCells[cellIdx] = { preset, term, fitAddon, pane, ws: null, session_id: sessionId, state: "reconnecting" };
    renderGridView();

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch(e) {}
        r();
    })));

    // Reconnect über connectGridWebSocket um Auto-Reconnect zu nutzen
    connectGridWebSocket(cellIdx, preset, sessionId);
}

// ── ResizeObserver für Grid-Zellen ───────────────────────────

/**
 * Passt alle Grid-Terminals automatisch an wenn der terminal-area
 * seine Größe ändert (z.B. Fenstergrößenänderung).
 */
const _gridResizeObserver = new ResizeObserver(() => {
    if (!gridActive) return;
    gridCells.forEach(gc => {
        if (gc && gc.fitAddon) try { gc.fitAddon.fit(); } catch(e) {}
    });
});
_gridResizeObserver.observe(termArea);

// ── Tab Rechtsklick-Kontextmenü ───────────────────────────────

const tabContextMenu = document.getElementById("tab-context-menu");
let contextMenuTabId = null;

document.getElementById("tab-bar").addEventListener("contextmenu", e => {
    const tab = e.target.closest(".tab:not(#grid-tab)");
    if (!tab) return;
    e.preventDefault();
    contextMenuTabId = tab.dataset.id;
    tabContextMenu.style.top  = e.clientY + "px";
    tabContextMenu.style.left = e.clientX + "px";
    tabContextMenu.classList.add("open");
});
document.addEventListener("click", () => tabContextMenu.classList.remove("open"));

document.getElementById("ctx-close").addEventListener("click", () => {
    const id = parseInt(contextMenuTabId);
    tabContextMenu.classList.remove("open");
    if (contextMenuTabId) confirmCloseSession(id);
});