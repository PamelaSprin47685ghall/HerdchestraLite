/**
 * Structural validators for the S1-S4 stage documents.
 *
 * Inputs: authored markdown, plus the structured `cases`, `modules`, or `slices`
 * list that the same gate call carries.
 * Output: `{ ok, errors, ... }`. A failure lists every problem that the input
 * makes visible: field name, source line, CASE/module/Slice id, or dependency
 * cycle. The functions are pure: no I/O, no clock, no global state.
 *
 * The stage gate renders these errors as EDN. This module never throws for bad
 * input, so a caller cannot save or promote a document by catching an error.
 *
 * S2 CASE data is the structured `cases` argument. This module never parses,
 * extracts, or compares CASE text from `s2-manual-tests.md`; the Markdown is
 * only a methodology narrative. The frozen `.herd/missions/<slug>/cases.edn`
 * dataset is the sole CASE authority.
 */

const CASE_ID_RE = /^CASE-[A-Za-z0-9_-]+$/;
const SLICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

/** Every CASE dataset must exercise these path categories at least once. */
const REQUIRED_S2_PATHS = ["正常", "错误", "边界", "并发", "恢复"];

/** The exact structured CASE fields accepted by `advance_s2`. */
const CASE_SPEC_FIELDS = Object.freeze(["case_id", "path", "threshold", "steps", "expected", "rubric"]);

/** The eight S1 topics. Only "未决问题" is optional. */
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

/** Topics that the S3 development guide must contain. */
const S3_TOPICS = [
	{
		key: "module-boundaries",
		title: "模块边界",
		keywords: ["模块边界", "模块职责", "模块清单", "模块契约"],
	},
	{
		key: "dependency-graph",
		title: "依赖图",
		keywords: ["依赖图", "依赖 dag", "依赖关系", "依赖方向", "dependency graph", "模块 dag", "dag"],
	},
];

/** Topics that the S4 coordination handbook must contain. */
const S4_TOPICS = [
	{ key: "pseudocode", title: "文学化伪代码", keywords: ["伪代码", "pseudocode", "pseudo-code"] },
	{ key: "safety", title: "Safety", keywords: ["safety"] },
	{ key: "liveness", title: "Liveness", keywords: ["liveness"] },
	{
		key: "merge-order",
		title: "拓扑合并顺序",
		keywords: ["合并顺序", "合并拓扑", "合入顺序", "拓扑合并", "拓扑顺序", "merge order", "merge topology"],
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

function findTopic(scan, keywords, exclude = []) {
	const heading = findHeading(scan, keywords, exclude);
	if (heading) return heading;
	const lowered = lowerAll(keywords);
	const blocked = lowerAll(exclude);
	for (const entry of scan.prose) {
		const text = entry.text.toLowerCase();
		if (!lowered.some((keyword) => text.includes(keyword))) continue;
		if (blocked.some((keyword) => text.includes(keyword))) continue;
		return entry;
	}
	return undefined;
}

function findLine(scan, needle) {
	if (!scan || !isText(needle)) return undefined;
	for (const entry of scan.prose) {
		if (entry.text.includes(needle)) return entry.line;
	}
	return undefined;
}

function collectTopics(scan, topics, field, errors) {
	const sections = [];
	const missing = [];
	for (const topic of topics) {
		const found = findTopic(scan, topic.keywords, topic.exclude);
		if (found) {
			sections.push({ key: topic.key, title: topic.title, line: found.line });
			continue;
		}
		missing.push(topic.key);
		errors.push(
			invalid(
				`${field}: missing ${topic.title} (a heading or line must contain one of: ${topic.keywords.join(", ")})`,
				{
					field,
					section: topic.key,
				},
			),
		);
	}
	return { sections, missing };
}

/**
 * Check the S1 markdown structure against the eight required topics.
 *
 * Inputs: the complete `s1-brainstorm.md` markdown.
 * Output: `{ ok, errors, sections, missing }`. `sections` carries the line of
 * each topic that the document states. `missing` names every absent topic.
 * All eight topics are required; a document with no open questions still needs
 * a `未决问题` section that says so. `summary` and `non_goals` belong to the
 * gate, not to this markdown check.
 */
export function validateS1(markdown) {
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		return failure([invalid("s1 markdown must be a non-empty string", { field: "brainstorm_markdown" })]);
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
				{ field: "brainstorm_markdown", section: section.key },
			),
		);
	}
	return errors.length === 0 ? success({ sections, missing }) : failure(errors, { sections, missing });
}

function caseError(code, message, extra = {}) {
	return invalid(message, { code, ...extra });
}

/**
 * Validate and normalize the structured `advance_s2` CASE dataset.
 *
 * Inputs: the `cases` argument of `advance_s2`.
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
			caseError("CASE_SCHEMA_INVALID", "manual_tests_markdown must be a non-empty methodology narrative", {
				field: "manual_tests_markdown",
			}),
		);
	}
	const normalized = normalizeCaseSpecs(cases);
	if (!normalized.ok) errors.push(...normalized.errors);
	return errors.length === 0 ? success({ cases: normalized.cases }) : failure(errors);
}

function modulePathProblem(path) {
	if (typeof path !== "string" || path.trim().length === 0) return "module path must be a non-empty string";
	if (path.trim() !== path) return "module path must not contain leading or trailing whitespace";
	if (path.startsWith("/")) return "module path must be relative to the repository root, not absolute";
	if (ABSOLUTE_PATH_RE.test(path)) return "module path must be relative to the repository root, not absolute";
	if (path.startsWith("~")) return "module path must be relative to the repository root";
	if (path.includes("\\")) return "module path must use forward slashes";
	const segments = path.split("/");
	if (segments.includes("..")) return "module path must not contain a .. segment";
	if (segments.some((segment) => segment.length === 0 || segment === ".")) {
		return "module path must be a normalized relative path";
	}
	return undefined;
}

function findDependencyCycle(ids, dependenciesOf) {
	const state = new Map();
	const stack = [];
	const visit = (id) => {
		const status = state.get(id);
		if (status === 2) return undefined;
		if (status === 1) {
			const start = stack.indexOf(id);
			return [...stack.slice(start), id];
		}
		state.set(id, 1);
		stack.push(id);
		for (const dependency of dependenciesOf(id)) {
			const cycle = visit(dependency);
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(id, 2);
		return undefined;
	};
	for (const id of ids) {
		const cycle = visit(id);
		if (cycle) return cycle;
	}
	return undefined;
}

function dependencyProblem(module, index) {
	if (module.depends_on === undefined) return undefined;
	if (!Array.isArray(module.depends_on)) return `modules[${index}] depends_on must be an array of module paths`;
	const bad = module.depends_on.find((entry) => !isText(entry));
	if (bad !== undefined) return `modules[${index}] depends_on entries must be non-empty strings`;
	return undefined;
}

function normalizeCaseIdList(caseIds) {
	const errors = [];
	const ids = new Set();
	if (!Array.isArray(caseIds) || caseIds.length === 0) {
		errors.push(
			caseError("CASE_SCHEMA_INVALID", "caseIds must be a non-empty array of frozen case_id values", {
				field: "caseIds",
			}),
		);
		return { ok: false, errors, ids };
	}
	for (const caseId of caseIds) {
		if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `caseIds entry "${String(caseId)}" must match ${CASE_ID_RE.source}`, {
					field: "caseIds",
				}),
			);
			continue;
		}
		if (ids.has(caseId)) {
			errors.push(
				caseError("CASE_DUPLICATE_ID", `caseIds contains duplicate ${caseId}`, { field: "caseIds", case_id: caseId }),
			);
			continue;
		}
		ids.add(caseId);
	}
	return { ok: errors.length === 0, errors, ids };
}

function validateMappedCaseEntries(entries, caseIds, { index, field, label }) {
	const errors = [];
	if (!Array.isArray(entries)) {
		errors.push(
			caseError("CASE_SCHEMA_INVALID", `${label} mapped_cases must be an array of case_id values`, {
				field,
				index,
			}),
		);
		return { errors, mapped: new Set() };
	}
	const local = new Set();
	const mapped = new Set();
	for (const caseId of entries) {
		if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) {
			errors.push(
				caseError(
					"CASE_SCHEMA_INVALID",
					`${label} mapped_cases entry "${String(caseId)}" must match ${CASE_ID_RE.source}`,
					{ field, index },
				),
			);
			continue;
		}
		if (local.has(caseId)) {
			errors.push(
				caseError("CASE_SCHEMA_INVALID", `${label} maps ${caseId} more than once`, { field, index, case_id: caseId }),
			);
			continue;
		}
		local.add(caseId);
		if (!caseIds.has(caseId)) {
			errors.push(
				caseError("MAPPED_CASE_UNKNOWN", `${label} maps unknown CASE ${caseId}`, { field, index, case_id: caseId }),
			);
			continue;
		}
		mapped.add(caseId);
	}
	return { errors, mapped };
}

/**
 * Validate that every frozen `case_id` is mapped by at least one module.
 *
 * Inputs: the full `:s3-modules` array and the frozen CASE id list.
 * Output: `{ ok, errors }`. Unknown ids, duplicate ids inside one module, and
 * uncovered frozen ids are rejected. Module paths and dependencies are checked
 * by `validateS3`; this helper is also used by the S4 precheck to re-verify
 * the frozen module mapping.
 */
export function validateModuleCoverage(modules, caseIds) {
	const ids = normalizeCaseIdList(caseIds);
	if (!ids.ok) return failure(ids.errors);
	if (!Array.isArray(modules) || modules.length === 0) {
		return failure([
			caseError("CASE_SCHEMA_INVALID", "modules must be a non-empty array with mapped_cases", {
				field: "modules",
			}),
		]);
	}
	const errors = [];
	const mapped = new Set();
	for (let index = 0; index < modules.length; index += 1) {
		const module = modules[index];
		if (!isPlainObject(module)) {
			errors.push(caseError("CASE_SCHEMA_INVALID", `modules[${index}] must be an object`, { field: "modules", index }));
			continue;
		}
		const result = validateMappedCaseEntries(module.mapped_cases, ids.ids, {
			index,
			field: "modules.mapped_cases",
			label: `module "${module.path ?? ""}"`,
		});
		errors.push(...result.errors);
		for (const caseId of result.mapped) mapped.add(caseId);
	}
	const missing = [...ids.ids].filter((caseId) => !mapped.has(caseId));
	if (missing.length > 0) {
		errors.push(
			caseError("MAPPED_CASE_MISSING", `frozen CASEs are not mapped by any module: ${missing.join(", ")}`, {
				field: "modules.mapped_cases",
				missing,
			}),
		);
	}
	return errors.length === 0 ? success() : failure(errors);
}

/**
 * Validate the S3 development guide and its module DAG.
 *
 * Inputs: the complete `s3-dev-guide.md` markdown and
 * `[{ path, secret_owned, depends_on, mapped_cases }]`, plus the frozen CASE
 * ids.
 * Output: `{ ok, errors, sections, missing }`. Module paths must be unique,
 * normalized, relative, free of `..`, and backed by a non-empty
 * `secret_owned`. Every dependency must name a declared module. The graph must
 * be acyclic; a cycle returns its full path. `mapped_cases` may be empty per
 * module, but their union must cover every frozen CASE; unknown ids and
 * duplicates are rejected. The markdown is checked only for module boundaries
 * and the dependency graph; CASE mapping lives in structured `modules`, not in
 * a required Markdown table or heading.
 */
export function validateS3(markdown, modules, caseIds) {
	const errors = [];
	let scan;
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		errors.push(invalid("s3 markdown must be a non-empty string", { field: "dev_guide_markdown" }));
	} else {
		scan = scanMarkdown(markdown);
	}
	let sections = [];
	let missing = [];
	if (scan) {
		const topics = collectTopics(scan, S3_TOPICS, "s3 markdown", errors);
		sections = topics.sections;
		missing = topics.missing;
	}
	if (!Array.isArray(modules) || modules.length === 0) {
		errors.push(
			invalid("s3 modules must be a non-empty array of {path, secret_owned, depends_on}", { field: "modules" }),
		);
	} else {
		const declared = new Map();
		const allowedModuleFields = new Set(["path", "secret_owned", "depends_on", "mapped_cases"]);
		const idCheck = normalizeCaseIdList(caseIds);
		errors.push(...idCheck.errors);
		for (let index = 0; index < modules.length; index += 1) {
			const module = modules[index];
			if (typeof module !== "object" || module === null) {
				errors.push(invalid(`s3 modules[${index}] must be an object`, { field: "modules", index }));
				continue;
			}
			for (const key of Object.keys(module)) {
				if (allowedModuleFields.has(key)) continue;
				errors.push(
					invalid(`s3 modules[${index}].${key} is not an allowed module field`, {
						field: `modules.${key}`,
						index,
						module: typeof module.path === "string" ? module.path : undefined,
					}),
				);
			}
			const problem = modulePathProblem(module.path);
			if (problem) {
				errors.push(
					invalid(`s3 modules[${index}]: ${problem}`, {
						field: "modules.path",
						index,
						module: typeof module.path === "string" ? module.path : undefined,
					}),
				);
			} else if (declared.has(module.path)) {
				errors.push(
					invalid(
						`s3 modules[${index}]: duplicate module path "${module.path}" (first declared at index ${declared.get(module.path)})`,
						{ field: "modules.path", module: module.path, line: findLine(scan, module.path) },
					),
				);
			} else {
				declared.set(module.path, index);
			}
			if (!isText(module.secret_owned)) {
				errors.push(
					invalid(`s3 modules[${index}] "${module.path ?? ""}" must declare a non-empty secret_owned`, {
						field: "modules.secret_owned",
						index,
						module: typeof module.path === "string" ? module.path : undefined,
						line: findLine(scan, module.path),
					}),
				);
			}
			const dependencyIssue = dependencyProblem(module, index);
			if (dependencyIssue) {
				errors.push(
					invalid(`s3 ${dependencyIssue}`, {
						field: "modules.depends_on",
						index,
						module: typeof module.path === "string" ? module.path : undefined,
						line: findLine(scan, module.path),
					}),
				);
			}
		}
		for (let index = 0; index < modules.length; index += 1) {
			const module = modules[index];
			if (typeof module !== "object" || module === null || !Array.isArray(module.depends_on)) continue;
			for (const dependency of module.depends_on) {
				if (typeof dependency !== "string" || dependency.length === 0) continue;
				if (declared.has(dependency)) continue;
				errors.push(
					invalid(`s3 module "${module.path ?? ""}" depends_on undeclared module "${dependency}"`, {
						field: "modules.depends_on",
						module: typeof module.path === "string" ? module.path : undefined,
						dependency,
						line: findLine(scan, module.path),
					}),
				);
			}
		}
		const ids = [...declared.keys()];
		const dependenciesOf = (id) => {
			const module = modules[declared.get(id)];
			if (typeof module !== "object" || module === null || !Array.isArray(module.depends_on)) return [];
			return module.depends_on.filter((dependency) => typeof dependency === "string" && declared.has(dependency));
		};
		const cycle = findDependencyCycle(ids, dependenciesOf);
		if (cycle) {
			errors.push(
				invalid(`s3 modules: dependency cycle ${cycle.join(" -> ")}`, {
					field: "modules.depends_on",
					cycle,
				}),
			);
		}
		if (idCheck.ok) {
			const coverage = validateModuleCoverage(modules, caseIds);
			if (!coverage.ok) errors.push(...coverage.errors);
		}
	}
	return errors.length === 0 ? success({ sections, missing }) : failure(errors, { sections, missing });
}

function sliceIdProblem(sliceId) {
	if (typeof sliceId !== "string" || sliceId.length === 0) return "slice_id must be a non-empty string";
	if (!SLICE_ID_RE.test(sliceId)) {
		return "slice_id must be 1-64 letters, digits, underscores, or hyphens, starting with a letter or digit";
	}
	return undefined;
}

function nonEmptyInputs(value) {
	if (isText(value)) return true;
	return Array.isArray(value) && value.length > 0 && value.every((entry) => isText(entry));
}

/**
 * Validate the S4 coordination handbook and its Slice DAG.
 *
 * Inputs: the complete `s4-coordination.md` markdown,
 * `[{ slice_id, goal, inputs, depends_on, done_when, mapped_cases }]`, and the
 * S2 CASE ids.
 * Output: `{ ok, errors, sections, missing }`. Slice ids must be unique and
 * legal as branch path segments. Every dependency must name a
 * declared Slice, and the graph must be acyclic. The union of `mapped_cases`
 * must equal the S2 CASE set exactly: no missing, extra, unknown, or duplicate
 * case id. Each Slice needs non-empty `goal`, `inputs`, and `done_when`. The
 * markdown must contain literate pseudocode, Safety, Liveness, and a
 * topological merge order.
 */
export function validateS4(markdown, slices, caseIds) {
	const errors = [];
	let scan;
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		errors.push(invalid("s4 markdown must be a non-empty string", { field: "coordination_markdown" }));
	} else {
		scan = scanMarkdown(markdown);
	}
	let sections = [];
	let missing = [];
	if (scan) {
		const topics = collectTopics(scan, S4_TOPICS, "s4 markdown", errors);
		sections = topics.sections;
		missing = topics.missing;
	}

	const idCheck = normalizeCaseIdList(caseIds);
	errors.push(...idCheck.errors);
	const expectedCases = idCheck.ids;

	if (!Array.isArray(slices) || slices.length === 0) {
		errors.push(
			invalid("s4 slices must be a non-empty array of {slice_id, goal, inputs, depends_on, done_when, mapped_cases}", {
				field: "slices",
			}),
		);
	} else {
		const declared = new Map();
		const mapped = new Set();
		for (let index = 0; index < slices.length; index += 1) {
			const slice = slices[index];
			if (typeof slice !== "object" || slice === null) {
				errors.push(invalid(`s4 slices[${index}] must be an object`, { field: "slices", index }));
				continue;
			}
			const sliceId = typeof slice.slice_id === "string" ? slice.slice_id : undefined;
			const problem = sliceIdProblem(slice.slice_id);
			if (problem) {
				errors.push(invalid(`s4 slices[${index}]: ${problem}`, { field: "slices.slice_id", index, slice: sliceId }));
			} else if (declared.has(slice.slice_id)) {
				errors.push(
					invalid(
						`s4 slices[${index}]: duplicate slice_id "${slice.slice_id}" (first declared at index ${declared.get(slice.slice_id)})`,
						{ field: "slices.slice_id", slice: slice.slice_id, line: findLine(scan, slice.slice_id) },
					),
				);
			} else {
				declared.set(slice.slice_id, index);
			}
			if (!isText(slice.goal)) {
				errors.push(
					invalid(`s4 slice "${sliceId ?? ""}" must declare a non-empty goal`, {
						field: "slices.goal",
						index,
						slice: sliceId,
						line: findLine(scan, sliceId),
					}),
				);
			}
			if (!nonEmptyInputs(slice.inputs)) {
				errors.push(
					invalid(`s4 slice "${sliceId ?? ""}" must declare non-empty inputs`, {
						field: "slices.inputs",
						index,
						slice: sliceId,
						line: findLine(scan, sliceId),
					}),
				);
			}
			if (!isText(slice.done_when)) {
				errors.push(
					invalid(`s4 slice "${sliceId ?? ""}" must declare a non-empty done_when`, {
						field: "slices.done_when",
						index,
						slice: sliceId,
						line: findLine(scan, sliceId),
					}),
				);
			}
			const mapping = validateMappedCaseEntries(slice.mapped_cases, expectedCases, {
				index,
				field: "slices.mapped_cases",
				label: `slice "${sliceId ?? ""}"`,
			});
			errors.push(...mapping.errors);
			for (const caseId of mapping.mapped) mapped.add(caseId);
			if (slice.depends_on !== undefined && !Array.isArray(slice.depends_on)) {
				errors.push(
					invalid(`s4 slice "${sliceId ?? ""}" depends_on must be an array of slice ids`, {
						field: "slices.depends_on",
						index,
						slice: sliceId,
					}),
				);
			} else if (Array.isArray(slice.depends_on)) {
				for (const dependency of slice.depends_on) {
					if (isText(dependency)) continue;
					errors.push(
						invalid(`s4 slice "${sliceId ?? ""}" depends_on entries must be non-empty strings`, {
							field: "slices.depends_on",
							index,
							slice: sliceId,
						}),
					);
				}
			}
		}
		for (let index = 0; index < slices.length; index += 1) {
			const slice = slices[index];
			if (typeof slice !== "object" || slice === null || !Array.isArray(slice.depends_on)) continue;
			for (const dependency of slice.depends_on) {
				if (typeof dependency !== "string" || dependency.length === 0) continue;
				if (declared.has(dependency)) continue;
				errors.push(
					invalid(`s4 slice "${slice.slice_id ?? ""}" depends_on undeclared slice "${dependency}"`, {
						field: "slices.depends_on",
						slice: typeof slice.slice_id === "string" ? slice.slice_id : undefined,
						dependency,
						line: findLine(scan, slice.slice_id),
					}),
				);
			}
		}
		const ids = [...declared.keys()];
		const dependenciesOf = (id) => {
			const slice = slices[declared.get(id)];
			if (typeof slice !== "object" || slice === null || !Array.isArray(slice.depends_on)) return [];
			return slice.depends_on.filter((dependency) => typeof dependency === "string" && declared.has(dependency));
		};
		const cycle = findDependencyCycle(ids, dependenciesOf);
		if (cycle) {
			errors.push(
				invalid(`s4 slices: dependency cycle ${cycle.join(" -> ")}`, {
					field: "slices.depends_on",
					cycle,
				}),
			);
		}
		if (expectedCases.size > 0) {
			const uncovered = [...expectedCases].filter((caseId) => !mapped.has(caseId));
			if (uncovered.length > 0) {
				errors.push(
					caseError("MAPPED_CASE_MISSING", `s4 slices: mapped_cases does not cover S2 CASEs: ${uncovered.join(", ")}`, {
						field: "slices.mapped_cases",
						missing: uncovered,
					}),
				);
			}
		}
	}
	return errors.length === 0 ? success({ sections, missing }) : failure(errors, { sections, missing });
}
