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

function compactionSse(
	output: Record<string, unknown>,
	usage = { input_tokens: 10, output_tokens: 2 },
	status: "completed" | "incomplete" = "completed",
): string {
	return [
		{ type: "response.output_item.done", item: output },
		{ type: `response.${status}`, response: { status, usage } },
	]
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
}

describe("openai-codex native compaction", () => {
	it("requests remote compaction v2 and replays its opaque output before later messages", async () => {
		const token = mockToken();
		const output = { type: "compaction", encrypted_content: "opaque-checkpoint" };

		const requestBodies: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const rawBody =
				init?.body instanceof Uint8Array
					? Buffer.from(zstdDecompressSync(init.body)).toString("utf8")
					: String(init?.body);
			const body = JSON.parse(rawBody) as Record<string, unknown>;
			requestBodies.push(body);
			const headers = init?.headers as Headers;
			expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
			const inputItems = body.input as Array<Record<string, unknown>>;
			if (inputItems.at(-1)?.type === "compaction_trigger") {
				expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
				expect(headers.get("accept")).toBe("text/event-stream");
				expect(headers.get("x-codex-beta-features")).toBe("existing_feature,remote_compaction_v2");
				return new Response(compactionSse(output), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
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

		const compacted = await compactContext(model, context, {
			apiKey: token,
			fetch: fetchMock,
			temperature: 0.5,
			headers: { "x-codex-beta-features": "existing_feature" },
		});
		expect(compacted.state.data).toEqual([output]);
		expect(compacted.state.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(requestBodies[0]).toMatchObject({
			model: model.id,
			instructions: "Base instructions",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "Before compaction" }] },
				{ type: "compaction_trigger" },
			],
			stream: true,
			store: false,
		});
		expect(requestBodies[0]).not.toHaveProperty("temperature");

		const replay = stream(
			model,
			{
				systemPrompt: "Base instructions",
				providerState: { ...compacted.state, baseUrl: `${compacted.state.baseUrl}/` },
				messages: [{ role: "user", content: "After compaction", timestamp: 2 }],
			},
			{ apiKey: token, fetch: fetchMock, transport: "sse" },
		);
		await replay.result();
		expect(requestBodies[1].input).toEqual([
			output,
			{ role: "user", content: [{ type: "input_text", text: "After compaction" }] },
		]);
	});

	it("retries transient compaction request errors", async () => {
		vi.useFakeTimers();
		const output = { type: "compaction", encrypted_content: "retry-checkpoint" };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(compactionSse(output), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const request = compactContext(model, context, { apiKey: mockToken(), maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(1000);

		await expect(request).resolves.toMatchObject({ state: { data: [output] } });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects incomplete compaction output", async () => {
		const output = { type: "compaction", encrypted_content: "incomplete-checkpoint" };
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(compactionSse(output, undefined, "incomplete"), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			),
		);

		await expect(compactContext(model, context, { apiKey: mockToken() })).rejects.toThrow(
			"terminal status was incomplete",
		);
	});

	it.each([200, 503])("keeps the timeout active while reading a %i response body", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const signal = init?.signal;
				const body = new ReadableStream({
					start(controller) {
						signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
					},
				});
				return new Response(body, { status });
			}),
		);

		await expect(
			compactContext(model, context, { apiKey: mockToken(), timeoutMs: 10, maxRetries: 0 }),
		).rejects.toThrow("timed out after 10ms");
	});

	it("preserves abort error identity", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			compactContext(model, context, { apiKey: mockToken(), signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("surfaces compaction request errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () => new Response(JSON.stringify({ error: { message: "compact unavailable" } }), { status: 503 }),
			),
		);

		await expect(compactContext(model, context, { apiKey: mockToken() })).rejects.toThrow("compact unavailable");
	});
});
