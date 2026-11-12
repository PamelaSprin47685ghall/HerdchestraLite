import { herdError } from "../util/errors.mjs";

export const BEACON_TOOL_SCOLD =
	"FORBIDDEN! You are a read-only sealed Beacon. Calling tools is strictly prohibited here! Do NOT call any tool. Answer the user's question in plain text IMMEDIATELY or this query will fail.";

export function buildBeaconQueryPrompt(beacon, question) {
	return [
		"[READ-ONLY BEACON QUERY — TOOLS FORBIDDEN]",
		`你是已封存的只读记忆灯塔（Beacon: ${beacon.name}）。现在只需要你直接回答下面的问题。`,
		"【铁律】严禁调用任何工具！不要调用 clj_*、wait、time_leap、ask_beacon 或任何其他工具。",
		"请立刻用纯文本给出准确、具体、简洁的答案：",
		"",
		question,
	].join("\n");
}

function extractText(assistantMessage) {
	const blocks = Array.isArray(assistantMessage?.content) ? assistantMessage.content : [];
	return blocks
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("")
		.trim();
}

function extractToolCalls(assistantMessage) {
	const blocks = Array.isArray(assistantMessage?.content) ? assistantMessage.content : [];
	return blocks.filter((b) => b && b.type === "toolCall");
}

export async function queryBeacon({ beacon, question, model, apiKey, systemPrompt, complete, signal }) {
	if (!beacon) {
		throw herdError("PROGRAM_UNKNOWN", "Beacon not found");
	}
	if (typeof question !== "string" || question.trim().length === 0) {
		throw herdError("INVALID_ARGUMENT", "ask_beacon requires a non-empty question string", { field: "question" });
	}
	if (!Array.isArray(beacon.messagesSnapshot) || beacon.messagesSnapshot.length === 0) {
		throw herdError("INVALID_ARGUMENT", `Beacon ${beacon.name} has no cached message snapshot to query`, {
			target: beacon.name,
		});
	}
	if (!model) {
		throw herdError("HOST_API_MISMATCH", "No active model available to query Beacon");
	}
	if (typeof complete !== "function") {
		throw herdError("HOST_API_MISMATCH", "completeSimple is unavailable to query Beacon");
	}

	const messages = [
		...beacon.messagesSnapshot,
		{
			role: "user",
			content: [{ type: "text", text: buildBeaconQueryPrompt(beacon, question.trim()) }],
			timestamp: Date.now(),
		},
	];

	const callOnce = async (msgs) => {
		const res = await complete(
			model,
			{
				...(systemPrompt !== undefined ? { systemPrompt } : {}),
				messages: msgs,
			},
			{
				...(apiKey !== undefined ? { apiKey } : {}),
				disableReasoning: true,
				maxTokens: 1024,
				...(signal ? { signal } : {}),
			},
		);
		if (res?.stopReason === "aborted") {
			throw herdError("UPSTREAM_ABORTED", "Beacon query was aborted");
		}
		if (res?.stopReason === "error") {
			throw herdError("HOST_API_MISMATCH", res?.errorMessage ?? "Beacon query failed at provider");
		}
		return res;
	};

	let assistantMsg = await callOnce(messages);
	let toolCalls = extractToolCalls(assistantMsg);
	let retried = false;

	if (toolCalls.length > 0) {
		retried = true;
		const scoldMessages = [
			...messages,
			assistantMsg,
			...toolCalls.map((tc) => ({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: BEACON_TOOL_SCOLD }],
				isError: true,
				timestamp: Date.now(),
			})),
			{
				role: "user",
				content: [
					{ type: "text", text: "Stop calling tools. Output ONLY the plain text answer to the question right now." },
				],
				timestamp: Date.now(),
			},
		];
		assistantMsg = await callOnce(scoldMessages);
		toolCalls = extractToolCalls(assistantMsg);
		if (toolCalls.length > 0) {
			throw herdError(
				"CAPABILITY_DENIED",
				`Sealed Beacon ${beacon.name} disobeyed twice and attempted to call tools (${toolCalls.map((t) => t.name).join(", ")})`,
				{ target: beacon.name },
			);
		}
	}

	const answer = extractText(assistantMsg);
	if (answer.length === 0) {
		throw herdError("INVALID_ARGUMENT", `Sealed Beacon ${beacon.name} returned an empty answer`, {
			target: beacon.name,
		});
	}

	return {
		ok: true,
		target: beacon.name,
		beacon: beacon.beacon,
		answer,
		retried,
	};
}
