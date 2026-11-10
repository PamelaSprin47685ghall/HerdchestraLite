/**
 * Editor-theme compatibility shim for omp 18.16.0 + pi-goal-x 0.34.1.
 *
 * pi-goal-x 0.34.1 constructs `new Editor(tui, editorTheme)` against the
 * earendil pi-tui 1.5.0 two-argument constructor. omp rewrites that import to
 * its bundled @oh-my-pi/pi-tui 18.16.0, whose Editor takes one argument:
 *
 *     constructor(theme: EditorTheme) {
 *         this.#theme = theme;
 *         this.borderColor = theme.borderColor;
 *     }
 *
 * The first argument pi-goal-x passes is the live TUI instance, so `#theme`
 * becomes that instance and `render()` dies on `this.#theme.symbols.boxRound`.
 *
 * This module gives the TUI class the EditorTheme surface the 18.16.0 Editor
 * reads: symbols, selectList, borderColor, accentColor, surfaceColor,
 * textColor, and hintStyle. Every getter rebuilds from the host's own
 * `getEditorTheme()`, so a theme switch is picked up on the next read.
 *
 * Constraints honoured: omp and node_modules stay untouched; this file only
 * adds a prototype surface when the host does not already provide one.
 *
 * Old location: editor-theme-compat.ts lines 1-178.
 */
import * as piTui from "@oh-my-pi/pi-tui";

/**
 * @typedef {(text: string) => string} StyleFn
 * @typedef {object} EditorThemeSurface
 * @property {StyleFn} borderColor
 * @property {StyleFn} [accentColor]
 * @property {StyleFn} [surfaceColor]
 * @property {StyleFn} [textColor]
 * @property {unknown} selectList
 * @property {unknown} symbols
 * @property {StyleFn} [hintStyle]
 * @typedef {object} SymbolThemeSurface
 * @property {string} cursor
 * @property {string} inputCursor
 * @property {unknown} boxRound
 * @property {unknown} boxSharp
 * @property {unknown} table
 * @property {string} quoteBorder
 * @property {string} hrChar
 * @property {string} colorSwatch
 * @property {string[]} spinnerFrames
 * @typedef {"installed" | "present" | "unavailable"} PatchOutcome
 */

/** @type {StyleFn} */
const passthrough = (text) => text;

/**
 * ASCII box, copied from pi-tui's own pre-theme fallback in getSymbolTheme().
 *
 * @returns {SymbolThemeSurface}
 */
function fallbackSymbols() {
	const box = {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		cross: "+",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
	};
	return {
		cursor: ">",
		inputCursor: "|",
		boxRound: box,
		boxSharp: box,
		table: box,
		quoteBorder: "|",
		hrChar: "-",
		colorSwatch: "[]",
		spinnerFrames: ["-", "\\", "|", "/"],
	};
}

/** Prefer the host builders; fall back to plain text only if they are absent. */
export function readTheme() {
	if (typeof piTui.getEditorTheme === "function") {
		try {
			return piTui.getEditorTheme();
		} catch {
			// A host builder that throws must not take the dialog down with it.
		}
	}
	let symbols = fallbackSymbols();
	if (typeof piTui.getSymbolTheme === "function") {
		try {
			symbols = piTui.getSymbolTheme();
		} catch {
			// Keep the ASCII preset.
		}
	}
	let selectList = {
		selectedPrefix: passthrough,
		selectedText: passthrough,
		description: passthrough,
		scrollInfo: passthrough,
		noMatch: passthrough,
		symbols,
		icon: passthrough,
		hovered: passthrough,
	};
	if (typeof piTui.getSelectListTheme === "function") {
		try {
			selectList = piTui.getSelectListTheme();
		} catch {
			// Keep the unstyled list.
		}
	}
	return {
		borderColor: passthrough,
		accentColor: passthrough,
		surfaceColor: passthrough,
		textColor: passthrough,
		selectList,
		symbols,
		hintStyle: passthrough,
	};
}

/**
 * Install the EditorTheme surface on the TUI prototype.
 *
 * `symbols` is the probe: when it already exists, the host supplies a correct
 * EditorTheme and this shim stays out of the way. `borderColor` gets a setter
 * because Editor's constructor assigns `this.borderColor = theme.borderColor`
 * on the instance; a getter-only prototype property would throw in strict mode.
 *
 * @returns {PatchOutcome}
 */
export function installEditorThemeSurface() {
	const tuiClass = piTui.TUI;
	if (typeof tuiClass !== "function") return "unavailable";
	const proto = tuiClass.prototype;
	if (!proto || typeof proto !== "object") return "unavailable";
	if ("symbols" in proto) return "present";
	try {
		Object.defineProperties(proto, {
			borderColor: {
				configurable: true,
				get: () => readTheme().borderColor,
				set(value) {
					Object.defineProperty(this, "borderColor", {
						value,
						writable: true,
						configurable: true,
						enumerable: true,
					});
				},
			},
			symbols: { configurable: true, get: () => readTheme().symbols },
			selectList: { configurable: true, get: () => readTheme().selectList },
			accentColor: { configurable: true, get: () => readTheme().accentColor },
			surfaceColor: { configurable: true, get: () => readTheme().surfaceColor },
			textColor: { configurable: true, get: () => readTheme().textColor },
			hintStyle: { configurable: true, get: () => readTheme().hintStyle },
		});
		return "installed";
	} catch {
		return "unavailable";
	}
}

// Patch at module evaluation so the surface exists before any dialog opens.
export const initialOutcome = installEditorThemeSurface();
