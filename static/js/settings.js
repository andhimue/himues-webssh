/**
 * settings.js — Einstellungen-Modal und Preset-Verwaltung
 *
 * Verantwortlich für:
 *   - Einstellungen-Modal (⚙-Button) mit 5 Tabs:
 *     Server, Fonts, Terminal, Sessions, Pfade (+ Passwort wenn Login aktiv)
 *   - Preset-Formular: Anlegen, Bearbeiten, Löschen, Sortieren (Drag & Drop)
 *   - Auto-Save: Alle Inputs mit data-path-Attribut speichern automatisch per PATCH /config
 *   - Font-Verwaltung: Fonts aus Verzeichnis laden, Dropdowns befüllen
 *   - Authentifizierung: Passwort ändern, Login-Status
 *   - Terminal-Config neu laden nach Font-Änderungen
 *
 * Abhängigkeiten: config.js, launcher.js (_presetsHash), sessions.js (escHtml),
 *                 keyboard.js (applyFontSizes)
 * Wird verwendet von: main.js
 */

// ── DOM-Referenzen ────────────────────────────────────────────
const settingsOverlay = document.getElementById("settings-overlay");
const settingsBtn     = document.getElementById("settings-btn");

/** Zuletzt geladene Konfiguration (vollständiges Config-Objekt). @type {Object|null} */
let settingsConfig = null;

// ── Öffnen / Schließen ────────────────────────────────────────

settingsBtn.addEventListener("click", () => openSettings());

/** Logout-Button: fragt nach Bestätigung, schickt POST /auth/logout. */
document.getElementById("logout-btn").addEventListener("click", () => {
    if (!confirm(t("settings.logout_confirm"))) return;
    // GET-Navigation damit der Server Cookie löscht und zur Login-Seite weiterleitet
    location.href = "/auth/logout";
});

/**
 * Aktualisiert die Auth-UI: Logout-Button und Passwort-Tab werden
 * nur angezeigt wenn Login in der Config aktiviert ist.
 */
async function updateAuthUI() {
    try {
        const resp = await fetch("/config/terminal");
        const cfg  = await resp.json();
        document.getElementById("logout-btn").style.display = cfg.auth_enabled ? "" : "none";
        const tab = document.getElementById("stab-password");
        if (tab) tab.style.display = cfg.auth_enabled ? "" : "none";
    } catch(e) {}
}

// Schließen-Button und Escape
document.getElementById("settings-close").addEventListener("click", closeSettings);
document.addEventListener("keydown", e => {
    if (e.key === "Escape" && settingsOverlay.classList.contains("open")) {
        const overlay = document.getElementById("preset-form-overlay");
        if (overlay && !overlay.classList.contains("hidden")) {
            // Formular offen:
            // - beim Bearbeiten: nur Formular schließen
            // - beim Neu anlegen: ESC ignorieren
            if (editingIndex !== null) {
                _hidePresetForm();
                editingIndex = null;
            }
            // editingIndex === null → Neu anlegen → nichts tun
        } else {
            closeSettings();
        }
    }
});

/**
 * Öffnet das Einstellungen-Modal und lädt die aktuelle Konfiguration.
 */
async function openSettings() {
    settingsOverlay.classList.add("open");
    settingsBtn.classList.add("active");
    // Sprach-Dropdown initialisieren
    const langSel = document.getElementById("lang-select");
    if (langSel && typeof getLang === "function") {
        langSel.value = getLang();
        langSel.onchange = () => setLang(langSel.value);
    }

    // Schriftgröße und Fensterbreite proportional anpassen
    if (window.terminalConfig) {
        applyFontSizes(window.terminalConfig);
        const fontSize    = window.terminalConfig.settings_font_size || 13;
        const baseSize    = 13;
        const baseWidth   = 700;
        const scaledWidth = Math.round(baseWidth * fontSize / baseSize);
        document.getElementById("settings-panel").style.width =
            `min(${scaledWidth}px, 96vw)`;
    }
    await loadSettingsConfig();
    if (typeof _applyTranslations === "function") _applyTranslations();
}

/**
 * Schließt das Einstellungen-Modal und blendet das Preset-Formular aus.
 */
function closeSettings() {
    settingsOverlay.classList.remove("open");
    settingsBtn.classList.remove("active");
    _hidePresetForm();
}

// Tab-Umschaltung innerhalb des Modals
document.querySelectorAll(".stab").forEach(tab => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".stab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".stab-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
        if (typeof _applyTranslations === "function") _applyTranslations();
    });
});

// ── Font- und Key-Listen ──────────────────────────────────────

/** Gecachte Font-Liste vom Server. @type {Array} */
let _fontsCache = [];
/** Gecachte SSH-Key-Liste vom Server. @type {Array} */
let _keysCache  = [];

/**
 * Lädt die verfügbaren Fonts aus dem konfigurierten Fonts-Verzeichnis
 * und befüllt alle Font-Dropdowns.
 */
async function loadFontsList() {
    try {
        const resp  = await fetch("/fonts");
        _fontsCache = await resp.json();

        // Alle verfuegbaren Fonts als @font-face registrieren
        let styleEl = document.getElementById("font-face-all");
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = "font-face-all";
            document.head.appendChild(styleEl);
        }
        const rules = _fontsCache.map(f => {
            let r = `@font-face { font-family:'${f.name}'; src:url('${f.file}') format('${f.format || "truetype"}'); font-weight:normal; }`;
            if (f.file_bold) r += " " + `@font-face { font-family:'${f.name}'; src:url('${f.file_bold}') format('${f.format || "truetype"}'); font-weight:bold; }`;
            return r;
        }).join(" ");
        styleEl.textContent = rules;

        // Fonts vorladen damit sie beim Rendern der Dropdowns verfuegbar sind
        await Promise.all(_fontsCache.map(f =>
            document.fonts.load(`13px '${f.name}'`).catch(() => {})
        ));

        populateFontDropdowns();
    } catch(e) {}
}
/**
 * Lädt die verfügbaren SSH-Keys aus dem konfigurierten Keys-Verzeichnis
 * und befüllt das Key-Dropdown im Preset-Formular.
 */
async function loadKeysList() {
    try {
        const resp = await fetch("/keys");
        _keysCache = await resp.json();
        populateKeyDropdown();
    } catch(e) {}
}

/**
 * Befüllt alle Font-Dropdowns in Settings und Preset-Formular.
 * Berücksichtigt den aktuell konfigurierten Font für die Vorauswahl.
 */
function populateFontDropdowns() {
    // IDs aller Font-Dropdowns mit Optionen initialisieren
    const IDS_STANDARD  = ["pf-font-family", "pf-grid-2x1-family", "pf-grid-1x2-family", "pf-grid-2x2-family"];
    const IDS_WIETERMINAL = ["s-grid-2x1-font", "s-grid-1x2-font", "s-grid-2x2-font", "s-preview-family", "s-log-family"];

    // Sicherstellen dass alle FontSelect-Instanzen existieren
    ["s-term-font", ...IDS_STANDARD, ...IDS_WIETERMINAL].forEach(id => _initFontSelect(id));

    const optsStandard    = _fontSelectOptions(_fontsCache, true, t("settings.standard"));
    const optsWieTerminal = _fontSelectOptions(_fontsCache, true, t("settings.like_terminal"));

    // Terminal-Font (kein leerer Eintrag — immer ein Font gewählt)
    const termOpts = _fontsCache.map(f => ({ value: f.name, label: f.name, font: f.name }));
    const fs = _getFontSelect("s-term-font");
    if (fs) {
        fs.setOptions(termOpts);
        const currentName = settingsConfig?.fonts?.terminal?.family || "";
        if (currentName) fs.value = currentName;
    }

    // Standard-Dropdowns (Preset-Formular)
    IDS_STANDARD.forEach(id => {
        const fsi = _getFontSelect(id);
        if (!fsi) return;
        const prev = fsi.value;
        fsi.setOptions(optsStandard);
        if (prev) fsi.value = prev;
    });

    // "wie Terminal"-Dropdowns (Settings Grid + Vorschau)
    IDS_WIETERMINAL.forEach(id => {
        const fsi = _getFontSelect(id);
        if (!fsi) return;
        let current = "";
        if (id === "s-preview-family")   current = settingsConfig?.fonts?.preview?.family || "";
        else if (id === "s-grid-2x1-font") current = settingsConfig?.fonts?.grid_2x1?.family || "";
        else if (id === "s-grid-1x2-font") current = settingsConfig?.fonts?.grid_1x2?.family || "";
        else if (id === "s-grid-2x2-font") current = settingsConfig?.fonts?.grid_2x2?.family || "";
        else if (id === "s-log-family")    current = settingsConfig?.fonts?.log?.family     || "";
        fsi.setOptions(optsWieTerminal);
        if (current) fsi.value = current;
    });
}

/**
 * Befüllt das SSH-Key-Dropdown im Preset-Formular.
 * Behält den aktuell gewählten Wert wenn möglich.
 */
function populateKeyDropdown() {
    const sel = document.getElementById("pf-private-key");
    const currentVal = sel.value;
    sel.innerHTML = `<option value="">– Key wählen –</option>` +
        _keysCache.map(k =>
            `<option value="${escHtml(k)}" ${k === currentVal ? "selected" : ""}>${escHtml(k)}</option>`
        ).join("");
    if (currentVal) sel.value = currentVal;
}

// Fonts-Reload-Button
document.getElementById("s-fonts-reload").addEventListener("click", async () => {
    await loadFontsList();
    populateFontDropdowns();
});

/**
 * Wenn der globale Terminal-Font geändert wird, wird er sofort in der
 * Konfiguration gespeichert (family, file, file_bold).
 */
document.getElementById("s-term-font").addEventListener("change", async function() {
    const font = _fontsCache.find(f => f.name === this.value);
    if (!font) return;
    await patchConfig(["fonts", "terminal", "family"],    font.name);
    await patchConfig(["fonts", "terminal", "file"],      font.file);
    await patchConfig(["fonts", "terminal", "file_bold"], font.file_bold || "");
    if (settingsConfig?.fonts?.terminal) {
        settingsConfig.fonts.terminal.family    = font.name;
        settingsConfig.fonts.terminal.file      = font.file;
        settingsConfig.fonts.terminal.file_bold = font.file_bold || "";
    }
});

// SSH-Key-Reload-Button
document.getElementById("s-keys-reload").addEventListener("click", async () => {
    await loadKeysList();
    populateKeyDropdown();
});

// ── Konfiguration laden und Felder befüllen ───────────────────

/**
 * Lädt die vollständige Konfiguration vom Server und befüllt alle
 * Einstellungsfelder. Lädt dabei auch Font- und Key-Listen.
 */
async function loadSettingsConfig() {
    try {
        const [cfgResp] = await Promise.all([
            fetch("/config"),
            loadFontsList(),
            loadKeysList(),
        ]);
        settingsConfig = await cfgResp.json();
        fillSettingsFields(settingsConfig);
        populateFontDropdowns();
        const llSel = document.getElementById("s-log-level");
        if (llSel) llSel.value = settingsConfig.log_level || "WARNING";
        renderPresetList(settingsConfig.presets || []);
        fillCategoryList(settingsConfig.presets || []);
    } catch(e) {
        console.error("Einstellungen laden fehlgeschlagen:", e);
    }
}

/**
 * Befüllt alle Eingabefelder mit data-path-Attribut automatisch
 * aus dem Konfigurationsobjekt. Unterstützt verschachtelte Pfade
 * (z.B. "auth.session_timeout" → cfg.auth.session_timeout).
 * @param {Object} cfg - Konfigurationsobjekt
 */
function fillSettingsFields(cfg) {
    document.querySelectorAll("[data-path]").forEach(input => {
        const val = getNestedValue(cfg, input.dataset.path.split("."));
        if (val === undefined || val === null) return;
        if (input.type === "checkbox")   input.checked = !!val;
        else if (input.tagName === "SELECT") input.value = val;
        else                             input.value   = val;
    });
}

/**
 * Liest einen tief verschachtelten Wert aus einem Objekt.
 * @param {Object} obj - Ausgangsobjekt
 * @param {string[]} keys - Array von Schlüsseln (Pfad)
 * @returns {*} Gefundener Wert oder undefined
 */
function getNestedValue(obj, keys) {
    return keys.reduce((node, key) => node && node[key] !== undefined ? node[key] : undefined, obj);
}

// ── Auto-Save ─────────────────────────────────────────────────

/**
 * Alle Inputs mit data-path-Attribut speichern automatisch bei Änderung.
 * Numerische Inputs werden als Zahl gespeichert, Checkboxen als Boolean.
 * Bei Font-Änderungen wird die Terminal-Config neu geladen.
 */
document.querySelectorAll("[data-path]").forEach(input => {
    input.addEventListener("change", () => {
        const path  = input.dataset.path.split(".");
        const value = input.type === "checkbox" ? input.checked
                    : input.type === "number"   ? Number(input.value)
                    : input.value;
        patchConfig(path, value);
        if (input.id === "s-enable-login") updateAuthUI();
    });
});

/**
 * Schickt eine PATCH-Anfrage an den Server um einen Konfigurationswert zu ändern.
 * Nutzt ruamel.yaml serverseitig um Kommentare und Formatierung zu erhalten.
 * Bei Font-Änderungen wird reloadTerminalConfig() aufgerufen.
 * @param {string[]} path - Pfad im Konfigurationsobjekt
 * @param {*} value - Neuer Wert
 */
async function patchConfig(path, value) {
    try {
        const resp = await fetch("/config", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, value })
        });
        const result = await resp.json();
        if (!result.ok) console.error("Config-Fehler:", result.error);
        if (path[0] === "fonts") await reloadTerminalConfig();
    } catch(e) {
        console.error("Config-Patch fehlgeschlagen:", e);
    }
}

// ── Preset-Liste rendern ──────────────────────────────────────

/**
 * Rendert die Preset-Liste gruppiert nach Kategorien, zweispaltig.
 * Drag & Drop funktioniert innerhalb und zwischen Kategorien.
 * Beim Drop in eine andere Kategorie wird das category-Feld des Presets
 * automatisch angepasst und gespeichert.
 * @param {Array} presets - Array von Preset-Objekten
 */
function renderPresetList(presets) {
    const list = document.getElementById("preset-list");
    const form = document.getElementById("preset-form");
    form.classList.add("hidden");
        list.innerHTML = "";

    // Nach Kategorien gruppieren — "Allgemein" immer zuletzt
    const groups = {};
    presets.forEach((p, i) => {
        const cat = p.category || "Allgemein";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push({ preset: p, index: i });
    });
    const sortedCats = Object.keys(groups).sort((a, b) => {
        if (a === "Allgemein") return 1;
        if (b === "Allgemein") return -1;
        return a.localeCompare(b);
    });

    sortedCats.forEach(cat => {
        // Kategorie-Header
        const header = document.createElement("div");
        header.className = "pli-category-header";
        header.textContent = cat;
        list.appendChild(header);

        // Zweispaltiges Grid für diese Kategorie
        const grid = document.createElement("div");
        grid.className = "pli-category-grid";
        grid.dataset.category = cat;

        // Drop-Zone für die Kategorie (auch wenn alle Items weggezogen wurden)
        grid.addEventListener("dragover", e => { e.preventDefault(); grid.classList.add("drag-over"); });
        grid.addEventListener("dragleave", e => {
            if (!grid.contains(e.relatedTarget)) grid.classList.remove("drag-over");
        });
        grid.addEventListener("drop", e => {
            e.preventDefault();
            grid.classList.remove("drag-over");
            const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
            const toCat   = grid.dataset.category;
            // Nur ausführen wenn kein Item-Drop (Item-Drop hat eigenen Handler)
            if (e.target === grid || e.target === header) {
                movePresetToCategory(fromIdx, toCat, null);
            }
        });

        groups[cat].forEach(({ preset: p, index: i }) => {
            const item = document.createElement("div");
            item.className = "preset-list-item";
            item.draggable = true;
            item.dataset.index = i;
            item.dataset.category = cat;
            item.innerHTML = `
                <span class="pli-drag" title="Ziehen zum Sortieren/Verschieben">⠿</span>
                <div class="pli-info">
                    <div class="pli-name">${escHtml(p.title || "")}</div>
                    <div class="pli-addr">${escHtml(p.username || "")}@${escHtml(p.host || "")}:${p.port || 22}</div>
                </div>
                <button class="pli-edit">${t("settings.edit_btn")}</button>`;

            item.querySelector(".pli-edit").addEventListener("click", () => openPresetForm(i));

            item.addEventListener("dragstart", e => {
                e.dataTransfer.setData("text/plain", i);
                item.classList.add("dragging");
                // Kategorie des gezogenen Items merken
                e.dataTransfer.setData("application/x-category", cat);
            });
            item.addEventListener("dragend", () => {
                item.classList.remove("dragging");
                document.querySelectorAll(".pli-category-grid").forEach(g => g.classList.remove("drag-over"));
                document.querySelectorAll(".preset-list-item").forEach(it => it.classList.remove("drag-target"));
            });
            item.addEventListener("dragover", e => {
                e.preventDefault();
                item.classList.add("drag-target");
            });
            item.addEventListener("dragleave", () => item.classList.remove("drag-target"));
            item.addEventListener("drop", e => {
                e.preventDefault();
                e.stopPropagation();
                item.classList.remove("drag-target");
                grid.classList.remove("drag-over");
                const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
                const toIdx   = parseInt(item.dataset.index);
                const toCat   = item.dataset.category;
                if (fromIdx === toIdx) return;
                movePresetToCategory(fromIdx, toCat, toIdx);
            });

            grid.appendChild(item);
        });

        list.appendChild(grid);
    });

    // Leere Kategorie-Drop-Zone falls alle Kategorien leer (Sonderfall)
    if (presets.length === 0) {
        const empty = document.createElement("div");
        empty.className = "pli-empty";
        empty.textContent = "Noch keine Server konfiguriert.";
        list.appendChild(empty);
    }
}

/**
 * Verschiebt ein Preset in eine andere Kategorie und/oder Position.
 * Passt das category-Feld an, speichert und rendert neu.
 * @param {number} fromIdx - Quell-Index im presets-Array
 * @param {string} toCat   - Ziel-Kategorie
 * @param {number|null} toIdx - Ziel-Index (null = ans Ende der Kategorie)
 */
function movePresetToCategory(fromIdx, toCat, toIdx) {
    const presets = settingsConfig.presets;
    const [moved] = presets.splice(fromIdx, 1);

    // Kategorie anpassen
    const newCat = toCat === "Allgemein" ? "" : toCat;
    moved.category = newCat || undefined;

    if (toIdx === null) {
        // Ans Ende anhängen
        presets.push(moved);
    } else {
        // Vor dem Ziel-Element einsetzen (Index anpassen weil splice oben schon entfernt hat)
        const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
        presets.splice(adjustedTo, 0, moved);
    }

    patchConfig(["presets"], presets);
    renderPresetList(presets);
    fillCategoryList(presets);
    _presetsHash = null;
}

/**
 * Befüllt die Kategorie-Datalist mit allen vorhandenen Kategorien.
 * Ermöglicht Autovervollständigung im Kategorie-Eingabefeld.
 * @param {Array} presets - Array von Preset-Objekten
 */
function fillCategoryList(presets) {
    const dl = document.getElementById("category-list");
    dl.innerHTML = "";
    const cats = [...new Set(presets.map(p => p.category).filter(Boolean))].sort();
    cats.forEach(cat => {
        const opt = document.createElement("option");
        opt.value = cat;
        dl.appendChild(opt);
    });
}

// Passwort im Formular anzeigen/verstecken
document.getElementById("pf-pw-toggle").addEventListener("click", () => {
    const inp = document.getElementById("pf-password");
    const btn = document.getElementById("pf-pw-toggle");
    inp.type = inp.type === "password" ? "text" : "password";
    btn.style.color = inp.type === "text" ? "var(--accent)" : "var(--text-muted)";
});

// ── Preset-Formular ───────────────────────────────────────────

/** Index des aktuell bearbeiteten Presets (null = neu). @type {number|null} */
let editingIndex = null;


// ── Font-Preview-Dropdown ──────────────────────────────────────
/**
 * Ersetzt ein <select>-Element durch ein custom Dropdown das jeden
 * Eintrag in der jeweiligen Schriftart anzeigt.
 * Behält .value-Property und feuert "change"-Events.
 */
class FontSelect {
    constructor(selectEl) {
        this._select  = selectEl;
        this._value   = selectEl.value || "";
        this._options = [];

        // Wrapper anlegen
        const wrap = document.createElement("div");
        wrap.className = "font-select-wrap";
        selectEl.parentNode.insertBefore(wrap, selectEl);
        selectEl.style.display = "none";
        wrap.appendChild(selectEl);

        // Button (zeigt aktuellen Wert)
        this._btn = document.createElement("button");
        this._btn.type = "button";
        this._btn.className = "font-select-btn";
        this._btn.innerHTML = '<span class="fsb-label"></span><span class="fsb-arrow">▼</span>';
        wrap.appendChild(this._btn);

        // Liste
        this._list = document.createElement("div");
        this._list.className = "font-select-list";
        wrap.appendChild(this._list);

        this._btn.addEventListener("click", e => { e.stopPropagation(); this._toggle(); });
        document.addEventListener("click", () => this._close());
        this._btn.addEventListener("keydown", e => {
            if (e.key === "Escape") this._close();
            if (e.key === "ArrowDown") { e.preventDefault(); this._open(); }
        });
    }

    _open()   { this._list.classList.add("open");    this._btn.querySelector(".fsb-arrow").textContent = "▲"; }
    _close()  { this._list.classList.remove("open"); this._btn.querySelector(".fsb-arrow").textContent = "▼"; }
    _toggle() { this._list.classList.contains("open") ? this._close() : this._open(); }

    _updateBtn() {
        const opt  = this._options.find(o => o.value === this._value);
        const label = this._btn.querySelector(".fsb-label");
        label.textContent  = opt ? opt.label : (this._value || "");
        label.style.fontFamily = opt?.font ? `'${opt.font}', var(--font-mono)` : "";
    }

    setOptions(options) {
        // options: [{value, label, font}]  font = null für "Standard/wie Terminal"
        this._options = options;
        this._list.innerHTML = "";
        options.forEach(opt => {
            const el = document.createElement("div");
            el.className = "font-select-option" + (opt.value === this._value ? " selected" : "");
            el.textContent = opt.label;
            el.style.fontFamily = opt.font ? `'${opt.font}', var(--font-mono)` : "";
            el.addEventListener("click", e => {
                e.stopPropagation();
                this.value = opt.value;
                this._close();
                // change-Event feuern
                this._select.dispatchEvent(new Event("change", { bubbles: true }));
            });
            this._list.appendChild(el);
        });
        this._updateBtn();
    }

    get value()      { return this._value; }
    set value(v)     {
        this._value = v;
        this._select.value = v;
        this._list.querySelectorAll(".font-select-option").forEach((el, i) => {
            el.classList.toggle("selected", this._options[i]?.value === v);
        });
        this._updateBtn();
    }
}

// Registry: selectId → FontSelect-Instanz
const _fontSelects = {};

/** Gibt die FontSelect-Instanz für eine gegebene Element-ID zurück.
 * @param {string} id - Element-ID des Original-Select
 * @returns {FontSelect|undefined}
 */
function _getFontSelect(id) { return _fontSelects[id]; }

/**
 * Initialisiert ein FontSelect-Dropdown für ein Select-Element falls noch nicht geschehen.
 * @param {string} id - Element-ID des zu ersetzenden Select
 */
function _initFontSelect(id) {
    const el = document.getElementById(id);
    if (!el || _fontSelects[id]) return;
    _fontSelects[id] = new FontSelect(el);
}

/**
 * Erzeugt ein Options-Array für FontSelect aus dem Font-Cache.
 * @param {Array} fontsCache - Array von Font-Objekten
 * @param {boolean} withStandard - Ob ein "Standard"-Eintrag vorangestellt wird
 * @param {string} standardLabel - Bezeichnung des Standard-Eintrags
 * @returns {Array<{value:string, label:string, font:string|null}>}
 */
function _fontSelectOptions(fontsCache, withStandard = true, standardLabel = "Standard") {
    const opts = withStandard ? [{ value: "", label: standardLabel, font: null }] : [];
    fontsCache.forEach(f => opts.push({ value: f.name, label: f.name, font: f.name }));
    return opts;
}

/** Zeigt das Preset-Formular-Overlay und übersetzt alle Texte. */
function _showPresetForm()  {
    document.getElementById("preset-form-overlay").classList.remove("hidden");
    if (typeof _applyTranslations === "function") _applyTranslations();
}
/** Versteckt das Preset-Formular-Overlay. */
function _hidePresetForm()  { document.getElementById("preset-form-overlay").classList.add("hidden"); }

document.getElementById("preset-add-btn").addEventListener("click", () => openPresetForm(null));
document.getElementById("pf-cancel").addEventListener("click", () => {
    _hidePresetForm();
    editingIndex = null;
});

// Preset löschen
document.getElementById("pf-delete-bottom").addEventListener("click", async () => {
    if (editingIndex === null) return;
    if (!confirm(`"${settingsConfig.presets[editingIndex].title}" ${t("preset.delete_confirm")}`)) return;
    settingsConfig.presets.splice(editingIndex, 1);
    await patchConfig(["presets"], settingsConfig.presets);
    renderPresetList(settingsConfig.presets);
    fillCategoryList(settingsConfig.presets);
    _hidePresetForm();
    editingIndex = null;
    _presetsHash = null;  // Launcher-Cache invalidieren
});

// Auth-Typ (Key/Passwort) umschalten
document.querySelectorAll("input[name='pf-auth']").forEach(radio => {
    radio.addEventListener("change", () => toggleAuthFields());
});

/**
 * Zeigt/versteckt die Auth-Felder je nach gewähltem Auth-Typ (Key/Passwort).
 */
function toggleAuthFields() {
    const isKey = document.querySelector("input[name='pf-auth']:checked").value === "key";
    document.getElementById("pf-key-label").classList.toggle("hidden", !isKey);
    document.getElementById("pf-private-key").classList.toggle("hidden", !isKey);
    document.getElementById("pf-pw-label").classList.toggle("hidden", isKey);
    document.getElementById("pf-pw-wrap").classList.toggle("hidden", isKey);
}

/**
 * Öffnet das Preset-Formular für ein bestehendes Preset oder zum Anlegen eines neuen.
 * Das Formular wird inline direkt nach dem angeklickten Eintrag eingesetzt.
 * @param {number|null} index - Index des zu bearbeitenden Presets, null für neu
 */
function openPresetForm(index) {
    editingIndex = index;
    const form  = document.getElementById("preset-form");
    const list  = document.getElementById("preset-list");
    const isNew = index === null;

    _showPresetForm();

    document.getElementById("pf-title").textContent    = isNew ? t("preset.new_title") : t("preset.edit_title");
    document.getElementById("pf-delete-bottom").style.visibility = isNew ? "hidden" : "visible";

    const p = isNew ? { port: 22 } : (settingsConfig.presets[index] || {});

    document.getElementById("pf-title-input").value = p.title    || "";
    document.getElementById("pf-category").value    = p.category || "";
    document.getElementById("pf-host").value         = p.host     || "";
    document.getElementById("pf-port").value         = p.port     || 22;
    document.getElementById("pf-username").value     = p.username || "";
    document.getElementById("pf-font-size").value    = p.font?.size   || "";
    document.getElementById("pf-font-family").value  = p.font?.family || "";

    ["2x1","1x2","2x2"].forEach(layout => {
        document.getElementById(`pf-grid-${layout}-size`).value   = p[`grid_font_${layout}`]?.size   || "";
        document.getElementById(`pf-grid-${layout}-family`).value = p[`grid_font_${layout}`]?.family || "";
    });

    const hasKey = !!p.private_key || !p.password;
    document.querySelector(`input[name="pf-auth"][value="${hasKey ? "key" : "password"}"]`).checked = true;
    const keyVal = p.private_key ? p.private_key.split("/").pop() : "";
    document.getElementById("pf-private-key").value = keyVal;
    document.getElementById("pf-password").value    = p.password || "";
    toggleAuthFields();

    form.classList.remove("hidden");
    document.getElementById("pf-title-input").focus();
}

/**
 * Speichert das Preset-Formular.
 * Validiert Pflichtfelder, sammelt alle Werte und sendet PATCH /config.
 * Invalidiert den Launcher-Cache damit neue Presets sofort erscheinen.
 */
document.getElementById("pf-save").addEventListener("click", async () => {
    const title    = document.getElementById("pf-title-input").value.trim();
    const host     = document.getElementById("pf-host").value.trim();
    const username = document.getElementById("pf-username").value.trim();

    if (!title || !host || !username) {
        alert("Name, Host und Username sind Pflichtfelder.");
        return;
    }

    const authType = document.querySelector("input[name='pf-auth']:checked").value;
    const preset   = { title, host, port: parseInt(document.getElementById("pf-port").value) || 22, username };

    const cat = document.getElementById("pf-category").value.trim();
    if (cat) preset.category = cat;

    if (authType === "key") {
        const key = document.getElementById("pf-private-key").value.trim();
        if (key) preset.private_key = key;
    } else {
        const pw = document.getElementById("pf-password").value;
        if (pw.trim()) preset.password = pw;
    }

    const fontSize   = parseInt(document.getElementById("pf-font-size").value);
    const fontFamily = document.getElementById("pf-font-family").value.trim();
    if (fontSize || fontFamily) {
        preset.font = {};
        if (fontSize)   preset.font.size   = fontSize;
        if (fontFamily) preset.font.family = fontFamily;
    }

    ["2x1","1x2","2x2"].forEach(layout => {
        const sz  = parseInt(document.getElementById(`pf-grid-${layout}-size`).value);
        const fam = document.getElementById(`pf-grid-${layout}-family`).value.trim();
        if (sz || fam) {
            preset[`grid_font_${layout}`] = {};
            if (sz)  preset[`grid_font_${layout}`].size   = sz;
            if (fam) preset[`grid_font_${layout}`].family = fam;
        }
    });

    if (editingIndex === null) settingsConfig.presets.push(preset);
    else                       settingsConfig.presets[editingIndex] = preset;

    await patchConfig(["presets"], settingsConfig.presets);
    renderPresetList(settingsConfig.presets);
    fillCategoryList(settingsConfig.presets);
    _hidePresetForm();
    editingIndex  = null;
    _presetsHash  = null;  // Launcher-Cache invalidieren
});

// ── Passwort-Tab ──────────────────────────────────────────────

/**
 * Wechselt die Sichtbarkeit eines Passwort-Feldes (Auge-Button).
 * @param {string} id - ID des Passwort-Feldes
 * @param {HTMLElement} btn - Auge-Button
 */
function togglePwField(id, btn) {
    const inp = document.getElementById(id);
    inp.type = inp.type === "password" ? "text" : "password";
    btn.style.color = inp.type === "text" ? "var(--accent)" : "";
}

/**
 * Speichert ein neues Passwort über POST /auth/change-password.
 * Validiert dass neues Passwort und Bestätigung übereinstimmen.
 */
document.getElementById("cp-save").addEventListener("click", async () => {
    const current = document.getElementById("cp-current").value;
    const newPw   = document.getElementById("cp-new").value;
    const confirm = document.getElementById("cp-confirm").value;
    const msg     = document.getElementById("cp-msg");
    msg.style.color = "var(--text-muted)";
    msg.textContent = "…";

    try {
        const resp = await fetch("/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current_password: current, new_password: newPw, confirm_password: confirm }),
        });
        const data = await resp.json();
        if (data.ok) {
            msg.style.color = "var(--success)";
            msg.textContent = "Passwort geändert ✓";
            ["cp-current","cp-new","cp-confirm"].forEach(id => document.getElementById(id).value = "");
        } else {
            msg.style.color = "var(--danger)";
            msg.textContent = data.error || "Fehler";
        }
    } catch(e) {
        msg.style.color = "var(--danger)";
        msg.textContent = "Verbindungsfehler";
    }
});

// ── Terminal-Config neu laden ─────────────────────────────────

/**
 * Lädt die Terminal-Konfiguration neu und aktualisiert @font-face, CSS-Variablen
 * und window.terminalConfig. Wird nach Font-Änderungen in den Einstellungen aufgerufen.
 */
async function reloadTerminalConfig() {
    try {
        const resp = await fetch("/config/terminal");
        const cfg  = await resp.json();

        let styleEl = document.getElementById("font-face-style");
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = "font-face-style";
            document.head.appendChild(styleEl);
        }
        // Terminal-Font @font-face
        let fontFaceRules = `
            @font-face { font-family:'${cfg.font_family}'; src:url('${cfg.font_file}') format('${cfg.font_format || "truetype"}'); font-weight:normal; }
            @font-face { font-family:'${cfg.font_family}'; src:url('${cfg.font_file_bold}') format('${cfg.font_format || "truetype"}'); font-weight:bold; }
        `;
        // Preview-Font @font-face (falls abweichend vom Terminal-Font)
        if (cfg.preview_font_family && cfg.preview_font_family !== cfg.font_family) {
            const pf = _fontsCache.find(f => f.name === cfg.preview_font_family);
            if (pf) {
                fontFaceRules += `
            @font-face { font-family:'${pf.name}'; src:url('${pf.file}') format('${pf.format || "truetype"}'); font-weight:normal; }`;
                if (pf.file_bold) fontFaceRules += `
            @font-face { font-family:'${pf.name}'; src:url('${pf.file_bold}') format('${pf.format || "truetype"}'); font-weight:bold; }`;
            }
        }
        styleEl.textContent = fontFaceRules;
        try { await document.fonts.load(`${cfg.font_size}px '${cfg.font_family}'`); } catch(e) {}
        if (cfg.preview_font_family) {
            try { await document.fonts.load(`${cfg.preview_font_size || 13}px '${cfg.preview_font_family}'`); } catch(e) {}
        }
        window.terminalConfig = cfg;
        applyFontSizes(cfg);
    } catch(e) {}
}
// ── Preset Export / Import ─────────────────────────────────────

/** Zeigt den Export-Dialog für Presets (Passwort-Eingabe). */
function showPresetExportDialog() {
    _hidePresetForm();
    document.getElementById("preset-import-dialog").classList.add("hidden");
    document.getElementById("preset-export-dialog").classList.remove("hidden");
    document.getElementById("preset-export-pw").value  = "";
    document.getElementById("preset-export-pw2").value = "";
    document.getElementById("preset-export-pw").focus();
}

/** Zeigt den Import-Dialog für Presets (Datei + Passwort). */
function showPresetImportDialog() {
    _hidePresetForm();
    document.getElementById("preset-export-dialog").classList.add("hidden");
    document.getElementById("preset-import-dialog").classList.remove("hidden");
    document.getElementById("preset-import-file").value = "";
    document.getElementById("preset-import-pw").value   = "";
}

/** Versteckt Export- und Import-Dialog und leert deren Eingabefelder. */
function hidePresetDialogs() {
    document.getElementById("preset-export-dialog").classList.add("hidden");
    document.getElementById("preset-import-dialog").classList.add("hidden");
}

document.getElementById("preset-export-btn").addEventListener("click", showPresetExportDialog);
document.getElementById("preset-import-btn").addEventListener("click", showPresetImportDialog);
document.getElementById("preset-export-cancel").addEventListener("click", hidePresetDialogs);
document.getElementById("preset-import-cancel").addEventListener("click", hidePresetDialogs);

document.getElementById("preset-export-ok").addEventListener("click", async () => {
    const pw  = document.getElementById("preset-export-pw").value;
    const pw2 = document.getElementById("preset-export-pw2").value;
    if (!pw) { alert("Bitte ein Passwort eingeben."); return; }
    if (pw !== pw2) { alert("Passwörter stimmen nicht überein."); return; }

    try {
        const resp = await fetch("/presets/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pw }),
        });
        if (!resp.ok) { alert("Export fehlgeschlagen."); return; }
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = "webssh-presets.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        hidePresetDialogs();
    } catch(e) {
        alert(`Export-Fehler: ${e.message || e}`);
    }
});

document.getElementById("preset-import-ok").addEventListener("click", async () => {
    const file = document.getElementById("preset-import-file").files[0];
    const pw   = document.getElementById("preset-import-pw").value;
    if (!file) { alert("Bitte eine Datei auswählen."); return; }
    if (!pw)   { alert("Bitte das Export-Passwort eingeben."); return; }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("password", pw);

    try {
        const resp = await fetch("/presets/import", { method: "POST", body: fd });
        const data = await resp.json();
        if (!data.ok) { alert(`Import fehlgeschlagen: ${data.error}`); return; }
        alert(`${data.count} Preset(s) importiert.`);
        hidePresetDialogs();
        // Einstellungen neu laden damit die neuen Presets erscheinen
        const cfg = await fetch("/config").then(r => r.json());
        settingsConfig = cfg;
        renderPresetList(cfg.presets || []);
        fillCategoryList(cfg.presets || []);
        _presetsHash = null;
    } catch(e) {
        alert(`Import-Fehler: ${e.message || e}`);
    }
});