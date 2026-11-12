/**
 * Herdchestra Lite dashboard widget.
 *
 * The widget is layout only. It reads lines from `dashboard-model.mjs`, picks
 * compact or expanded, fits the terminal width, and applies the stable-height
 * lock. It never owns status words, counts, waiting chains, or audit scores.
 *
 * Host boundary: only the public `ctx.ui.setWidget(key, content, {placement})`
 * is used. `setHookWidget` is private to the host and is never called. A
 * component factory is preferred; a string array capped at 10 lines is the
 * degraded path. Neither path may throw into the mission.
 *
 * `Ctrl+Shift+T` is offered through `ctx.ui.onTerminalInput` when available;
 * the extension may instead register the same shortcut and call `toggle()`.
 * `/herd-status verbose` remains the full-view fallback.
 */

import { DASHBOARD_MODEL_VERSION, deriveDashboard } from "./dashboard-model.mjs";

export const DASHBOARD_WIDGET_KEY = "herdchestra-dashboard";
export const DASHBOARD_TEXT_MAX_LINES = 10;
export const DASHBOARD_TOGGLE_SHORTCUT = "ctrl+shift+t";

const DEFAULT_TOGGLE_SEQUENCES = Object.freeze([
	"\x1b[116;5u", // kitty protocol: Ctrl+Shift+T (base lowercase key)
	"\x1b[84;5u", // kitty protocol: Ctrl+Shift+T (base uppercase key)
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI stripping is intentional.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const positiveInteger = (value) => {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return null;
};

const finiteNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const asStringArray = (value) => {
	if (!Array.isArray(value)) return [];
	return value.map((line) => (typeof line === "string" ? line : String(line ?? "")));
};

const asArray = (value) => {
	if (Array.isArray(value)) return value;
	if (value instanceof Set) return [...value];
	if (typeof value === "string") return [value];
	return [];
};

const safeCall = (callback, fallback = undefined) => {
	try {
		return callback();
	} catch {
		return fallback;
	}
};

const errorText = (error) => {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error ?? "unknown error");
};

/**
 * Display width of a terminal line, ignoring ANSI CSI sequences.
 *
 * This intentionally covers the characters the dashboard emits: ASCII,
 * Chinese, emoji, combining marks, and a conservative East Asian wide range.
 *
 * @param {string} text
 * @returns {number}
 */
export function visibleWidth(text) {
	const clean = String(text ?? "").replace(ANSI_PATTERN, "");
	let width = 0;
	for (const character of clean) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		if (codePoint === 0x200d || (codePoint >= 0x0300 && codePoint <= 0x036f)) continue;
		if (
			(codePoint >= 0x1100 && codePoint <= 0x115f) ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd)
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/**
 * Truncate one line to a terminal column width, appending an ellipsis when
 * content is dropped.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function truncateToWidth(text, width) {
	const limit = positiveInteger(width);
	if (limit === null) return String(text ?? "");
	const clean = String(text ?? "");
	if (visibleWidth(clean) <= limit) return clean;
	if (limit <= 1) return "…";
	const budget = limit - 1;
	let result = "";
	let used = 0;
	for (const character of clean) {
		const characterWidth = visibleWidth(character);
		if (used + characterWidth > budget) break;
		result += character;
		used += characterWidth;
	}
	return `${result}…`;
}

const normalizeRegime = (regime) => {
	if (typeof regime === "string" && regime) return { key: regime, maxHeight: null };
	if (isRecord(regime)) {
		const key =
			(typeof regime.id === "string" && regime.id) ||
			(typeof regime.key === "string" && regime.key) ||
			(typeof regime.name === "string" && regime.name) ||
			"default";
		return { key, maxHeight: finiteNumber(regime.maxHeight) };
	}
	return { key: "default", maxHeight: null };
};

const readTerminalSize = (options = {}) => {
	const explicit = safeCall(() => options.getTerminalSize?.(), undefined);
	const optionRows =
		typeof options.terminalRows === "function"
			? safeCall(() => options.terminalRows(), undefined)
			: options.terminalRows;
	const optionColumns =
		typeof options.terminalColumns === "function"
			? safeCall(() => options.terminalColumns(), undefined)
			: options.terminalColumns;
	let processRows;
	let processColumns;
	try {
		processRows = globalThis.process?.stdout?.rows;
		processColumns = globalThis.process?.stdout?.columns;
	} catch {
		// A host without a process object still gets the explicit options.
	}
	return {
		rows: positiveInteger(optionRows) ?? positiveInteger(explicit?.rows) ?? positiveInteger(processRows),
		columns: positiveInteger(optionColumns) ?? positiveInteger(explicit?.columns) ?? positiveInteger(processColumns),
	};
};

/**
 * Lock one display regime to its first natural height.
 *
 * The returned bound truncates later growth, pads later shrinking to the same
 * line count, and re-locks only when the regime, width, or terminal row count
 * changes. The reserve keeps the bottom input area and chat viewport free.
 *
 * @param {string | {id?: string, key?: string, name?: string, maxHeight?: number}} regime
 * @param {(width: number) => string[]} render
 * @param {{
 *   maxHeight?: number,
 *   minHeight?: number,
 *   terminalRows?: number | (() => number | undefined),
 *   reserveRows?: number,
 *   maxFraction?: number,
 *   padLine?: string,
 * }} [options]
 * @returns {Function & {
 *   render: (width: number) => string[],
 *   reset: (nextRegime?: string | object) => void,
 *   invalidate: () => void,
 *   readonly height: number | null,
 *   readonly truncated: boolean,
 *   readonly regime: string,
 *   readonly budget: number,
 * }}
 */
export function applyStableHeightBound(regime, render, options = {}) {
	if (typeof render !== "function") throw new TypeError("applyStableHeightBound requires a render function");
	let descriptor = normalizeRegime(regime);
	let lockedHeight = null;
	let lastWidth = null;
	let lastRows;
	let truncated = false;
	const minHeight = Math.max(0, Math.trunc(finiteNumber(options.minHeight) ?? 1));
	const declaredMax = Math.max(0, Math.trunc(finiteNumber(options.maxHeight) ?? Number.POSITIVE_INFINITY));
	const reserveRows = Math.max(0, Math.trunc(finiteNumber(options.reserveRows) ?? 8));
	const maxFraction = Math.max(0.1, Math.min(1, finiteNumber(options.maxFraction) ?? 0.5));
	const padLine = typeof options.padLine === "string" ? options.padLine : "";

	const terminalRows = () => {
		const raw =
			typeof options.terminalRows === "function"
				? safeCall(() => options.terminalRows(), undefined)
				: options.terminalRows;
		let processRows;
		try {
			processRows = globalThis.process?.stdout?.rows;
		} catch {
			// No process object; the caller must supply terminalRows.
		}
		return positiveInteger(raw) ?? positiveInteger(processRows);
	};

	const budget = () => {
		const rows = terminalRows();
		const regimeMax =
			descriptor.maxHeight === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(descriptor.maxHeight));
		const cap = Math.min(declaredMax, regimeMax);
		if (rows === null) return cap;
		const available = Math.max(1, rows - reserveRows);
		const share = Math.max(1, Math.floor(rows * maxFraction));
		return Math.max(1, Math.min(cap, available, share));
	};

	const bound = {
		render(width) {
			const numericWidth = positiveInteger(width);
			const rows = terminalRows();
			if (numericWidth !== lastWidth || rows !== lastRows) {
				lastWidth = numericWidth;
				lastRows = rows;
				lockedHeight = null;
			}
			let lines = asStringArray(render(numericWidth ?? 80));
			if (lockedHeight === null) {
				const cap = budget();
				lockedHeight = Math.max(0, Math.min(cap, Math.max(minHeight, lines.length)));
			}
			truncated = lines.length > lockedHeight;
			if (truncated) lines = lines.slice(0, lockedHeight);
			while (lines.length < lockedHeight) lines.push(padLine);
			return lines;
		},
		reset(nextRegime) {
			if (nextRegime !== undefined) descriptor = normalizeRegime(nextRegime);
			lockedHeight = null;
			lastWidth = null;
			lastRows = undefined;
			truncated = false;
		},
		invalidate() {
			// Kept for component symmetry; layout is rebuilt on every render.
		},
		get height() {
			return lockedHeight;
		},
		get truncated() {
			return truncated;
		},
		get regime() {
			return descriptor.key;
		},
		get budget() {
			return budget();
		},
	};
	const callable = (width) => bound.render(width);
	Object.defineProperties(callable, {
		render: { value: bound.render, enumerable: true },
		reset: { value: bound.reset, enumerable: true },
		invalidate: { value: bound.invalidate, enumerable: true },
		height: { get: () => bound.height, enumerable: true },
		truncated: { get: () => bound.truncated, enumerable: true },
		regime: { get: () => bound.regime, enumerable: true },
		budget: { get: () => bound.budget, enumerable: true },
	});
	return callable;
}

const normalizeProvider = (source) => {
	if (typeof source === "function") return source;
	const fixed = source === undefined ? deriveDashboard({}) : source;
	return () => fixed;
};

const asDashboardModel = (value) => {
	if (
		isRecord(value) &&
		value.version === DASHBOARD_MODEL_VERSION &&
		Array.isArray(value.compact?.lines) &&
		Array.isArray(value.expanded?.lines)
	) {
		return value;
	}
	return deriveDashboard(isRecord(value) ? value : {});
};

const regimeKeyFor = (model, expanded) => {
	const view = expanded ? (model.expanded?.regime ?? "expanded") : "compact";
	const audit = model.audit?.active ? `audit-${model.audit.phaseIndex}` : "audit-off";
	return `${expanded ? "expanded" : "compact"}:${view}:${audit}:${model.mission?.slug ?? "-"}`;
};

const maxHeightFor = (expanded, options) => {
	const explicit = finiteNumber(options.maxHeight);
	if (explicit !== null) return Math.max(1, Math.trunc(explicit));
	return expanded
		? Math.max(1, Math.trunc(finiteNumber(options.expandedMaxHeight) ?? 22))
		: Math.max(1, Math.trunc(finiteNumber(options.compactMaxHeight) ?? 9));
};

/**
 * Mount the dashboard above the editor.
 *
 * @param {{ui?: {setWidget?: Function, onTerminalInput?: Function}}} ctx
 * @param {object | (() => object)} modelSource
 * @param {{
 *   key?: string,
 *   placement?: string,
 *   expanded?: boolean,
 *   recordHealth?: (entry: object) => void,
 *   onToggle?: (expanded: boolean) => void,
 *   compactMaxHeight?: number,
 *   expandedMaxHeight?: number,
 *   maxHeight?: number,
 *   reserveRows?: number,
 *   maxFraction?: number,
 *   narrowWidth?: number,
 *   getTerminalSize?: () => {columns?: number, rows?: number},
 *   terminalRows?: number | (() => number | undefined),
 *   terminalColumns?: number | (() => number | undefined),
 *   toggleSequences?: string[],
 *   allowCtrlT?: boolean,
 *   shortcutProvided?: boolean,
 *   forceText?: boolean,
 * }} [options]
 * @returns {object} mount handle; never throws
 */
export function mountDashboard(ctx, modelSource, options = {}) {
	const key = typeof options.key === "string" && options.key ? options.key : DASHBOARD_WIDGET_KEY;
	const placement = typeof options.placement === "string" && options.placement ? options.placement : "aboveEditor";
	const ui = ctx?.ui;
	const degradation = { degraded: false, reasons: [] };
	const healthSent = new Set();
	const capabilities = {
		setWidget: Boolean(ui && typeof ui.setWidget === "function"),
		componentFactory: false,
		textFallback: false,
		shortcut: Boolean(ui && typeof ui.onTerminalInput === "function"),
	};
	let provider = normalizeProvider(modelSource);
	let lastModel = deriveDashboard({});
	let mode = "unavailable";
	let ok = false;
	let expanded = options.expanded === true;
	let closed = false;
	let savedTui = null;
	let component = null;
	let heightState = null;
	let textState = null;
	let unsubscribe = null;
	const toggleSequences = new Set(DEFAULT_TOGGLE_SEQUENCES);
	for (const sequence of asArray(options.toggleSequences)) {
		if (typeof sequence === "string" && sequence) toggleSequences.add(sequence);
	}
	if (options.allowCtrlT) toggleSequences.add("\x14");

	let healthModulePromise;
	const sendHealth = (entry) => {
		if (options.recordHealth === false) return;
		if (typeof options.recordHealth === "function") {
			safeCall(() => options.recordHealth(entry));
			return;
		}
		if (!healthModulePromise) {
			healthModulePromise = import("../host/health.mjs").catch(() => null);
		}
		void healthModulePromise.then((module) => {
			safeCall(() => module?.recordHealth?.(entry));
		});
	};

	const degrade = (reason, error, status = "degraded") => {
		if (!degradation.reasons.includes(reason)) degradation.reasons.push(reason);
		degradation.degraded = true;
		const dedupeKey = `${status}:${reason}`;
		if (healthSent.has(dedupeKey)) return;
		healthSent.add(dedupeKey);
		sendHealth({
			entry: "tui.dashboard",
			status,
			degraded: true,
			version: String(DASHBOARD_MODEL_VERSION),
			capabilities: { ...capabilities },
			error: error === undefined ? reason : `${reason}: ${errorText(error)}`,
		});
	};

	const readModel = () => {
		try {
			const next = provider();
			if (next && typeof next.then === "function") {
				throw new Error("dashboard model provider must be synchronous");
			}
			lastModel = asDashboardModel(next);
		} catch (error) {
			degrade("model-provider-failed", error);
		}
		return lastModel;
	};

	const buildTextLines = (model) => {
		const size = readTerminalSize(options);
		const width = size.columns === null ? null : Math.max(1, size.columns - 1);
		const natural = (expanded ? model.expanded.lines : model.compact.lines).map((line) =>
			width === null ? line : truncateToWidth(line, width),
		);
		const regime = `text:${regimeKeyFor(model, expanded)}`;
		if (!textState || textState.regime !== regime) {
			const state = { regime, lines: natural, bound: null };
			state.bound = applyStableHeightBound(regime, () => state.lines, {
				maxHeight: DASHBOARD_TEXT_MAX_LINES,
				minHeight: 1,
				reserveRows: 6,
				maxFraction: 0.5,
				terminalRows: () => readTerminalSize(options).rows,
			});
			textState = state;
		} else {
			textState.lines = natural;
		}
		const lines = textState.bound.render(width ?? 100);
		if (textState.bound.truncated && lines.length > 1) {
			const hint = "… /herd-status verbose 查看完整视图";
			lines[lines.length - 1] = width === null ? hint : truncateToWidth(hint, width);
		}
		return lines;
	};

	const buildComponentLines = (model, width) => {
		const size = readTerminalSize(options);
		const effectiveWidth = positiveInteger(width) ?? size.columns ?? 80;
		const narrowWidth = Math.max(0, finiteNumber(options.narrowWidth) ?? 46);
		let wanted;
		if (effectiveWidth < narrowWidth) {
			const essential = model.compact.lines.slice(
				0,
				Math.max(1, positiveInteger(model.compact.essentialCount) ?? model.compact.lines.length),
			);
			wanted = [...essential, "… /herd-status verbose 查看完整视图"];
		} else {
			wanted = expanded ? model.expanded.lines : model.compact.lines;
		}
		const lines = wanted.map((line) => truncateToWidth(line, effectiveWidth));
		const regime = regimeKeyFor(model, expanded);
		if (!heightState || heightState.regime !== regime) {
			const state = { regime, lines, bound: null };
			state.bound = applyStableHeightBound(regime, () => state.lines, {
				maxHeight: maxHeightFor(expanded, options),
				minHeight: 1,
				reserveRows: options.reserveRows ?? 8,
				maxFraction: options.maxFraction ?? 0.5,
				terminalRows: () => readTerminalSize(options).rows,
			});
			heightState = state;
		} else {
			heightState.lines = lines;
		}
		const output = heightState.bound.render(effectiveWidth);
		if (heightState.bound.truncated && output.length > 1) {
			output[output.length - 1] = truncateToWidth("… 已截断，详见 /herd-status verbose", effectiveWidth);
		}
		return output;
	};

	const useText = (reason, error) => {
		if (closed) return;
		try {
			const lines = buildTextLines(readModel());
			const result = ui.setWidget(key, lines, { placement });
			mode = "text";
			ok = true;
			capabilities.textFallback = true;
			if (typeof result?.catch === "function") {
				void result.catch((asyncError) => {
					mode = "unavailable";
					ok = false;
					degrade("text-update-failed", asyncError, "failed");
				});
			}
			if (reason) degrade(reason, error);
		} catch (mountError) {
			mode = "unavailable";
			ok = false;
			capabilities.textFallback = false;
			degrade("setWidget-unavailable", mountError, "failed");
		}
	};

	const mountComponent = () => {
		const created = {
			render(width) {
				try {
					return buildComponentLines(readModel(), width);
				} catch (error) {
					degrade("render-failed", error);
					const height = Math.max(1, heightState?.bound?.height ?? 1);
					const fallback = ["看板渲染失败，使用 /herd-status verbose 查看状态"];
					while (fallback.length < height) fallback.push("");
					return fallback.slice(0, height);
				}
			},
			invalidate() {
				// The model lines are rebuilt on every render; no cache to clear.
			},
			handleInput(data) {
				if (closed) return false;
				if (!toggleSequences.has(data)) return false;
				setExpanded(!expanded);
				return true;
			},
		};
		component = created;
		const result = ui.setWidget(
			key,
			(tui) => {
				savedTui = tui ?? null;
				return created;
			},
			{ placement },
		);
		mode = "component";
		ok = true;
		capabilities.componentFactory = true;
		if (typeof result?.catch === "function") {
			void result.catch((error) => {
				degrade("setWidget-async-failed", error);
				useText("text-fallback-active", error);
			});
		}
	};

	const setExpanded = (value) => {
		if (closed) return expanded;
		const next = Boolean(value);
		if (next === expanded) return expanded;
		expanded = next;
		heightState = null;
		textState = null;
		syncView();
		safeCall(() => options.onToggle?.(expanded));
		return expanded;
	};

	const syncView = () => {
		if (closed) return;
		if (mode === "component") {
			safeCall(() => component?.invalidate());
			if (savedTui && typeof savedTui.requestRender === "function") {
				safeCall(() => savedTui.requestRender());
			}
			return;
		}
		if (mode === "text") {
			try {
				const lines = buildTextLines(readModel());
				const result = ui.setWidget(key, lines, { placement });
				if (typeof result?.catch === "function") {
					void result.catch((error) => {
						mode = "unavailable";
						ok = false;
						degrade("text-update-failed", error, "failed");
					});
				}
			} catch (error) {
				mode = "unavailable";
				ok = false;
				degrade("text-update-failed", error, "failed");
			}
		}
	};

	const registerInput = () => {
		if (options.shortcutProvided === true) {
			capabilities.shortcut = true;
			return;
		}
		if (typeof ui?.onTerminalInput !== "function") {
			capabilities.shortcut = false;
			degrade("toggle-shortcut-unavailable", "Ctrl+Shift+T 不可用；使用 /herd-status verbose");
			return;
		}
		try {
			const result = ui.onTerminalInput((data) => {
				if (closed) return undefined;
				if (!toggleSequences.has(data)) return undefined;
				setExpanded(!expanded);
				return { consume: true };
			});
			if (typeof result === "function") unsubscribe = result;
		} catch (error) {
			capabilities.shortcut = false;
			degrade("input-hook-unavailable", error);
		}
	};

	const close = () => {
		if (closed) return false;
		closed = true;
		safeCall(() => ui?.setWidget?.(key, undefined, { placement }));
		safeCall(() => unsubscribe?.());
		unsubscribe = null;
		mode = "closed";
		ok = false;
		return true;
	};

	const update = (nextSource) => {
		provider = normalizeProvider(nextSource);
		lastModel = readModel();
		syncView();
		return handle;
	};

	const handle = {
		key,
		placement,
		shortcut: DASHBOARD_TOGGLE_SHORTCUT,
		get ok() {
			return ok;
		},
		get mode() {
			return mode;
		},
		get reason() {
			return degradation.reasons[0] ?? null;
		},
		degradation,
		get model() {
			return lastModel;
		},
		get expanded() {
			return expanded;
		},
		get height() {
			return heightState?.bound?.height ?? textState?.bound?.height ?? null;
		},
		get component() {
			return component;
		},
		update,
		refresh() {
			lastModel = readModel();
			syncView();
			return handle;
		},
		toggle() {
			return setExpanded(!expanded);
		},
		setExpanded,
		renderText(modeName = "compact") {
			const view = modeName === "expanded" || modeName === "verbose" ? lastModel.expanded : lastModel.compact;
			return view.text ?? view.lines.join("\n");
		},
		close,
	};

	lastModel = readModel();
	if (!ui || typeof ui.setWidget !== "function") {
		capabilities.setWidget = false;
		degrade("setWidget-unavailable", "ctx.ui.setWidget is not available", "failed");
		return handle;
	}
	capabilities.setWidget = true;
	if (options.forceText) {
		useText(null, undefined);
	} else {
		try {
			mountComponent();
		} catch (error) {
			capabilities.componentFactory = false;
			degrade("component-factory-failed", error);
			useText("text-fallback-active", error);
		}
	}
	if (mode !== "unavailable") registerInput();
	return handle;
}
