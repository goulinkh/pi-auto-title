import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateTitle, titleSystemPrompt } from "../src/generate.ts";

describe("titleSystemPrompt", () => {
	it("follows the conversation when no language is named", () => {
		const prompt = titleSystemPrompt(null);
		assert.match(prompt, /same language as the user's message/);
	});

	it("pins the language when one is named", () => {
		const prompt = titleSystemPrompt("Japanese");
		assert.match(prompt, /Write the title in Japanese\./);
		assert.doesNotMatch(prompt, /same language/);
	});

	it("asks for at most 4 words by default", () => {
		assert.match(titleSystemPrompt(null), /at most 4 words/);
	});

	it("asks for the configured number of words", () => {
		assert.match(titleSystemPrompt(null, 6), /at most 6 words/);
		assert.match(titleSystemPrompt("English", 1), /a single word/);
	});
});

/** A minimal stand-in for the parts of Pi's context generation touches. */
function fakeContext(options: {
	models?: Record<string, { auth: boolean }>;
	sessionModel?: string;
	respond?: (request: { systemPrompt?: string }) => unknown;
}): ExtensionContext {
	const find = (provider: string, id: string) => {
		const ref = `${provider}/${id}`;
		return options.models && ref in options.models
			? { provider, id, contextWindow: 1000, reasoning: false }
			: undefined;
	};

	const registry = {
		find,
		hasConfiguredAuth: (model: { provider: string; id: string }) =>
			options.models?.[`${model.provider}/${model.id}`]?.auth ?? false,
		complete: async (_model: unknown, request: { systemPrompt?: string }) => {
			if (!options.respond) {
				throw new Error("no response stubbed");
			}

			return options.respond(request);
		},
	};

	const session = options.sessionModel
		? {
				provider: options.sessionModel.split("/")[0],
				id: options.sessionModel.split("/")[1],
				contextWindow: 1000,
				reasoning: false,
			}
		: undefined;

	return {
		modelRegistry: registry,
		model: session,
		sessionManager: { getSessionId: () => "test-session" },
	} as unknown as ExtensionContext;
}

describe("generateTitle outcomes", () => {
	it("reports a named model that does not exist, without calling anything", async () => {
		const ctx = fakeContext({ models: {}, sessionModel: "mock/session" });
		const result = await generateTitle(ctx, {
			promptText: "hello",
			modelOverride: "nope/nope-1",
		});

		assert.equal(result.title, null);
		assert.equal(result.requested, "nope/nope-1");
		assert.equal(result.respondedBy, null);
		assert.equal(result.failure, "named model not found");
	});

	it("reports a named model without auth the same fail-closed way", async () => {
		const ctx = fakeContext({
			models: { "mock/mock-1": { auth: false } },
			sessionModel: "mock/session",
		});
		const result = await generateTitle(ctx, {
			promptText: "hello",
			modelOverride: "mock/mock-1",
		});

		assert.equal(result.title, null);
		assert.equal(result.failure, "named model has no auth");
	});

	it("carries the provider-reported identity of a successful call", async () => {
		const ctx = fakeContext({
			models: { "mock/mock-1": { auth: true } },
			respond: () => ({
				content: [{ type: "text", text: '"A Fine Title."' }],
				provider: "mock",
				model: "mock-1",
				responseModel: "mock-1-2026",
				responseId: "resp-42",
			}),
		});
		const result = await generateTitle(ctx, {
			promptText: "hello",
			modelOverride: "mock/mock-1",
		});

		assert.equal(result.title, "A Fine Title");
		assert.equal(result.requested, "mock/mock-1");
		assert.equal(result.respondedBy, "mock/mock-1-2026");
		assert.equal(result.responseId, "resp-42");
		assert.equal(result.failure, null);
	});

	it("asks the model for the configured number of words", async () => {
		let systemPrompt: string | undefined;
		const ctx = fakeContext({
			models: { "mock/mock-1": { auth: true } },
			respond: (request) => {
				systemPrompt = request.systemPrompt;
				return { content: [{ type: "text", text: "Tab titles" }], provider: "mock", model: "mock-1" };
			},
		});
		const result = await generateTitle(ctx, {
			promptText: "hello",
			modelOverride: "mock/mock-1",
			words: "2",
		});

		assert.equal(result.title, "Tab titles");
		assert.match(systemPrompt ?? "", /at most 2 words/);
	});

	it("names a failed request instead of throwing", async () => {
		const ctx = fakeContext({
			models: { "mock/mock-1": { auth: true } },
			respond: () => {
				throw new Error("boom");
			},
		});
		const result = await generateTitle(ctx, {
			promptText: "hello",
			modelOverride: "mock/mock-1",
		});

		assert.equal(result.title, null);
		assert.equal(result.failure, "request failed");
		assert.equal(result.respondedBy, null);
	});

	it("names an unusable reply as an empty title, with its responder kept", async () => {
		const ctx = fakeContext({
			models: { "mock/mock-1": { auth: true } },
			respond: () => ({
				content: [{ type: "text", text: "   " }],
				provider: "mock",
				model: "mock-1",
			}),
		});
		const result = await generateTitle(ctx, {
			promptText: "hello",
			modelOverride: "mock/mock-1",
		});

		assert.equal(result.title, null);
		assert.equal(result.failure, "empty title");
		assert.equal(result.respondedBy, "mock/mock-1");
	});
});
