import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("rebuilds the transcript without applying a provider checkpoint boundary", () => {
		const entries = [{ type: "provider_checkpoint" }];
		const fakeThis = {
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: vi.fn(() => entries) },
			renderSessionEntries: vi.fn(),
		};
		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
		) => void;

		rebuildChatFromMessages.call(fakeThis);

		expect(fakeThis.sessionManager.buildContextEntries).toHaveBeenCalledWith();
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith(entries);
	});

	test("restores the full transcript without applying a provider checkpoint boundary", () => {
		const entries = [{ type: "provider_checkpoint" }];
		const fakeThis = {
			sessionManager: {
				buildContextEntries: vi.fn(() => entries),
				getEntries: vi.fn(() => []),
			},
			renderSessionEntries: vi.fn(),
			renderProjectTrustWarningIfNeeded: vi.fn(),
			showStatus: vi.fn(),
		};
		const renderInitialMessages = Reflect.get(InteractiveMode.prototype, "renderInitialMessages") as (
			this: typeof fakeThis,
		) => void;

		renderInitialMessages.call(fakeThis);

		expect(fakeThis.sessionManager.buildContextEntries).toHaveBeenCalledWith();
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith(entries, {
			updateFooter: true,
			populateHistory: true,
		});
	});
});
