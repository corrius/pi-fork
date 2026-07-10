import type { ProviderState } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	getLatestCompactionBoundary,
	type ProviderCheckpointEntry,
	type ProviderStateTarget,
	type SessionEntry,
} from "../src/core/session-manager.ts";

const state: ProviderState = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	model: "gpt-5.6-sol",
	baseUrl: "https://chatgpt.com/backend-api",
	data: [{ type: "compaction", encrypted_content: "opaque" }],
};

const target: ProviderStateTarget = {
	provider: state.provider,
	api: state.api,
	model: state.model,
	baseUrl: state.baseUrl,
};

function message(id: string, parentId: string | null, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

function checkpoint(parentId: string): ProviderCheckpointEntry {
	return {
		type: "provider_checkpoint",
		id: "checkpoint",
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		state,
		tokensBefore: 100,
	};
}

describe("provider checkpoint projection", () => {
	const entries = [
		message("before-1", null, "before one"),
		message("before-2", "before-1", "before two"),
		checkpoint("before-2"),
		message("after", "checkpoint", "after"),
	];

	it("uses a compatible checkpoint and only returns later messages", () => {
		const context = buildSessionContext(entries, "after", undefined, target);
		expect(context.providerState).toEqual(state);
		expect(context.messages.map((entry) => ("content" in entry ? entry.content : undefined))).toEqual(["after"]);
	});

	it("reconstructs the untouched raw history for an incompatible model", () => {
		const incompatibleTarget = { ...target, model: "gpt-5.6-sol-mini" };
		const context = buildSessionContext(entries, "after", undefined, incompatibleTarget);
		expect(context.providerState).toBeUndefined();
		expect(context.messages.map((entry) => ("content" in entry ? entry.content : undefined))).toEqual([
			"before one",
			"before two",
			"after",
		]);
		expect(getLatestCompactionBoundary(entries, incompatibleTarget)).toBeNull();
		expect(getLatestCompactionBoundary(entries, target)?.type).toBe("provider_checkpoint");
	});

	it("keeps branching before the checkpoint independent", () => {
		const context = buildSessionContext(entries, "before-2", undefined, target);
		expect(context.providerState).toBeUndefined();
		expect(context.messages.map((entry) => ("content" in entry ? entry.content : undefined))).toEqual([
			"before one",
			"before two",
		]);
	});

	it("does not restore an overflow response excluded from the checkpoint input", () => {
		const failedResponse = message("failed", "before-2", "overflow error");
		const excludedCheckpoint = {
			...checkpoint("failed"),
			excludedEntryIds: ["failed"],
		};
		const context = buildSessionContext(
			[entries[0], entries[1], failedResponse, excludedCheckpoint, message("after", "checkpoint", "after")],
			"after",
			undefined,
			{ ...target, model: "other-model" },
		);

		expect(context.messages.map((entry) => ("content" in entry ? entry.content : undefined))).toEqual([
			"before one",
			"before two",
			"after",
		]);
	});
});
