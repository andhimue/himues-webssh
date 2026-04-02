/**
 * ui.js — UI-Hilfskomponenten und State-Persistenz
 *
 * Verantwortlich für:
 *   - Takeover-Banner: wird angezeigt wenn eine andere Browser-Instanz
 *     die Sessions übernommen hat (single_user-Modus)
 *   - beforeunload: Grid-State und SFTP-State beim Verlassen speichern
 *
 * Abhängigkeiten: config.js, sessions.js, grid.js, sftp.js
 */

// ── Takeover-Banner ───────────────────────────────────────────

/**
 * Zeigt das Takeover-Banner an.
 * Wird aufgerufen wenn eine andere Browser-Instanz die WebSocket-Verbindungen
 * übernommen hat (session_taken_over-Message + ws.onclose).
 * Markiert alle lokalen Tabs als Fehler und blendet ein Vollbild-Banner ein
 * das den Benutzer auffordert die Seite neu zu laden.
 */
function showTakeoverBanner() {
    sessions.forEach(s => setSessionState(s.id, "error"));
    document.getElementById("takeover-banner").classList.add("show");
}

// ── State beim Verlassen speichern ────────────────────────────

/**
 * Speichert Grid-State und SFTP-State beim Verlassen der Seite.
 * Ermöglicht die Wiederherstellung nach Browser-Reload.
 * saveGridState() wird auch für die Browser-Übernahme serverseitig gespeichert.
 * SFTP-State wird nur im localStorage gespeichert (der Server hat /sftp/sessions).
 */
window.addEventListener("beforeunload", () => {
    saveGridState();

    // SFTP-State speichern (side-Zuordnung und offener Pfad)
    const state = {};
    ["left","right"].forEach(side => {
        const panel = panels[side];
        if (panel.sftp_id) {
            state[side] = {
                sftp_id: panel.sftp_id,
                path:    panel.path,
                title:   panel.preset?.title || "",
            };
        }
    });
    if (Object.keys(state).length > 0) {
        state._open = sftpOpen;
        localStorage.setItem("webssh_sftp", JSON.stringify(state));
    } else {
        localStorage.removeItem("webssh_sftp");
    }
});
