import * as nbb from "nbb";
import { fileURLToPath } from "node:url";

export async function activate(pi) {
	globalThis.__pi = pi;
	const src = fileURLToPath(new URL("./", import.meta.url));
	nbb.addClassPath(src);
	await nbb.loadFile(fileURLToPath(new URL("./herd/main.cljs", import.meta.url)));
}
