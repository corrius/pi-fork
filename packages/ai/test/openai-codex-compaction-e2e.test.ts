import { describe, expect, it } from "vitest";
import { compactContext, completeSimple, getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const codexToken = await resolveApiKey("openai-codex");

describe("openai-codex native compaction e2e", () => {
	it.skipIf(!codexToken)("compacts and replays opaque provider state", async () => {
		const model = getModel("openai-codex", "gpt-5.6-sol");
		const systemPrompt = "You are a concise assistant. Reply exactly as requested.";
		const compacted = await compactContext(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: "user",
						content: "Remember that the verification marker is PI_NATIVE_COMPACT_OK.",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: codexToken, reasoning: "medium", timeoutMs: 120_000 },
		);

		const context: Context = {
			systemPrompt,
			providerState: compacted.state,
			messages: [
				{
					role: "user",
					content: "Reply with only the verification marker.",
					timestamp: Date.now(),
				},
			],
		};
		const response = await completeSimple(model, context, {
			apiKey: codexToken,
			reasoning: "medium",
			transport: "sse",
			timeoutMs: 120_000,
		});

		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(response.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toBe(
			"PI_NATIVE_COMPACT_OK",
		);
	});
});
