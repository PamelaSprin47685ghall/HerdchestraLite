/**
 * Main entry: composes prompts, context projection, pi-context, pi-goal, and
 * manual acceptance into one omp extension.
 *
 * Current state: skeleton only. The factory registers nothing; each domain is
 * added by its own slice, and composition stays here instead of inside the
 * domain modules.
 *
 * Failure isolation: this entry never throws at load time, so a missing or
 * incompatible host leaves only this entry inert; `tool-gate` and
 * `editor-theme` load independently.
 *
 * @param {import("@oh-my-pi/pi-coding-agent").ExtensionAPI} _pi
 */
export default function vibeWorkers(_pi) {}
