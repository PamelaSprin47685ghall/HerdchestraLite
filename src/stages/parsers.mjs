/**
 * Structural validators for the S1-S4 stage documents.
 *
 * Inputs: authored markdown, plus the structured `cases` list that the S2
 * attach call carries and the required `promela` text for S4.
 * Output: `{ ok, errors, ... }`. A failure lists every problem that the input
 * makes visible: field name, source line, or CASE id. The functions are pure:
 * no I/O, no clock, no global state.
 *
 * The attach gates render these errors as EDN. This module never throws for
 * bad input, so a caller cannot save or promote a document by catching an
 * error.
 *
 * S2 CASE data is the structured `cases` argument. This module never parses,
 * extracts, or compares CASE text from `s2-manual-tests.md`; the Markdown is
 * only a methodology narrative. The `.herd/missions/<slug>/s2-cases.edn`
 * dataset is the sole CASE authority.
 *
 * S3 is prose: content organization is entirely the author's choice, so only
 * non-emptiness is checked. S4 does not parse Promela at all; the model text
 * is stored and observed, never run through Spin or a model checker.
 */

const CASE_ID_RE = /^CASE-[A-Za-z0-9_-]+$/;

/** Every CASE dataset must exercise these path categories at least once. */
const REQUIRED_S2_PATHS = ["正常", "错误", "边界", "并发", "恢复"];

/** The exact structured CASE fields accepted by `attach_manual_tests`. */
const CASE_SPEC_FIELDS = Object.freeze(["case_id", "path", "threshold", "steps", "expected", "rubric"]);

/** All eight S1 topics are required; 未决问题 may say 无. */
const S1_SECTIONS = [
	{
		key: "goal",
		title: "一句话目标与用户可见结果",
		required: true,
		keywords: ["一句话目标", "用户可见结果", "目标与用户", "目标"],
		exclude: ["非目标", "non-goal", "non goal", "不做"],
	},
	{ key: "decision-framework", title: "决策框架", required: true, keywords: ["决策框架"] },
	{ key: "current-state", title: "现状事实与根因", required: true, keywords: ["现状", "根因"] },
	{
		key: "doors",
		title: "单向门/双向门",
		required: true,
		keywords: ["单向门", "双向门", "one-way", "two-way"],
	},
	{
		key: "pre-mortem",
		title: "事前验尸",
		required: true,
		keywords: ["事前验尸", "pre-mortem", "premortem", "pre mortem"],
	},
	{
		key: "non-goals",
		title: "Non-Goals",
		required: true,
		keywords: ["non-goals", "non goals", "非目标", "out of scope"],
	},
	{
		key: "success",
		title: "成功标准",
		required: true,
		keywords: ["成功标准", "完成标准", "什么叫完成", "definition of done"],
	},
	{
		key: "open-questions",
		title: "未决问题",
		required: true,
		keywords: ["未决问题", "开放问题", "open questions"],
	},
];

function invalid(message, extra = {}) {
	return { code: "INVALID_ARGUMENT", message, ...extra };
}

function failure(errors, extra = {}) {
	return { ok: false, errors, ...extra };
}

function success(extra = {}) {
	return { ok: true, errors: [], ...extra };
}

function isText(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function lowerAll(keywords) {
	return keywords.map((keyword) => keyword.toLowerCase());
}

/**
 * Split markdown into lines, headings, and non-fenced prose.
 *
 * Inputs: one markdown string.
 * Output: `{ headings, prose }`, with 1-based `line` fields. Fenced code never
 * reaches either list, so a fenced `### CASE-*` can neither open a CASE nor
 * satisfy a section check.
 */
function scanMarkdown(markdown) {
	const headings = [];
	const prose = [];
	const lines = markdown.split(/\r?\n/);
	let fence;
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		if (fence) {
			const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
			if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
				fence = undefined;
			}
			continue;
		}
		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
		if (opening) {
			fence = { char: opening[1][0], length: opening[1].length };
			continue;
		}
		prose.push({ text: raw, line: index + 1 });
		const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(raw);
		if (!heading) continue;
		const text = heading[2].trim().replace(/[ \t]+#+[ \t]*$/, "");
		if (text.length > 0) headings.push({ level: heading[1].length, text, line: index + 1 });
	}
	return { headings, prose };
}

function findHeading(scan, keywords, exclude = []) {
	const lowered = lowerAll(keywords);
	const blocked = lowerAll(exclude);
	for (const heading of scan.headings) {
		const text = heading.text.toLowerCase();
		if (!lowered.some((keyword) => text.includes(keyword))) continue;
		if (blocked.some((keyword) => text.includes(keyword))) continue;
		return heading;
	}
	return undefined;
}

/**
 * Check the S1 markdown structure against the eight required topics.
 *
 * Inputs: the complete `s1-brainstorm.md` markdown.
 * Output: `{ ok, errors, sections, missing }`. `sections` carries the line of
 * each topic that the document states. `missing` names every absent topic.
 * All eight topics are required; a document with no open questions still needs
 * a `未决问题` section that says so. There are no `summary` or `non_goals`
 * arguments: the markdown itself carries the whole brainstorm.
 */
export function validateS1(markdown) {
	if (!isText(markdown)) {
		return failure([invalid("s1 markdown must be a non-empty string", { field: "markdown" })]);
	}
	const scan = scanMarkdown(markdown);
	const sections = [];
	const missing = [];
	const errors = [];
	for (const section of S1_SECTIONS) {
		const heading = findHeading(scan, section.keywords, section.exclude);
		if (heading) {
			sections.push({ key: section.key, title: section.title, line: heading.line });
			continue;
		}
		missing.push({ key: section.key, title: section.title, required: section.required });
		errors.push(
			invalid(
				`s1 markdown: missing section "${section.title}" (a heading must contain one of: ${section.keywords.join(", ")})`,
				{ field: "markdown", section: section.key },
			),
		);
	}
	return errors.length === 0 ? success({ sections, missing }) : failure(errors, { sections, missing });
}

function caseError(code, message, extra = {}) {
	return invalid(message, { code, ...extra });
}

/**
 * Validate and normalize the structured `attach_manual_tests` CASE dataset.
 *
 * Inputs: the `cases` argument of `attach_manual_tests`.
 * Output: `{ ok:true, cases }` or `{ ok:false, errors }`. Each item must
 * contain exactly `case_id`, `path`, `threshold`, `steps`, `expected`, and
 * `rubric`; unknown fields are rejected. IDs are unique and match `CASE-*`;
 * thresholds are finite numbers in 0..100; steps are a non-empty string array;
 * expected and rubric are non-empty strings. The dataset must cover 正常,
 * 错误, 边界, 并发, and 恢复 at least once. No Markdown is read.
 */
export function normalizeCaseSpecs(cases) {
	if (!Array.isArray(cases) || cases.length === 0) {
		return failure([caseError("CASE_SCHEMA_INVALID", "cases must be a non-empty array", { field: "cases" })]);
	}
	const allowed = new Set(CASE_SPEC_FIELDS);
	const errors = [];
	const normalized = [];
	const seen = new Set();
	for (let index = 0; index < cases.length; index += 1) {
		const entry = cases[index];
		if (!isPlainObject(entry)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `cases[${index}] must be an object`, {
					field: `cases[${index}]`,
					index,
				}),
			);
			continue;
		}
		for (const key of Object.keys(entry)) {
			if (allowed.has(key)) continue;
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `cases[${index}].${key} is not an allowed CASE field`, {
					field: `cases[${index}].${key}`,
					index,
				}),
			);
		}
		const caseId = entry.case_id;
		let valid = true;
		if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `cases[${index}].case_id must match ${CASE_ID_RE.source}`, {
					field: `cases[${index}].case_id`,
					index,
				}),
			);
			valid = false;
		} else if (seen.has(caseId)) {
			errors.push(
				caseError("CASE_DUPLICATE_ID", `cases[${index}].case_id ${caseId} is duplicated`, {
					field: `cases[${index}].case_id`,
					index,
					case_id: caseId,
				}),
			);
			valid = false;
		} else {
			seen.add(caseId);
		}
		if (!isText(entry.path)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `cases[${index}].path must be a non-empty string`, {
					field: `cases[${index}].path`,
					index,
				}),
			);
			valid = false;
		}
		if (
			typeof entry.threshold !== "number" ||
			!Number.isFinite(entry.threshold) ||
			entry.threshold < 0 ||
			entry.threshold > 100
		) {
			errors.push(
				caseError("CASE_THRESHOLD_INVALID", `cases[${index}].threshold must be a finite number in 0..100`, {
					field: `cases[${index}].threshold`,
					index,
				}),
			);
			valid = false;
		}
		if (!Array.isArray(entry.steps) || entry.steps.length === 0 || !entry.steps.every(isText)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `cases[${index}].steps must be a non-empty array of non-empty strings`, {
					field: `cases[${index}].steps`,
					index,
				}),
			);
			valid = false;
		}
		if (!isText(entry.expected)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `cases[${index}].expected must be a non-empty string`, {
					field: `cases[${index}].expected`,
					index,
				}),
			);
			valid = false;
		}
		if (!isText(entry.rubric)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `cases[${index}].rubric must be a non-empty string`, {
					field: `cases[${index}].rubric`,
					index,
				}),
			);
			valid = false;
		}
		if (!valid) continue;
		normalized.push({
			case_id: caseId,
			path: entry.path.trim(),
			threshold: entry.threshold,
			steps: [...entry.steps],
			expected: entry.expected,
			rubric: entry.rubric,
		});
	}
	if (normalized.length > 0) {
		const paths = new Set(normalized.map((entry) => entry.path));
		const missing = REQUIRED_S2_PATHS.filter((category) => !paths.has(category));
		if (missing.length > 0) {
			const received = [...paths];
			errors.push(
				caseError(
					"CASE_REQUIRED_PATH_MISSING",
					`cases[].path must cover the five category labels: ${REQUIRED_S2_PATHS.join(", ")}; missing: ${missing.join(", ")}`,
					{
						field: "cases[].path",
						required: [...REQUIRED_S2_PATHS],
						missing,
						received,
						next: `add at least one CASE with path exactly one of: ${missing.join(", ")}; path is a category label, not a filesystem path`,
					},
				),
			);
		}
	}
	return errors.length === 0 ? success({ cases: normalized }) : failure(errors);
}

/**
 * Validate the S2 methodology markdown and structured CASE dataset.
 *
 * Inputs: `s2-manual-tests.md` and the structured `cases` argument.
 * Output: `{ ok, errors, cases? }`. The Markdown is checked only for
 * non-emptiness; CASE text in it has no authority. The cases are validated by
 * `normalizeCaseSpecs`.
 */
export function validateS2(markdown, cases) {
	const errors = [];
	if (!isText(markdown)) {
		errors.push(
			caseError("CASE_SCHEMA_INVALID", "markdown must be a non-empty methodology narrative", {
				field: "markdown",
			}),
		);
	}
	const normalized = normalizeCaseSpecs(cases);
	if (!normalized.ok) errors.push(...normalized.errors);
	return errors.length === 0 ? success({ cases: normalized.cases }) : failure(errors);
}

/**
 * Validate the S3 development guide markdown.
 *
 * Inputs: the complete `s3-dev-guide.md` markdown.
 * Output: `{ ok, errors }`. The guide is prose; its organization is entirely
 * the author's choice. Only a non-empty markdown is required. There is no
 * `modules` array, no mapped-CASE gate, and no dependency-graph check.
 */
export function validateS3(markdown) {
	if (!isText(markdown)) {
		return failure([invalid("s3 markdown must be a non-empty string", { field: "markdown" })]);
	}
	return success();
}

/**
 * Validate the S4 coordination handbook and its Promela model text.
 *
 * Inputs: the complete `s4-coordination.md` markdown and the required
 * `promela` text.
 * Output: `{ ok, errors }`. Both must be non-empty strings. The Promela is
 * never parsed, run, or model-checked; it is stored as text, and a comment may
 * carry Knuth-style pseudocode when Promela is insufficient. There are no
 * Slices, no Slice DAG, and no mapped-CASE gate.
 */
export function validateS4(markdown, promela) {
	const errors = [];
	if (!isText(markdown)) {
		errors.push(invalid("s4 markdown must be a non-empty string", { field: "markdown" }));
	}
	if (!isText(promela)) {
		errors.push(invalid("s4 promela must be a non-empty string", { field: "promela" }));
	}
	return errors.length === 0 ? success() : failure(errors);
}