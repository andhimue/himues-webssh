/**
 * config.js — Globale Konstanten und Initialisierung
 *
 * Enthält:
 *   - VERSION:    Aktuelle Versionsnummer der Anwendung
 *   - CLIENT_ID:  Eindeutige Browser-Instanz-ID (persistent im localStorage)
 *   - Hilfsfunktionen für UUID-Generierung
 *
 * Diese Datei wird als erstes geladen — alle anderen JS-Dateien
 * können auf VERSION und CLIENT_ID zugreifen.
 */

"use strict";

// ── Versionsnummer ────────────────────────────────────────────
/** Aktuelle Anwendungsversion. Wird im Header neben "webssh" angezeigt. */
const VERSION = "1.3";

// ── UUID-Generierung ──────────────────────────────────────────

/**
 * Erzeugt eine neue UUID v4.
 * Nutzt crypto.randomUUID() wenn verfügbar (moderne Browser),
 * sonst einen Math.random()-basierten Fallback.
 * @returns {string} UUID im Format xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
function generateUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/**
 * Liefert die persistente Client-ID dieser Browser-Instanz.
 * Die ID wird beim ersten Aufruf generiert und im localStorage gespeichert.
 * Sie identifiziert den Browser gegenüber dem Server und ermöglicht
 * Session-Persistenz über Neuladen hinaus sowie die Unterscheidung
 * zwischen verschiedenen Browser-Instanzen im single_user-Modus.
 * @returns {string} UUID dieser Browser-Instanz
 */
function getClientId() {
    let id = localStorage.getItem("webssh_client_id");
    if (!id) {
        id = generateUUID();
        localStorage.setItem("webssh_client_id", id);
    }
    return id;
}

/** Eindeutige ID dieser Browser-Instanz — wird einmalig beim Laden gesetzt. */
const CLIENT_ID = getClientId();

// Versionsnummer im Header anzeigen
document.addEventListener("DOMContentLoaded", () => {
    const badge = document.getElementById("version-badge");
    if (badge) badge.textContent = VERSION;
});