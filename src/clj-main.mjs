import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as formatter from "@chrisoakman/standard-clojure-style";
import { installRunnerCapture } from "./host/runner-capture.js";

const entryPath = fileURLToPath(import.meta.url.replace(/[?#].*$/, ""));
const require = createRequire(entryPath);
const nbb = require("nbb");
globalThis.__herdRequire = require;
globalThis.__herdEntryPath = entryPath;
globalThis.__herdPluginSrc = dirname(entryPath);
globalThis.__herdNbb = nbb;
nbb.registerModule(formatter, "@chrisoakman/standard-clojure-style");
nbb.addClassPath(globalThis.__herdPluginSrc);
let entryActivate = null;
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
	globalThis.__herdTui = (await import("@oh-my-pi/pi-tui").catch(() => null)) ?? {};
	globalThis.__herdHostExtras = (await import("@oh-my-pi/pi-coding-agent/task/agents").catch(() => null)) ?? {};
	globalThis.__herdHostVersions = {
		hostVersion: codingAgent.VERSION,
		cliVersion: process.env.OMP_VERSION || codingAgent.VERSION,
		runtimePackageVersion: codingAgent.VERSION,
	};
	globalThis.__herdNativeTools = installRunnerCapture(codingAgent.AgentSession);
	await nbb.loadFile(join(globalThis.__herdPluginSrc, "herd", "bootstrap.cljs"));
	entryActivate = await nbb.loadString("(fn [pi] (herd.entry/activate pi))");
}
export default async function activate(pi) {
	if (typeof entryActivate !== "function") throw new Error("Herdchestra entry activate is unavailable");
	return await entryActivate(pi);
}
