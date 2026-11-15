import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as formatter from "@chrisoakman/standard-clojure-style";
import * as nbb from "nbb";

globalThis.__herdRequire = createRequire(import.meta.url);
globalThis.__herdEntryPath = fileURLToPath(import.meta.url);
globalThis.__herdPluginSrc = dirname(fileURLToPath(import.meta.url));
globalThis.__herdNbb = nbb;
nbb.registerModule(formatter, "@chrisoakman/standard-clojure-style");
nbb.addClassPath(globalThis.__herdPluginSrc);
let activate = null;
const daemonIndex = process.argv.indexOf("--daemon-b64");
if (daemonIndex >= 0 && process.argv[daemonIndex + 1]) {
	const endpoint = Buffer.from(process.argv[daemonIndex + 1], "base64").toString("utf8");
	const start = await nbb.loadString(
		"(require '[herd.lock-daemon :as l]) (fn [options] (l/start-lock-daemon options))",
	);
	await start({
		endpoint,
		onReady: (status) => {
			process.stdout.write(`${status}\n`);
			if (status !== "READY") process.exit(0);
		},
	});
} else {
	const codingAgent = await import("@oh-my-pi/pi-coding-agent");
	globalThis.__herdCodingAgent = codingAgent;
	try {
		globalThis.__herdTui = await import("@oh-my-pi/pi-tui");
	} catch {
		globalThis.__herdTui = {};
	}
	try {
		globalThis.__herdHostExtras = await import("@oh-my-pi/pi-coding-agent/task/agents");
	} catch {
		globalThis.__herdHostExtras = {};
	}
	globalThis.__herdHostVersions = {
		hostVersion: codingAgent.VERSION,
		cliVersion: process.env.OMP_VERSION || codingAgent.VERSION,
		runtimePackageVersion: codingAgent.VERSION,
	};
	try {
		globalThis.__herdRunnerModule = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner");
	} catch {
		globalThis.__herdRunnerModule = null;
	}
	await nbb.loadFile(join(globalThis.__herdPluginSrc, "herd", "bootstrap.cljs"));
	activate = await nbb.loadString("herd.entry/activate");
}
export default activate;
