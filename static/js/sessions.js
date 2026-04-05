/**
 * sessions.js — SSH-Session-Verwaltung
 *
 * Verantwortlich für:
 *   - Aufbau neuer SSH-Sessions (openSession, buildSession)
 *   - WebSocket-Verbindung zum Server (connectWebSocket)
 *   - Session-Reconnect nach Browser-Reload oder Übernahme
 *   - Persistenz im localStorage (saveSessionState, restoreSessions)
 *   - View-Switching (activateSession, deactivateAll)
 *   - Auto-Close nach Verbindungstrennung
 *   - Hilfsfunktionen (escHtml, fitAddon_fit)
 *
 * WebSocket-Protokoll (JSON):
 *   Client → Server:
 *     { type: "resize", cols, rows }     Terminal-Größe geändert
 *     { type: "data", data }             Tastatureingabe
 *     { type: "close_session" }          Tab explizit geschlossen
 *
 *   Server → Client:
 *     { type: "session_created", session_id, title }  Neue Session angelegt
 *     { type: "attached" }                            Reconnect erfolgreich
 *     { type: "data", data }                          Terminal-Output
 *     { type: "session_ended" }                       SSH-Prozess beendet
 *     { type: "session_taken_over" }                  Anderer Browser übernimmt
 *     { type: "error", data }                         Verbindungsfehler
 *
 * Session-Lebenszyklus:
 *   Neu:       openSession(preset) → buildSession() → connectWebSocket()
 *   Reconnect: reconnectSession(s) → buildSession() → connectWebSocket()
 *   Schließen: closeSession(id) → "close_session" an Server → localStorage bereinigen
 *
 * Abhängigkeiten: config.js, launcher.js
 * Wird verwendet von: grid.js, sftp.js, settings.js, main.js
 */

// ── Globale Session-Variablen ─────────────────────────────────

/** Alle aktuell offenen Sessions. @type {Array} */
let sessions = [];
/** ID der aktuell angezeigten Session. @type {number|null} */
let activeId = null;
/** Zähler für Session-IDs (lokal, client-seitig). @type {number} */
let sessionCounter = 0;

// ── Terminal-Config ───────────────────────────────────────────

/**
 * Lädt die Terminal-Konfiguration vom Server und speichert sie in
 * window.terminalConfig. Enthält Font-Einstellungen, Session-Optionen
 * und UI-Größen. Wird vor dem Öffnen des Launchers aufgerufen um
 * sicherzustellen dass neue Sessions die aktuellen Einstellungen nutzen.
 */
async function refreshTerminalConfig() {
    try {
        const resp = await fetch("/config/terminal");
        window.terminalConfig = await resp.json();
    } catch(e) {}
}

// ── Session öffnen ────────────────────────────────────────────

/**
 * Öffnet eine neue SSH-Session für ein Preset.
 * Im Grid-Modus wird die Session in die wartende Grid-Zelle geleitet
 * (pendingCell !== null) statt einen normalen Tab zu öffnen.
 * @param {Object} preset - Server-Preset-Objekt aus der Preset-Liste
 */
async function openSession(preset) {
    // Wenn eine Grid-Zelle auf eine Verbindung wartet, dort starten
    if (pendingCell !== null && gridActive && gridTabEl) {
        const cell  = pendingCell;
        pendingCell = null;
        await startGridSession(cell, preset);
        return;
    }
    // pendingCell zurücksetzen falls Grid nicht mehr aktiv
    pendingCell = null;
    const id = ++sessionCounter;
    return await buildSession(id, preset.title, null, preset);
}

/**
 * Reconnectet eine bestehende Server-Session in einem neuen Tab.
 * Wird beim Browser-Reload und bei der Browser-Übernahme aufgerufen.
 * @param {Object} serverSession - Session-Objekt vom Server ({ session_id, title, host, port })
 */
async function reconnectSession(serverSession) {
    const id = ++sessionCounter;
    // username aus dem Server-Session-Objekt als Mini-Preset mitgeben damit der Tab-Titel stimmt
    const pseudoPreset = serverSession.username
        ? { username: serverSession.username }
        : null;
    const s  = await buildSession(id, serverSession.title, serverSession.session_id, pseudoPreset);
    setSessionState(id, "reconnecting");
    return s;
}

// ── Session aufbauen ──────────────────────────────────────────

/**
 * Erstellt eine neue Session (Tab + Terminal + WebSocket).
 * Gemeinsamer Code für openSession() und reconnectSession().
 * Der Ablauf:
 *   1. Tab in der Tab-Leiste anlegen
 *   2. Terminal-Pane im terminal-area anlegen
 *   3. xterm.js-Terminal initialisieren mit konfigurierten Fonts/Größen
 *   4. Session in das sessions-Array eintragen
 *   5. Tab aktivieren und Layout berechnen (fitAddon)
 *   6. WebSocket-Verbindung aufbauen
 *
 * @param {number} id - Lokale Session-ID (inkrementeller Zähler)
 * @param {string} title - Anzeigename im Tab
 * @param {string|null} existingSessionId - Server-Session-ID beim Reconnect, sonst null
 * @param {Object|null} preset - Preset-Objekt für neue Verbindungen
 * @returns {Object} Session-Objekt
 */
async function buildSession(id, title, existingSessionId, preset) {
    // Tab in der Tab-Leiste anlegen
    const tab = document.createElement("div");
    tab.className = "tab loading";
    tab.dataset.id = id;
    // Tab-Titel: "<user>@<title>" wenn username bekannt, sonst nur title
    const username = (preset && preset.username) ? preset.username : "";
    const tabLabel = username
        ? `${escHtml(username)}@${escHtml(title)}`
        : escHtml(title);
    tab.innerHTML = `
        <div class="tab-dot"></div>
        <span>${tabLabel}</span>
        <div class="tab-close" title="Schließen">✕</div>`;
    tab.addEventListener("click", e => {
        if (e.target.classList.contains("tab-close")) confirmCloseSession(id);
        else activateSession(id);
    });
    document.getElementById("tab-bar").appendChild(tab);

    // Terminal-Pane anlegen
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    document.getElementById("terminal-area").appendChild(pane);

    // xterm.js-Terminal mit aktuellen Font-Einstellungen initialisieren
    const cfg  = window.terminalConfig || {};

    // Font-Hierarchie: Preset-Font > Globaler Font > Fallback
    const presetFont = preset && preset.font ? preset.font : {};
    const termFamily = presetFont.family || cfg.font_family || "DejaVuSansMono";
    const termSize   = presetFont.size   || cfg.font_size   || 14;

    const term = new Terminal({
        fontFamily:   `'${termFamily}', 'Courier New', monospace`,
        fontSize:      termSize,
        lineHeight:    1.0,
        letterSpacing: 0,
        cursorBlink:   true,
        cursorStyle:   "block",
        theme: {
            background:    "#0d1117", foreground:    "#c9d1d9",
            cursor:        "#388bfd", cursorAccent:  "#0d1117",
            black:         "#484f58", red:           "#ff7b72",
            green:         "#3fb950", yellow:        "#d29922",
            blue:          "#388bfd", magenta:       "#bc8cff",
            cyan:          "#39c5cf", white:         "#b1bac4",
            brightBlack:   "#6e7681", brightRed:     "#ffa198",
            brightGreen:   "#56d364", brightYellow:  "#e3b341",
            brightBlue:    "#79c0ff", brightMagenta: "#d2a8ff",
            brightCyan:    "#56d4dd", brightWhite:   "#f0f6fc",
        },
        scrollback: 5000,
        allowProposedApi: true,
    });

    const fitAddon      = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(pane);

    const session = {
        id, title, preset, tab, pane, term, fitAddon,
        ws:                  null,
        state:               "connecting",
        session_id:          existingSessionId,   // Server-seitige UUID
        close_on_disconnect: cfg.close_on_disconnect ?? false,
        close_delay:         cfg.close_delay ?? 3,
        taken_over:          false,
    };
    sessions.push(session);
    // Globales sessions-Array für loadActiveSessions zugänglich machen
    window.sessions = sessions;

    activateSession(id);

    // Warten bis Browser Layout berechnet hat, dann Terminal-Größe setzen
    await new Promise(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(() => { fitAddon_fit(session); resolve(); })
    ));

    connectWebSocket(session, existingSessionId, preset);
    return session;
}

// ── WebSocket-Verbindung ──────────────────────────────────────

/**
 * Baut die WebSocket-Verbindung zum Server auf.
 * Bei neuen Sessions: URL enthält preset-Index → Server startet SSH-Prozess
 * Bei Reconnects:    URL enthält session_id  → Server hängt Terminal an bestehenden Prozess
 *
 * Message-Typen vom Server:
 *   session_created:   Neue Session wurde angelegt, session_id wird gespeichert
 *   attached:          Reconnect erfolgreich, Scrollback-Buffer wird gesendet
 *   data:              Terminal-Output (UTF-8 String)
 *   session_ended:     SSH-Prozess hat sich beendet (z.B. durch exit)
 *   session_taken_over: Diese Session wurde von einem anderen Browser übernommen
 *   error:             Verbindungsfehler
 *
 * @param {Object} session - Session-Objekt
 * @param {string|null} existingSessionId - Server-Session-ID beim Reconnect
 * @param {Object|null} preset - Preset für neue Verbindungen
 */
// Auto-Reconnect Konfiguration
const WS_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]; // ms zwischen Versuchen

/**
 * Öffnet eine WebSocket-Verbindung für eine SSH-Session.
 * Verarbeitet eingehende Nachrichten (output, resize, error, close, takeover).
 * @param {Object} session - Session-Objekt
 * @param {string|null} existingSessionId - ID einer wiederzuverbindenden Session
 * @param {Object|null} preset - Preset-Objekt mit Verbindungsdaten
 */
function connectWebSocket(session, existingSessionId, preset) {
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";

    function buildUrl(sessionId) {
        if (sessionId) {
            return `${wsProto}//${location.host}/ws?session_id=${sessionId}&client_id=${CLIENT_ID}`;
        } else {
            return `${wsProto}//${location.host}/ws?preset=${preset.index}&client_id=${CLIENT_ID}`;
        }
    }

    // Reconnect-Zustand
    session._reconnectAttempt = 0;
    session._reconnectTimer   = null;
    session._wsTerminated     = false;  // true = kein Reconnect mehr (session_ended, close, takeover)

    function connect(sessionId) {
        const ws = new WebSocket(buildUrl(sessionId));
        session.ws = ws;

        ws.onopen = () => {
            session._reconnectAttempt = 0;
            fitAddon_fit(session);
            ws.send(JSON.stringify({ type: "resize", cols: session.term.cols, rows: session.term.rows }));
        };

        ws.onmessage = event => {
            const msg = JSON.parse(event.data);

            if (msg.type === "session_created") {
                session.session_id = msg.session_id;
                saveSessionState();
                setSessionState(session.id, "connected");
            }
            else if (msg.type === "attached") {
                setSessionState(session.id, "connected");
                saveSessionState();
            }
            else if (msg.type === "data") {
                session.term.write(msg.data);
            }
            else if (msg.type === "session_ended") {
                session._wsTerminated = true;
                setSessionState(session.id, "error");
                session.term.writeln("\r\n\x1b[33m[Session beendet]\x1b[0m");
                removeSessionState(session.session_id);
                autoClose(session);
            }
            else if (msg.type === "session_taken_over") {
                session._wsTerminated = true;
                setSessionState(session.id, "error");
                session.term.writeln("\r\n\x1b[33m[Session von anderem Browser übernommen]\x1b[0m");
                session.taken_over = true;
            }
            else if (msg.type === "error") {
                session._wsTerminated = true;
                setSessionState(session.id, "error");
                session.term.writeln(`\r\n\x1b[31m[Fehler] ${msg.data}\x1b[0m`);
                autoClose(session);
            }
        };

        ws.onerror = () => {
            // onerror wird immer von onclose gefolgt — dort den Reconnect starten
            setSessionState(session.id, "error");
        };

        ws.onclose = () => {
            const s = getSession(session.id);
            if (!s) return;

            if (s.taken_over) {
                showTakeoverBanner();
                return;
            }

            // Kein Reconnect wenn Session absichtlich beendet wurde
            if (s._wsTerminated) return;

            // Netzwerkunterbrechung — Auto-Reconnect versuchen
            const attempt = s._reconnectAttempt;
            const delay   = WS_RECONNECT_DELAYS[Math.min(attempt, WS_RECONNECT_DELAYS.length - 1)];

            if (s.state === "connected") {
                s.term.writeln(`\r\n\x1b[33m[Verbindung getrennt — Reconnect in ${delay/1000}s...]\x1b[0m`);
            }
            setSessionState(session.id, "reconnecting");

            s._reconnectAttempt++;
            s._reconnectTimer = setTimeout(() => {
                if (!getSession(s.id)) return;  // Session inzwischen geschlossen
                s.term.writeln(`\x1b[33m[Reconnect-Versuch ${s._reconnectAttempt}...]\x1b[0m`);
                connect(s.session_id);
            }, delay);
        };

        // Tastatureingaben an Server senden
        session.term.onData(data => {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: "data", data }));
        });

        // Terminal-Größenänderungen an Server melden (PTY-Resize)
        session.term.onResize(({ cols, rows }) => {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: "resize", cols, rows }));
        });
    }

    connect(existingSessionId);
}

/**
 * Ruft fit() auf dem FitAddon auf um das Terminal an den verfügbaren
 * Platz anzupassen. Fehler werden ignoriert (Terminal möglicherweise
 * noch nicht im DOM).
 * @param {Object} session - Session-Objekt mit fitAddon-Property
 */
function fitAddon_fit(session) {
    try { session.fitAddon.fit(); } catch(e) {}
}

/**
 * Schließt den Tab automatisch nach einer Verbindungstrennung,
 * wenn close_on_disconnect in der Konfiguration aktiviert ist.
 * Bei close_delay > 0 wird eine Wartezeit angezeigt.
 * @param {Object} session - Session-Objekt
 */
function autoClose(session) {
    if (session.close_on_disconnect) {
        const delay = session.close_delay * 1000;
        if (delay > 0)
            session.term.writeln(`\x1b[2m[Tab wird in ${session.close_delay}s geschlossen]\x1b[0m`);
        setTimeout(() => closeSession(session.id), delay);
    }
}

// ── localStorage-Persistenz ───────────────────────────────────

/**
 * Speichert die aktuell offenen Sessions im localStorage.
 * Nur Sessions mit server_id werden gespeichert (verwaiste/verbindende
 * Sessions haben noch keine ID).
 * Format: [{ session_id: "uuid", title: "Servername" }, ...]
 */
function saveSessionState() {
    const state = sessions
        .filter(s => s.session_id)
        .map(s => ({ session_id: s.session_id, title: s.title }));
    localStorage.setItem("webssh_sessions", JSON.stringify(state));
}

/**
 * Entfernt eine Session aus dem localStorage.
 * Wird aufgerufen wenn eine Session serverseitig beendet wurde.
 * @param {string} session_id - Server-seitige Session-UUID
 */
function removeSessionState(session_id) {
    const saved = getSavedSessions().filter(s => s.session_id !== session_id);
    localStorage.setItem("webssh_sessions", JSON.stringify(saved));
}

/**
 * Liest die gespeicherten Sessions aus dem localStorage.
 * @returns {Array} Array von { session_id, title } Objekten
 */
function getSavedSessions() {
    try { return JSON.parse(localStorage.getItem("webssh_sessions") || "[]"); }
    catch(e) { return []; }
}

// ── Session-Wiederherstellung ─────────────────────────────────

/**
 * Stellt Sessions nach einem Browser-Reload oder einer Browser-Übernahme wieder her.
 * Ablauf:
 *   1. Grid-Session-IDs vom Server und localStorage holen (diese werden übersprungen)
 *   2. Alle lebenden Sessions vom Server abfragen
 *   3. Für jede noch lebende Session reconnectSession() aufrufen
 *   4. localStorage mit aktuellen IDs synchronisieren
 *
 * Im single_user-Modus werden alle Server-Sessions wiederhergestellt
 * (auch von anderen Browsern), im multi_user-Modus nur eigene.
 */
async function restoreSessions() {
    const cfg = window.terminalConfig || {};
    if (!cfg.persist_sessions) return;

    // Grid-Session-IDs ermitteln (Server + localStorage) damit sie nicht als Tabs geöffnet werden
    const gridSessionIds = new Set();
    // 1. Vom Server holen (funktioniert auch bei Browser-Übernahme ohne localStorage)
    try {
        const gridResp = await fetch(`/grid-state?client_id=${CLIENT_ID}`);
        if (gridResp.ok) {
            const gridData = await gridResp.json();
            (gridData.state?.cells || []).forEach(c => { if (c?.session_id) gridSessionIds.add(c.session_id); });
        }
    } catch(e) {}
    // 2. Zusätzlich aus localStorage (Fallback)
    try {
        const gridRaw = localStorage.getItem("webssh_grid");
        if (gridRaw) {
            const gridState = JSON.parse(gridRaw);
            (gridState.cells || []).forEach(c => { if (c?.session_id) gridSessionIds.add(c.session_id); });
        }
    } catch(e) {}

    // Alle lebenden Sessions vom Server holen
    let liveSessions = [];
    try {
        const resp  = await fetch(`/sessions?client_id=${CLIENT_ID}`);
        liveSessions = await resp.json();
    } catch(e) { return; }

    if (liveSessions.length === 0) {
        localStorage.removeItem("webssh_sessions");
        return;
    }

    // Sessions wiederherstellen (Grid-Sessions überspringen)
    for (const s of liveSessions) {
        if (gridSessionIds.has(s.session_id)) continue;
        reconnectSession(s);
        // Kurze Pause zwischen Verbindungsaufbauten
        await new Promise(r => setTimeout(r, 150));
    }

    // localStorage mit aktuellen Session-IDs synchronisieren
    localStorage.setItem("webssh_sessions", JSON.stringify(
        liveSessions
            .filter(s => !gridSessionIds.has(s.session_id))
            .map(s => ({ session_id: s.session_id, title: s.title }))
    ));
}

// ── View-Switching ────────────────────────────────────────────

/**
 * Deaktiviert alle Views (Sessions, Grid, SFTP) vollständig.
 * Wird als gemeinsame Basis von activateSession(), activateGrid()
 * und activateSftp() aufgerufen um Überlagerungen zu vermeiden.
 *
 * Aufräumen:
 *   - Alle Flags (gridActive, sftpOpen, activeId) zurücksetzen
 *   - Alle Tab-Highlights entfernen
 *   - Alle Panes ausblenden
 *   - Grid-Zellen aus dem DOM entfernen
 *   - termArea.className zurücksetzen (entfernt Split-Layout)
 *   - Session-Panes wieder in termArea hängen (falls rausgeflogen)
 */
function deactivateAll() {
    gridActive = false;
    sftpOpen   = false;
    // Log-Tab deaktivieren falls aktiv (log.js setzt _logActive)
    if (typeof _logActive !== "undefined" && _logActive) deactivateLog();
    activeId   = null;

    // Alle Tab-Highlights entfernen
    sessions.forEach(s => s.tab.classList.remove("active"));
    if (gridTabEl) gridTabEl.classList.remove("active");
    if (sftpTabEl) sftpTabEl.classList.remove("active");

    // Alle Panes ausblenden
    sessions.forEach(s => s.pane.classList.remove("active"));
    sftpPane.classList.remove("active");

    // Grid-Layout zurücksetzen: Klasse entfernen, Zellen aus DOM entfernen
    termArea.className = "";
    termArea.querySelectorAll(".grid-cell").forEach(el => el.remove());

    // Session-Panes wieder in termArea hängen falls sie rausgefallen sind
    if (!termArea.contains(welcomeEl)) termArea.prepend(welcomeEl);
    sessions.forEach(s => { if (!termArea.contains(s.pane)) termArea.appendChild(s.pane); });

    welcomeEl.style.display = "none";
}

/**
 * Aktiviert eine normale SSH-Session und zeigt ihren Tab+Pane an.
 * Alle anderen Views (Grid, SFTP) werden deaktiviert.
 * @param {number} id - Lokale Session-ID
 */
function activateSession(id) {
    deactivateAll();
    activeId = id;

    sessions.forEach(s => {
        s.tab.classList.toggle("active", s.id === id);
        s.pane.classList.toggle("active", s.id === id);
    });
    const s = getSession(id);
    if (s) requestAnimationFrame(() => { fitAddon_fit(s); s.term.focus(); });
}

/**
 * Schließt eine Session und entfernt Tab + Terminal aus dem DOM.
 * Sendet "close_session" an den Server um die SSH-Verbindung serverseitig
 * zu beenden. Bereinigt localStorage und Session-Cache.
 * Nach dem Schließen wird automatisch zur letzten verfügbaren Session
 * oder dem Grid gewechselt.
 * @param {number} id - Lokale Session-ID
 */
/**
 * Fragt per Dialog nach Bestätigung bevor eine Session geschlossen wird.
 * @param {number} id - Lokale Session-ID
 */
async function confirmCloseSession(id) {
    const s = getSession(id);
    if (!s) return;
    const ok = await showConfirm("Tab schließen", `"${s.title}" wirklich schließen?`);
    if (ok) closeSession(id);
}

/**
 * Beendet eine Session: stoppt Reconnect-Timer, schließt WebSocket,
 * entfernt Tab und Pane aus dem DOM.
 * @param {number} id - Session-ID
 */
function closeSession(id) {
    const s = getSession(id);
    if (!s) return;

    // Reconnect-Timer abbrechen und Session als terminiert markieren
    s._wsTerminated = true;
    if (s._reconnectTimer) { clearTimeout(s._reconnectTimer); s._reconnectTimer = null; }

    // Server-Session explizit beenden
    if (s.ws && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ type: "close_session" }));
        s.ws.close();
    }
    removeSessionState(s.session_id);

    // Cache sofort bereinigen damit geschlossene Session nicht mehr im Launcher erscheint
    if (s.session_id) {
        _sessionsCache = _sessionsCache.filter(x => x.session_id !== s.session_id);
    }
    refreshSessionsCache();

    s.term.dispose();
    s.tab.remove();
    s.pane.remove();
    sessions = sessions.filter(x => x.id !== id);
    window.sessions = sessions;

    if (activeId === id) {
        if (sessions.length > 0) activateSession(sessions[sessions.length - 1].id);
        else if (gridActive) activateGrid();
        else {
            activeId = null;
            welcomeEl.style.display = "flex";
        }
    }
}

/**
 * Setzt den visuellen Zustand eines Tabs (Farbe des Status-Punktes).
 * @param {number} id - Lokale Session-ID
 * @param {string} state - "connected" | "error" | "loading" | "reconnecting"
 */
function setSessionState(id, state) {
    const s = getSession(id);
    if (!s) return;
    s.state = state;
    s.tab.className = `tab ${state} ${activeId === id ? "active" : ""}`;
}

/**
 * Sucht eine Session anhand ihrer lokalen ID.
 * @param {number} id - Lokale Session-ID
 * @returns {Object|null} Session-Objekt oder null
 */
function getSession(id) { return sessions.find(s => s.id === id) || null; }

// ── ResizeObserver ────────────────────────────────────────────

/**
 * Beobachtet Größenänderungen des Terminal-Bereichs.
 * Ruft fit() auf dem aktiven Terminal auf wenn sich die Fenstergröße ändert
 * um das Terminal korrekt zu skalieren.
 */
new ResizeObserver(() => {
    if (activeId) {
        const s = getSession(activeId);
        if (s) fitAddon_fit(s);
    }
}).observe(document.getElementById("terminal-area"));

// ── Hilfsfunktionen ───────────────────────────────────────────

/**
 * Escapet HTML-Sonderzeichen für sichere DOM-Ausgabe.
 * Verhindert XSS bei der Ausgabe von Serverinhalten.
 * @param {string} str - Eingabe-String
 * @returns {string} HTML-escaped String
 */
function escHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}