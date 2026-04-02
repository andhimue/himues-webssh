/**
 * keyboard.js — Keyboard-Toolbar und Tastatur-Intercept
 *
 * Verantwortlich für:
 *   - Keyboard-Toolbar (Ctrl+A bis Ctrl+Z, F1-F12 Buttons)
 *   - Tastatur-Intercept: Browser-Shortcuts wie Ctrl+W, Ctrl+T
 *     werden an das aktive Terminal weitergeleitet statt den Browser zu steuern
 *   - F-Key ESC-Sequenzen für xterm-256color
 *   - Font-Größen aus der Konfiguration auf CSS-Variablen anwenden
 *
 * Abhängigkeiten: config.js, sessions.js
 */

// ── F-Key ESC-Sequenzen ───────────────────────────────────────

/**
 * Mapping von F-Tasten-Namen zu xterm-256color ESC-Sequenzen.
 * Wird verwendet wenn F-Tasten über die Toolbar-Buttons gesendet werden.
 */
const FKEY_SEQUENCES = {
    F1:  "\x1bOP",  F2:  "\x1bOQ",  F3:  "\x1bOR",  F4:  "\x1bOS",
    F5:  "\x1b[15~", F6: "\x1b[17~", F7:  "\x1b[18~", F8:  "\x1b[19~",
    F9:  "\x1b[20~", F10:"\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
};

// ── Keyboard-Toolbar ──────────────────────────────────────────

/** Toggle-Button für die Keyboard-Toolbar. */
const kbToggleBtn = document.getElementById("kb-toggle-btn");
/** Die Toolbar selbst. */
const kbToolbar   = document.getElementById("kb-toolbar");

/**
 * Sendet eine Datensequenz an die aktuell aktive Terminal-Session.
 * Unterstützt sowohl normale Sessions als auch Grid-Zellen.
 * Wenn keine Session aktiv ist, passiert nichts.
 * @param {string} data - Zu sendende Zeichenkette (ggf. ESC-Sequenz)
 */
function sendToActiveSession(data) {
    if (activeId) {
        const s = getSession(activeId);
        if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
            s.ws.send(JSON.stringify({ type: "data", data }));
            return;
        }
    }
    // Grid-Zelle fokussiert
    if (gridActive) {
        const focused = document.querySelector(".grid-cell:focus-within");
        if (focused) {
            const cellIdx = parseInt(focused.dataset.cell);
            const gc = gridCells[cellIdx];
            if (gc && gc.ws && gc.ws.readyState === WebSocket.OPEN) {
                gc.ws.send(JSON.stringify({ type: "data", data }));
            }
        }
    }
}

// Ctrl-Buttons (A-Z) registrieren
document.querySelectorAll(".kb-btn[data-ctrl]").forEach(btn => {
    btn.addEventListener("click", () => {
        // Großbuchstaben: A=65, B=66 ... → Ctrl+A=1, Ctrl+B=2 ...
        const char = btn.dataset.ctrl.toUpperCase();
        sendToActiveSession(String.fromCharCode(char.charCodeAt(0) - 64));
    });
});

// F-Key-Buttons registrieren
document.querySelectorAll(".kb-btn[data-fkey]").forEach(btn => {
    btn.addEventListener("click", () => {
        const seq = FKEY_SEQUENCES[btn.dataset.fkey];
        if (seq) sendToActiveSession(seq);
    });
});

// Toggle-Button
kbToggleBtn.addEventListener("click", () => {
    const open = kbToolbar.classList.toggle("open");
    kbToggleBtn.classList.toggle("active", open);
    if (open) checkFkeyWrap();
});

/**
 * Prüft ob die F-Keys in der Toolbar umbrechen müssen.
 * Wenn die Toolbar zu schmal für Ctrl+F-Keys in einer Zeile ist,
 * wird die F-Key-Gruppe in eine eigene Zeile umgebrochen.
 */
function checkFkeyWrap() {
    const toolbar = document.getElementById("kb-toolbar");
    const fkeys   = document.getElementById("kb-fkeys");
    if (!fkeys) return;
    fkeys.classList.remove("wrap-row");
    requestAnimationFrame(() => {
        if (toolbar.scrollHeight > toolbar.clientHeight + 4) {
            fkeys.classList.add("wrap-row");
        }
    });
}

window.addEventListener("resize", () => {
    if (kbToolbar.classList.contains("open")) checkFkeyWrap();
});

// ── CSS-Variablen für Schriftgrößen ──────────────────────────

/**
 * Überträgt die Font-Größen aus der Terminal-Konfiguration auf
 * CSS-Variablen. Dadurch skalieren UI-Elemente (Toolbar-Buttons,
 * SFTP-Dateiliste, Header-Buttons) mit den Einstellungen.
 * @param {Object} cfg - Terminal-Config-Objekt von /config/terminal
 */
function applyFontSizes(cfg) {
    const root = document.documentElement;
    if (cfg.kb_font_size)     root.style.setProperty("--kb-font-size",     cfg.kb_font_size     + "px");
    if (cfg.ui_font_size)     root.style.setProperty("--ui-font-size",     cfg.ui_font_size     + "px");
    if (cfg.sftp_font_size)    root.style.setProperty("--sftp-font-size",    cfg.sftp_font_size    + "px");
    if (cfg.header_btn_size)   root.style.setProperty("--header-btn-size",   cfg.header_btn_size   + "px");
    if (cfg.preview_font_size !== undefined)  root.style.setProperty("--preview-font-size",  cfg.preview_font_size  + "px");
    if (cfg.settings_font_size !== undefined) root.style.setProperty("--settings-font-size", cfg.settings_font_size + "px");
    if (cfg.log_font_size !== undefined)      root.style.setProperty("--log-font-size",      cfg.log_font_size      + "px");
    if (cfg.log_font_family !== undefined) {
        if (cfg.log_font_family) root.style.setProperty("--log-font-family", cfg.log_font_family);
        else root.style.removeProperty("--log-font-family");
    }
    // Leerer String = "wie Terminal" → Variable auf Terminal-Font zurücksetzen
    if (cfg.preview_font_family !== undefined) {
        if (cfg.preview_font_family) {
            // Font-Name mit einfachen Anführungszeichen damit mehrteilige Namen (z.B. 'Courier New') korrekt interpretiert werden
            const familyVal = cfg.preview_font_family.includes("'") ? cfg.preview_font_family : `'${cfg.preview_font_family}'`;
            root.style.setProperty("--preview-font-family", familyVal);
        } else {
            root.style.removeProperty("--preview-font-family");
        }
    }
    // SFTP-Spaltenbreiten neu berechnen wenn sich die Schriftgröße ändert
    if (typeof _applyColumnVisibility === "function") _applyColumnVisibility();
}

// ── Tastatur-Intercept ────────────────────────────────────────

/**
 * Tastenkombinationen die vom Browser abgefangen und an das Terminal
 * weitergeleitet werden statt den Browser zu steuern.
 * Enthält die häufigsten Shortcuts die in Terminals verwendet werden.
 */
const INTERCEPT_KEYS = new Set([
    "KeyW","KeyT","KeyN","KeyR","KeyL","KeyF","KeyG","KeyH",
    "KeyJ","KeyK","KeyU","KeyI","KeyO","KeyP","KeyA","KeyS",
    "KeyD","KeyE","KeyQ",
    "Digit1","Digit2","Digit3","Digit4","Digit5","Digit6","Digit7","Digit8","Digit9",
]);

/**
 * Global-Keydown-Handler für Terminal-Shortcuts.
 * Wenn eine aktive Terminal-Session fokussiert ist und Ctrl+[Buchstabe]
 * gedrückt wird, wird die Taste an das Terminal weitergeleitet statt
 * den Browser zu steuern (Ctrl+W schließt sonst den Tab, etc.).
 */
document.addEventListener("keydown", e => {
    // Nur wenn Ctrl ohne Meta/Alt gedrückt
    if (!e.ctrlKey || e.metaKey || e.altKey) return;



    // Alle anderen Keys nur wenn Terminal fokussiert ist
    if (!activeId) return;
    const s = getSession(activeId);
    if (!s || !s.pane.classList.contains("active")) return;
    if (!s.pane.contains(document.activeElement) &&
        document.activeElement !== document.body) return;

    if (INTERCEPT_KEYS.has(e.code)) {
        e.preventDefault();
        const char = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
        sendToActiveSession(char);
    }
});