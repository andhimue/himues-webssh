/**
 * i18n.js — Internationalisierung
 *
 * Lädt eine Sprachdatei aus /static/i18n/<lang>.json und stellt
 * die Funktion t(key, vars) zur Verfügung.
 *
 * Sprache wird in localStorage gespeichert ("webssh_lang").
 * Standardsprache: "de"
 *
 * Verwendung:
 *   t("sftp.delete")               → "Löschen" / "Delete"
 *   t("sftp.delete_confirm", {n:3}) → "Folgende 3 Element(e)…"
 */

const SUPPORTED_LANGS = ["de", "en"];
const DEFAULT_LANG    = "de";

let _i18n = {};

/**
 * Übersetzt einen Schlüssel. Gibt den Schlüssel zurück wenn nicht gefunden.
 * @param {string} key
 * @param {Object} vars - Variablen für Platzhalter wie {n}
 */
function t(key, vars = {}) {
    let str = _i18n[key] || key;
    Object.entries(vars).forEach(([k, v]) => {
        str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    });
    return str;
}

/** Gibt die aktuelle Sprache zurück. */
function getLang() {
    return localStorage.getItem("webssh_lang") || DEFAULT_LANG;
}

/** Lädt eine Sprache und wendet sie an. */
async function setLang(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) lang = DEFAULT_LANG;
    try {
        const resp = await fetch(`/static/i18n/${lang}.json`);
        _i18n = await resp.json();
        localStorage.setItem("webssh_lang", lang);
        _applyTranslations();
    } catch(e) {
        console.error("i18n load failed:", e);
    }
}

/**
 * Wendet Übersetzungen auf Elemente mit data-i18n-Attribut an.
 * <button data-i18n="sftp.delete">Löschen</button>
 * <input data-i18n-placeholder="launcher.search">
 */
function _applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.dataset.i18n;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            el.placeholder = t(key);
        } else if (el.tagName === "OPTION") {
            el.textContent = t(key);
        } else {
            // Nur den Textknoten ersetzen, Kind-Elemente (Spans etc.) behalten
            const textNode = Array.from(el.childNodes).find(n => n.nodeType === 3);
            if (textNode) textNode.textContent = t(key);
            else el.textContent = t(key);
        }
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll("[data-i18n-title]").forEach(el => {
        el.title = t(el.dataset.i18nTitle);
    });
    document.querySelectorAll("[data-i18n-html]").forEach(el => {
        el.innerHTML = t(el.dataset.i18nHtml);
    });
    // page title
    const titleKey = document.documentElement.dataset.i18nTitle;
    if (titleKey) document.title = t(titleKey);
}

// Beim Start laden
(async () => {
    await setLang(getLang());
})();