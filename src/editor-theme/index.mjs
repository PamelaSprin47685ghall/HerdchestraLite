/**
 * Editor-theme entry: keeps pi-goal-x dialogs renderable on a host whose TUI
 * theme surface differs from the one the dialogs expect.
 *
 * Current state: skeleton only. The factory does nothing; the prototype surface
 * and its retry on `session_start` arrive in the editor-theme slice.
 *
 * Failure isolation: this entry never throws at load time; without it the other
 * two entries still load and only dialog rendering degrades.
 *
 * @param {import("@oh-my-pi/pi-coding-agent").ExtensionAPI} _pi
 */
export default function editorThemeCompat(_pi) {}
