/** @param {import("./host/imports.mjs").ExtensionAPI} pi */
export default async function bootstrap(pi) {
	const mod = await import("./main.mjs");
	return mod.default(pi);
}
