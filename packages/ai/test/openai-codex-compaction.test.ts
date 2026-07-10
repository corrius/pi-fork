import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactContext, stream } from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const context: Context = {
	systemPrompt: "Base instructions",
	messages: [{ role: "user", content: "Before compaction", timestamp: 1 }],
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("openai-codex native compaction", () => {
	it("persists every compacted output item and replays it before later messages", async () => {
		const token = mockToken();
		const output = [
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "opaque instruction" }] },
			{ type: "compaction", encrypted_content: "opaque-checkpoint" },
		];
		const requestBodies: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = input.toString();
			const rawBody =
				init?.body instanceof Uint8Array
					? Buffer.from(zstdDecompressSync(init.body)).toString("utf8")
					: String(init?.body);
			const body = JSON.parse(rawBody) as Record<string, unknown>;
			requestBodies.push(body);
			const headers = init?.headers as Headers;
			expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
			if (url.endsWith("/compact")) {
				expect(headers.get("accept")).toBe("application/json");
				return new Response(JSON.stringify({ output, usage: { input_tokens: 10, output_tokens: 2 } }), {
					status: 200,
				});
			}
			return new Response(
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const compacted = await compactContext(model, context, { apiKey: token, temperature: 0.5 });
		expect(compacted.state.data).toEqual(output);
		expect(compacted.state.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(requestBodies[0]).toMatchObject({
			model: model.id,
			instructions: "Base instructions",
			input: [{ role: "user", content: [{ type: "input_text", text: "Before compaction" }] }],
		});
		expect(requestBodies[0]).not.toHaveProperty("stream");
		expect(requestBodies[0]).not.toHaveProperty("store");
		expect(requestBodies[0]).not.toHaveProperty("temperature");

		const replay = stream(
			model,
			{
				systemPrompt: "Base instructions",
				providerState: compacted.state,
				messages: [{ role: "user", content: "After compaction", timestamp: 2 }],
			},
			{ apiKey: token, transport: "sse" },
		);
		await replay.result();
		expect(requestBodies[1].input).toEqual([
			...output,
			{ role: "user", content: [{ type: "input_text", text: "After compaction" }] },
		]);
	});

	it("retries transient compact endpoint errors", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ output: [{ type: "compaction_summary" }] }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const request = compactContext(model, context, { apiKey: mockToken(), maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(1000);

		await expect(request).resolves.toMatchObject({ state: { data: [{ type: "compaction_summary" }] } });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("preserves abort error identity", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			compactContext(model, context, { apiKey: mockToken(), signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("surfaces compact endpoint errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () => new Response(JSON.stringify({ error: { message: "compact unavailable" } }), { status: 503 }),
			),
		);

		await expect(compactContext(model, context, { apiKey: mockToken() })).rejects.toThrow("compact unavailable");
	});
});
