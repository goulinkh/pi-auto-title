// Title generation: pick a model, ask it once, sanitize what comes back.
// Model resolution is fail-closed: a PI_AUTO_TITLE_MODEL override that
// cannot be resolved or has no configured auth ends titling here, never
// quietly spending the session's own model instead.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_WORDS,
	GENERATE_MAX_TOKENS,
	GENERATE_TIMEOUT_MS,
	languageName,
	maxLengthFromEnv,
	parseModelRef,
	sanitizeTitle,
	titleWords,
} from "./policy.ts";

/**
 * The instruction the titling model works under. A named language pins
 * the title's language; null leaves it to follow the conversation.
 * `words` is the most words the title may have.
 */
export function titleSystemPrompt(language: string | null, words: number = DEFAULT_WORDS): string {
	const inLanguage = language
		? `Write the title in ${language}.`
		: "Use the same language as the user's message.";
	const length = words === 1 ? "a single word" : `at most ${words} words`;

	return (
		`Name this chat session. Reply with ONLY a title of ${length}; ` +
		"count them, never more. Write it like a tab label: the fewest " +
		`words that say what the work is, without articles or filler. ${inLanguage} ` +
		"No quotation marks, no trailing punctuation, no explanation."
	);
}

export interface GenerateInput {
	promptText: string;
	replyText?: string;
	modelOverride?: string;
	/** Raw language preference; normalized by languageName. */
	language?: string;
	/** Raw word limit; read with titleWords. */
	words?: string;
}

/** Why a generation produced no title, in words a log can carry. */
export type FailureReason =
	| "named model not found"
	| "named model has no auth"
	| "no session model"
	| "session model has no auth"
	| "request failed"
	| "empty title";

/**
 * The outcome of one generation attempt: the title when there is one,
 * plus the evidence of what was asked and what actually answered —
 * the material the session record is written from.
 */
export interface GenerationResult {
	title: string | null;
	/** The model ref the attempt meant to use. */
	requested: string | null;
	/** The model the provider reports answering, when a call happened. */
	respondedBy: string | null;
	responseId: string | null;
	failure: FailureReason | null;
}

/**
 * Ask a model for a session title. Never throws; every way the attempt
 * can end without a title is named in the result's failure.
 */
export async function generateTitle(
	ctx: ExtensionContext,
	input: GenerateInput,
): Promise<GenerationResult> {
	const resolved = resolveTitleModel(ctx, input.modelOverride);
	if (!resolved.model) {
		return {
			title: null,
			requested: resolved.requested,
			respondedBy: null,
			responseId: null,
			failure: resolved.failure,
		};
	}

	const { model } = resolved;
	const requested = `${model.provider}/${model.id}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: titleSystemPrompt(languageName(input.language), titleWords(input.words)),
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: titleUserMessage(input) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: GENERATE_MAX_TOKENS,
				signal: controller.signal,
				sessionId: ctx.sessionManager.getSessionId(),
			},
		);

		const respondedBy = `${response.provider}/${response.responseModel ?? response.model}`;
		const text = (response.content ?? [])
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		const title = sanitizeTitle(text, maxLengthFromEnv(process.env.PI_AUTO_TITLE_MAX_LENGTH));
		return {
			title,
			requested,
			respondedBy,
			responseId: response.responseId ?? null,
			failure: title ? null : "empty title",
		};
	} catch {
		return {
			title: null,
			requested,
			respondedBy: null,
			responseId: null,
			failure: "request failed",
		};
	} finally {
		clearTimeout(timer);
	}
}

type RegistryModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

/**
 * Pick the model to title with, fail-closed: a named model that cannot
 * be used ends the attempt here — with the reason — rather than
 * quietly spending the session's own model instead.
 */
function resolveTitleModel(
	ctx: ExtensionContext,
	modelOverride: string | undefined,
): { model: RegistryModel; requested: string } | { model: null; requested: string | null; failure: FailureReason } {
	const registry = ctx.modelRegistry;

	if (modelOverride) {
		const ref = parseModelRef(modelOverride);
		const model = ref ? registry.find(ref.provider, ref.modelId) : undefined;
		if (!model) {
			return { model: null, requested: modelOverride, failure: "named model not found" };
		}

		if (!registry.hasConfiguredAuth(model)) {
			return { model: null, requested: modelOverride, failure: "named model has no auth" };
		}

		return { model, requested: modelOverride };
	}

	const model = ctx.model;
	if (!model) {
		return { model: null, requested: null, failure: "no session model" };
	}

	if (!registry.hasConfiguredAuth(model)) {
		return {
			model: null,
			requested: `${model.provider}/${model.id}`,
			failure: "session model has no auth",
		};
	}

	return { model, requested: `${model.provider}/${model.id}` };
}

function titleUserMessage(input: GenerateInput): string {
	let message = `Conversation to title:\n\nUser: ${input.promptText}`;
	if (input.replyText) {
		message += `\n\nAssistant: ${input.replyText}`;
	}

	return message;
}
