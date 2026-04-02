/**
 * main.js — Anwendungs-Einstiegspunkt
 *
 * Führt die Initialisierung der Anwendung durch:
 *   1. Terminal-Konfiguration laden (Font, Größen)
 *   2. @font-face CSS einfügen und Font laden
 *   3. CSS-Variablen für Schriftgrößen setzen
 *   4. Presets und Session-Cache laden, Background-Polling starten
 *   5. Bestehende Sessions wiederherstellen (in Reihenfolge):
 *      a. Normale SSH-Sessions (restoreSessions)
 *      b. Grid-Sessions (restoreGridState)
 *      c. SFTP-Verbindungen (restoreSftpState)
 *   6. Auth-UI aktualisieren (Logout-Button, Passwort-Tab)
 *
 * Ladereihenfolge der JS-Dateien (alle mit defer):
 *   1. config.js     — VERSION, CLIENT_ID
 *   2. launcher.js   — Launcher, Presets, Sessions-Cache
 *   3. sessions.js   — SSH-Sessions, WebSocket, Persistenz
 *   4. keyboard.js   — Keyboard-Toolbar, Key-Intercept
 *   5. grid.js       — Split-View Grid
 *   6. sftp.js       — SFTP-Dateimanager
 *   7. settings.js   — Einstellungen-Modal
 *   8. ui.js         — Takeover-Banner, beforeunload
 *   9. main.js       — Init (diese Datei)
 *
 * Abhängigkeiten: alle anderen JS-Dateien
 */

/**
 * Initialisiert die Anwendung.
 * Wird automatisch aufgerufen wenn alle Skripte geladen sind.
 */
async function init() {
    try {
        // Terminal-Konfiguration laden (Font, Größen, Session-Optionen)
        const resp = await fetch("/config/terminal");
        const cfg  = await resp.json();

        // @font-face CSS für Terminal-Font und optional Preview-Font einfügen
        const style = document.createElement("style");
        style.id = "font-face-style";
        let fontFaceRules = `
            @font-face { font-family:'${cfg.font_family}'; src:url('${cfg.font_file}') format('${cfg.font_format || "truetype"}'); font-weight:normal; }
            @font-face { font-family:'${cfg.font_family}'; src:url('${cfg.font_file_bold}') format('${cfg.font_format || "truetype"}'); font-weight:bold; }
        `;
        // Preview-Font — separater @font-face wenn abweichend vom Terminal-Font
        if (cfg.preview_font_family && cfg.preview_font_family !== cfg.font_family) {
            // Font-Datei via /fonts Endpunkt ermitteln
            try {
                const fontsResp = await fetch("/fonts");
                const fontsList = await fontsResp.json();
                const pf = fontsList.find(f => f.name === cfg.preview_font_family);
                if (pf) {
                    fontFaceRules += `
            @font-face { font-family:'${pf.name}'; src:url('${pf.file}') format('${pf.format || "truetype"}'); font-weight:normal; }`;
                    if (pf.file_bold) fontFaceRules += `
            @font-face { font-family:'${pf.name}'; src:url('${pf.file_bold}') format('${pf.format || "truetype"}'); font-weight:bold; }`;
                }
            } catch(e) {}
        }
        style.textContent = fontFaceRules;
        document.head.appendChild(style);

        // Fonts laden — bei Fehler trotzdem fortfahren
        try { await document.fonts.load(`${cfg.font_size}px '${cfg.font_family}'`); } catch(e) {}
        if (cfg.preview_font_family) {
            try { await document.fonts.load(`${cfg.preview_font_size || 13}px '${cfg.preview_font_family}'`); } catch(e) {}
        }

        window.terminalConfig = cfg;
        applyFontSizes(cfg);
    } catch(e) {
        // Fallback-Konfiguration wenn Server nicht erreichbar
        window.terminalConfig = {
            font_size: 14, font_family: "DejaVuSansMono",
            close_on_disconnect: false, close_delay: 3,
            persist_sessions: true, session_mode: "single_user"
        };
        applyFontSizes(window.terminalConfig);
    }

    // Presets und Session-Cache laden, dann Polling starten
    await Promise.all([loadPresets(), refreshSessionsCache()]);
    startBackgroundPolling();

    // Sessions wiederherstellen (Reihenfolge wichtig für Tab-Reihenfolge)
    await restoreSessions();   // Normale Sessions zuerst — Tab-Reihenfolge bleibt
    await restoreGridState();  // Grid danach — Grid-IDs wurden vorher gefiltert
    await restoreSftpState();  // SFTP zuletzt

    // Auth-UI aktualisieren
    updateAuthUI();
}

// Sprach-Umschalter (im Einstellungs-Modal, Tab "Sprache")
// Wird beim Öffnen der Einstellungen initialisiert (settings.js)

// Sicherstellen dass alle defer-Skripte geladen sind bevor init() aufgerufen wird
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}