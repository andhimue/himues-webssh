/**
 * launcher.js — Server-Launcher und Preset-Verwaltung
 *
 * Verantwortlich für:
 *   - Launcher-Overlay (Tastatur-Shortcut Leertaste / +-Button)
 *   - Server-Suche und -Filterung
 *   - Anzeige und Verwaltung aktiver Sessions im Launcher
 *   - Laden und Rendern der Server-Presets nach Kategorien
 *   - Background-Polling (Preset-Änderungen, Session-Cache)
 *
 * Abhängigkeiten: config.js
 * Wird verwendet von: sessions.js, grid.js, sftp.js
 */

// ── DOM-Referenzen ────────────────────────────────────────────
const overlay      = document.getElementById("launcher-overlay");
const launcherBtn  = document.getElementById("launcher-btn");
const searchInput  = document.getElementById("launcher-search");
const launcherBody = document.getElementById("launcher-body");
const emptyMsg     = document.getElementById("launcher-empty");
const activeSec    = document.getElementById("active-sessions-section");
const activeList   = document.getElementById("active-sessions-list");

// ── Daten-Cache ───────────────────────────────────────────────

/**
 * Gecachte Preset-Daten. Wird beim ersten Laden befüllt und
 * bei Änderungen (Hash-Vergleich) automatisch aktualisiert.
 * @type {Array|null}
 */
let _presetsCache    = null;

/**
 * MD5-Hash der zuletzt geladenen Presets.
 * Dient als Versionskennung für effizientes Change-Detection.
 * @type {string}
 */
let _presetsHash     = "";

/**
 * Gecachte Liste aktiver Server-Sessions.
 * Wird vom Server abgefragt und für den Launcher-Dialog genutzt.
 * @type {Array}
 */
let _sessionsCache   = [];

/**
 * Lädt den aktuellen Preset-Hash vom Server und vergleicht ihn
 * mit dem gespeicherten Hash. Bei Abweichung werden die Presets
 * neu geladen. Wird im Background-Polling-Intervall aufgerufen.
 */
async function refreshPresetsIfChanged() {
    try {
        const resp = await fetch("/presets/hash");
        const { hash } = await resp.json();
        if (hash !== _presetsHash) {
            _presetsHash = hash;
            await loadPresets();
        }
    } catch(e) {}
}

/**
 * Aktualisiert den Session-Cache durch einen Server-Request.
 * Im single_user-Modus werden alle aktiven Sessions zurückgegeben,
 * im multi_user-Modus nur die Sessions dieser client_id.
 */
async function refreshSessionsCache() {
    try {
        const resp = await fetch(`/sessions?client_id=${CLIENT_ID}`);
        _sessionsCache = await resp.json();
    } catch(e) {}
}

/**
 * Startet das Background-Polling.
 * - Alle 10s: Preset-Hash prüfen (Änderungserkennung)
 * - Alle 10s: Session-Cache aktualisieren (für Launcher-Anzeige)
 */
function startBackgroundPolling() {
    setInterval(refreshPresetsIfChanged, 10000);
    setInterval(refreshSessionsCache,    10000);
}

// ── Launcher öffnen / schließen ───────────────────────────────

/**
 * Öffnet den Server-Launcher.
 * Zeigt sofort den gecachten Stand, lädt dann im Hintergrund
 * aktuelle Daten nach. Fokussiert automatisch das Suchfeld.
 */
async function openLauncher() {
    overlay.classList.add("open");
    launcherBtn.classList.add("active");
    searchInput.value = "";
    // Gecachten Stand sofort rendern (closeSession bereinigt den Cache bereits)
    renderActiveSessions(_sessionsCache);
    filterServers("");
    requestAnimationFrame(() => searchInput.focus());
    // Cache im Hintergrund aktualisieren
    loadActiveSessions();
}

/**
 * Schließt den Server-Launcher.
 * Fokussiert die aktuell aktive Terminal-Session zurück.
 */
function closeLauncher() {
    overlay.classList.remove("open");
    launcherBtn.classList.remove("active");
    if (activeId) { const s = getSession(activeId); if (s) s.term.focus(); }
}

/**
 * Wechselt den Launcher-Status (öffnen/schließen).
 */
function toggleLauncher() {
    overlay.classList.contains("open") ? closeLauncher() : openLauncher();
}

// Schließen bei Klick auf Hintergrund
overlay.addEventListener("click", e => { if (e.target === overlay) closeLauncher(); });
launcherBtn.addEventListener("click", toggleLauncher);

// Tastatursteuerung
document.addEventListener("keydown", e => {
    // Leertaste öffnet Launcher wenn kein Input fokussiert ist
    if (e.code === "Space" && document.activeElement === document.body && !sftpOpen) {
        e.preventDefault();
        openLauncher();
        return;
    }
    if (e.key === "Escape" && overlay.classList.contains("open")) closeLauncher();
});

// Suchfeld-Events
searchInput.addEventListener("input", () => filterServers(searchInput.value));
searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
        const first = launcherBody.querySelector(".server-card:not(.hidden)");
        if (first) first.click();
    }
});

/**
 * Filtert die Server-Karten im Launcher anhand eines Suchbegriffs.
 * Sucht in Name, Adresse und Kategorie. Kategorie-Sektionen ohne
 * Treffer werden ausgeblendet. Bei aktivem Suchbegriff werden alle
 * Kategorien aufgeklappt.
 * @param {string} query - Suchbegriff (leer = alle anzeigen)
 */
function filterServers(query) {
    const q = query.trim().toLowerCase();
    let anyVisible = false;
    launcherBody.querySelectorAll(".server-card").forEach(card => {
        const match = !q || ["name","addr","cat"].some(k => (card.dataset[k]||"").toLowerCase().includes(q));
        card.classList.toggle("hidden", !match);
        if (match) anyVisible = true;
    });
    launcherBody.querySelectorAll(".category-section").forEach(sec => {
        const visible = sec.querySelectorAll(".server-card:not(.hidden)").length > 0;
        sec.style.display = visible ? "" : "none";
        if (q) sec.classList.remove("collapsed");
    });
    emptyMsg.style.display = anyVisible ? "none" : "block";
}

// ── Aktive Sessions im Launcher ───────────────────────────────

/**
 * Lädt die aktuellen aktiven Sessions vom Server und rendert sie.
 * Wird beim Öffnen des Launchers und im Background-Polling aufgerufen.
 */
async function loadActiveSessions() {
    await refreshSessionsCache();
    renderActiveSessions(_sessionsCache);
}

/**
 * Rendert die aktiven Sessions im oberen Bereich des Launchers.
 * Zeigt für jede Session: Status-Punkt (grün=aktiv, gelb=verwaist),
 * Servername, Adresse und einen Schließen-Button.
 * Grid-Sessions werden nicht angezeigt (sie erscheinen im Grid-Tab).
 * @param {Array} sessions - Liste von Session-Objekten vom Server
 */
function renderActiveSessions(sessions) {
    const cfg = window.terminalConfig || {};
    if (!cfg.persist_sessions || cfg.show_active_sessions === false) {
        activeSec.style.display = "none";
        return;
    }

    activeList.innerHTML = "";

    if (sessions.length === 0) {
        activeSec.style.display = "none";
        return;
    }

    activeSec.style.display = "block";

    // Grid-Session-IDs sammeln — diese nicht im Launcher anzeigen
    const gridSessionIds = new Set(
        gridCells.filter(gc => gc && gc.session_id).map(gc => gc.session_id)
    );

    let shown = 0;
    sessions.forEach(s => {
        // Grid-Sessions ausblenden
        if (gridSessionIds.has(s.session_id)) return;

        // Schon als Tab offen?
        const alreadyOpen = window.sessions && window.sessions.find(t => t.session_id === s.session_id);

        const item = document.createElement("div");
        item.className = "active-session-item";
        item.innerHTML = `
            <div class="asi-dot ${s.ws_connected ? "" : "orphan"}"></div>
            <div class="asi-info">
                <div class="asi-title">${escHtml(s.title)}</div>
                <div class="asi-meta">${escHtml(s.host)}:${s.port} ${alreadyOpen ? t("launcher.already_open") : t("launcher.click_connect")}</div>
            </div>
            <div class="asi-close" title="Session beenden">✕</div>`;

        // Reconnect oder aktivieren
        item.addEventListener("click", e => {
            if (e.target.classList.contains("asi-close")) return;
            closeLauncher();
            if (alreadyOpen) activateSession(alreadyOpen.id);
            else reconnectSession(s);
        });

        // Session serverseitig beenden
        item.querySelector(".asi-close").addEventListener("click", async e => {
            e.stopPropagation();
            await fetch(`/sessions/${s.session_id}`, { method: "DELETE" });
            _sessionsCache = _sessionsCache.filter(x => x.session_id !== s.session_id);
            item.remove();
            if (activeList.children.length === 0) activeSec.style.display = "none";
        });

        activeList.appendChild(item);
        shown++;
    });

    if (shown === 0) activeSec.style.display = "none";
}

// ── Presets laden ─────────────────────────────────────────────

/**
 * Lädt die Server-Presets vom Server und rendert die Launcher-Karten.
 * Presets werden nach Kategorie gruppiert. "Allgemein" erscheint immer
 * zuletzt, alle anderen Kategorien alphabetisch sortiert.
 * Server-Karten registrieren Click-Handler die direkt openSession() aufrufen.
 */
async function loadPresets() {
    try {
        const resp    = await fetch("/presets");
        const presets = await resp.json();
        _presetsCache = presets;

        // Nach Kategorie gruppieren
        const groups = {};
        presets.forEach(p => {
            const cat = p.category || "Allgemein";
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(p);
        });

        // Bestehende Karten entfernen
        launcherBody.querySelectorAll(".category-section").forEach(el => el.remove());

        // Kategorien sortieren: Allgemein immer zuletzt
        const sortedCats = Object.keys(groups).sort((a, b) => {
            if (a === "Allgemein") return 1;
            if (b === "Allgemein") return -1;
            return a.localeCompare(b);
        });

        sortedCats.forEach(cat => {
            const section = document.createElement("div");
            section.className = "category-section";

            const header = document.createElement("div");
            header.className = "category-header";
            header.innerHTML = `<span class="category-chevron">▼</span><span>${escHtml(cat)}</span>`;
            header.addEventListener("click", () => section.classList.toggle("collapsed"));

            const items = document.createElement("div");
            items.className = "category-items";

            groups[cat].forEach(p => {
                const card = document.createElement("div");
                card.className = "server-card";
                card.dataset.name = p.title;
                card.dataset.addr = `${p.host}:${p.port}`;
                card.dataset.cat  = cat;
                card.innerHTML = `
                    <div class="sc-icon">⬡</div>
                    <div class="sc-info">
                        <div class="sc-name">${escHtml(p.title)}</div>
                        <div class="sc-addr">${escHtml(p.host)}:${p.port}</div>
                    </div>`;
                card.addEventListener("click", () => { closeLauncher(); openSession(p); });
                items.appendChild(card);
            });

            section.appendChild(header);
            section.appendChild(items);
            launcherBody.insertBefore(section, emptyMsg);
        });
    } catch(e) {
        console.error("Preset-Ladefehler:", e);
    }
}