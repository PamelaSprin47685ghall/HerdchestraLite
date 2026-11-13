/**
 * Deterministic EDN + UFSS printer.
 *
 * The writer picks the smallest raw fence that cannot be closed by the body,
 * so the reader and printer form a bijection. Text that cannot live in a raw
 * fence (control characters) falls back to a standard escaped string.
 */

import { herdError } from "../util/errors.mjs";
import { EdnKeyword, EdnList, EdnSymbol } from "./edn-value.mjs";

const TAB = 0x09;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

function hasInvisibleControl(text) {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 32 && code !== TAB && code !== NEWLINE) {
			return true;
		}
	}
	return false;
}

function hasTripleQuote(text) {
	return text.includes('"""');
}

function multiLineCanUseBareFence(text) {
	if (hasTripleQuote(text) || text.includes("\\")) {
		return false;
	}
	return !text.split("\n").some((line) => line.startsWith('"""'));
}

function maxHashRunAfterQuotes(text, quoteCount) {
	let maximum = 0;
	let index = 0;

	while (index < text.length) {
		if (text[index] !== '"') {
			index += 1;
			continue;
		}

		const start = index;
		while (index < text.length && text[index] === '"') {
			index += 1;
		}
		if (index - start < quoteCount) {
			continue;
		}

		let hashes = 0;
		while (text[index + hashes] === "#") {
			hashes += 1;
		}
		if (hashes > maximum) {
			maximum = hashes;
		}
	}

	return maximum;
}

function smallestSingleFence(text) {
	return maxHashRunAfterQuotes(text, 1) + 1;
}

function smallestMultiFence(text) {
	return maxHashRunAfterQuotes(text, 3) + 1;
}

export function escapeStandardString(text) {
	let output = '"';
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		switch (code) {
			case QUOTE:
				output += '\\"';
				break;
			case BACKSLASH:
				output += "\\\\";
				break;
			case 0x08:
				output += "\\b";
				break;
			case TAB:
				output += "\\t";
				break;
			case NEWLINE:
				output += "\\n";
				break;
			case 0x0c:
				output += "\\f";
				break;
			case CARRIAGE_RETURN:
				output += "\\r";
				break;
			default:
				if (code < 32) {
					output += `\\u${code.toString(16).padStart(4, "0")}`;
				} else {
					output += text[index];
				}
		}
	}
	return `${output}"`;
}

function formatString(text, indent) {
	if (hasInvisibleControl(text)) {
		return escapeStandardString(text);
	}

	if (!text.includes("\n")) {
		if (!text.includes('"') && !text.includes("\\")) {
			return `"${text}"`;
		}
		const fence = "#".repeat(smallestSingleFence(text));
		return `${fence}"${text}"${fence}`;
	}

	const fence = multiLineCanUseBareFence(text) ? "" : "#".repeat(smallestMultiFence(text));
	const prefix = " ".repeat(indent);
	const body = text
		.split("\n")
		.map((line) => (line === "" ? "" : prefix + line))
		.join("\n");
	return `${fence}"""\n${body}\n${prefix}"""${fence}`;
}

function formatCollection(open, close, values, indent) {
	if (values.length === 0) {
		return `${open}${close}`;
	}

	const childIndent = indent + 1;
	const prefix = " ".repeat(childIndent);
	const parts = values.map((value) => formatValue(value, childIndent));
	if (parts.every((part) => !part.includes("\n"))) {
		return `${open}${parts.join(" ")}${close}`;
	}
	return `${open}\n${parts.map((part) => prefix + part).join("\n")}\n${" ".repeat(indent)}${close}`;
}

function formatMap(value, indent) {
	if (value.size === 0) {
		return "{}";
	}

	const entryIndent = indent + 1;
	const prefix = " ".repeat(entryIndent);
	const entries = [];
	for (const [key, entryValue] of value) {
		const keyText = formatValue(key, entryIndent);
		const valueText = formatValue(entryValue, entryIndent);
		const separator = keyText.includes("\n") ? `\n${prefix}` : " ";
		entries.push(`${prefix}${keyText}${separator}${valueText}`);
	}
	return `{\n${entries.join("\n")}\n${" ".repeat(indent)}}`;
}

function formatValue(value, indent) {
	if (value === null) {
		return "nil";
	}
	if (value === true || value === false) {
		return String(value);
	}
	if (typeof value === "string") {
		return formatString(value, indent);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw invalidValue("Numbers must be finite EDN numbers", value);
		}
		if (Object.is(value, -0)) {
			return "-0";
		}
		if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
			return value.toExponential();
		}
		return String(value);
	}
	if (typeof value === "bigint") {
		return `${value}N`;
	}
	if (value instanceof EdnKeyword || value instanceof EdnSymbol) {
		return value.toString();
	}
	if (value instanceof EdnList) {
		return formatCollection("(", ")", value, indent);
	}
	if (Array.isArray(value)) {
		return formatCollection("[", "]", value, indent);
	}
	if (value instanceof Set) {
		return formatCollection("#{", "}", [...value], indent);
	}
	if (value instanceof Map) {
		return formatMap(value, indent);
	}
	throw invalidValue("Value cannot be printed as EDN", value);
}

function invalidValue(message, value) {
	const type = value === null ? "null" : typeof value;
	return herdError("INVALID_ARGUMENT", `${message}: ${type}`, { type });
}

/** Print a value as deterministic EDN + UFSS. */
export function printUfss(value, options = {}) {
	const indent = options.indent ?? 0;
	if (!Number.isInteger(indent) || indent < 0) {
		throw herdError("INVALID_ARGUMENT", "printUfss indent must be a non-negative integer", { indent });
	}
	return formatValue(value, indent);
}

/** Print a tool receipt: deterministic EDN + UFSS followed by one newline. */
export function renderReceipt(value) {
	return `${printUfss(value)}\n`;
}
