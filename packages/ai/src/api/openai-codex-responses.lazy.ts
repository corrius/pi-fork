import type { Model, ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

const load = () => import("./openai-codex-responses.ts");

export const openAICodexResponsesApi = (): ProviderStreams => ({
	...lazyApi(load),
	compactContext: async (model, context, options) =>
		(await load()).compactContext(model as Model<"openai-codex-responses">, context, options),
});
