/**
 * Editor-theme entry: keeps pi-goal-x dialogs renderable on a host whose TUI
 * theme surface differs from the one the dialogs expect.
 *
 * Depends on ./surface.mjs, which installs the prototype surface at module
 * evaluation. This entry retries that installation on `session_start` only
 * when the initial attempt failed, then reports the failure once.
 *
 * Old location: editor-theme-compat.ts lines 179-192.
 *
 * Failure isolation: this entry never throws at load time; without it the other
 * two entries still load and only dialog rendering degrades.
 *
 * @param {ExtensionApiLike} pi
 */
import { initialOutcome, installEditorThemeSurface } from "./surface.mjs";

/**
 * @typedef {object} NotifyContext
 * @property {{ notify: (message: string, type?: "info" | "warning" | "error") => void }} ui
 */

/**
 * @typedef {object} ExtensionApiLike
 * @property {(event: "session_start", handler: (event: unknown, ctx: NotifyContext) => void) => void} on
 */

export default function editorThemeCompat(pi) {
	if (initialOutcome !== "unavailable") return;
	pi.on("session_start", (_event, ctx) => {
		if (installEditorThemeSurface() !== "unavailable") return;
		try {
			ctx.ui.notify(
				"editor-theme-compat: @oh-my-pi/pi-tui TUI class unavailable; pi-goal-x dialogs may fail to render",
				"warning",
			);
		} catch {
			// Notification is best-effort; never let the shim break session start.
		}
	});
}
