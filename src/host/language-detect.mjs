const DETECT_LANGUAGES = ["clojure", "javascript", "typescript", "json", "bash", "markdown", "xml", "yaml", "sql"];

const HOST_LANGUAGE = {
	clojure: "clojure",
	javascript: "javascript",
	typescript: "typescript",
	json: "json",
	bash: "bash",
	markdown: "markdown",
	xml: "html",
	yaml: "yaml",
	sql: "sql",
};

export function makeLanguageDetector(hljs) {
	return (text) => {
		if (typeof text !== "string" || text.trim() === "") return null;
		const result = hljs.highlightAuto(text, DETECT_LANGUAGES);
		return HOST_LANGUAGE[result.language] ?? null;
	};
}

export function loadLanguageDetector(require) {
	const hljs = require("highlight.js/lib/core");
	for (const name of DETECT_LANGUAGES) {
		const language = require(`highlight.js/lib/languages/${name}`);
		hljs.registerLanguage(name, language.default ?? language);
	}
	return makeLanguageDetector(hljs);
}
