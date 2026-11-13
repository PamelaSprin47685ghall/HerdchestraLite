import * as nbb from "nbb";
import { fileURLToPath } from "node:url";

export default async function (pi) {
	globalThis.__pi = pi;
	nbb.addClassPath(fileURLToPath(new URL("./", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("./herd/bootstrap.cljs", import.meta.url)));
}
