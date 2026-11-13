import * as nbb from "nbb";
import { fileURLToPath } from "node:url";
import { installRunnerCapture, getNativeRunner } from "./host/native-runner.mjs";

export default async function (pi) {
	globalThis.__pi = pi;
	try {
		await installRunnerCapture();
		globalThis.__herdNative = { getRunner: getNativeRunner };
	} catch {
		globalThis.__herdNative = null;
	}
	nbb.addClassPath(fileURLToPath(new URL("./", import.meta.url)));
	await nbb.loadFile(fileURLToPath(new URL("./herd/bootstrap.cljs", import.meta.url)));
}
