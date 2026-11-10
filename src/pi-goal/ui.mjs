/**
 * pi-goal-x expects `ui.setWorkingVisible`, but omp's extension UI does not
 * have it. `goalUi` supplies a no-op for that one method and leaves every other
 * property untouched.
 *
 * Inputs: the host extension UI.
 * Output: the same UI when it already supports the method; otherwise a Proxy.
 * Old location: vibe-workers.ts goalUi and sleep, VW 1915-1932.
 * No fallback: a non-object UI is returned unchanged.
 */

/**
 * pi-goal-x pauses the working spinner; omp's extension UI has no such method.
 * @param {object} ui
 * @returns {object}
 */
export function goalUi(ui) {
	if (!ui || typeof ui !== "object") return ui;
	if ("setWorkingVisible" in ui && typeof ui.setWorkingVisible === "function") return ui;
	return new Proxy(ui, {
		get(target, property) {
			if (property === "setWorkingVisible") return () => {};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
	const { promise, resolve } = Promise.withResolvers();
	setTimeout(resolve, ms);
	return promise;
}
