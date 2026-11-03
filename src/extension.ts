// Wiring only: hook Pi's extension events, keep the titling state machine,
// and register the /retitle command. Generation itself lives in
// generate.ts; the rules that keep it out of the user's way live below.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, loadPreferences, savePreferences } from "./config.ts";
import { generateTitle, type GenerationResult } from "./generate.ts";
import { buildModelItems, pickModel, SESSION_MODEL_VALUE } from "./model-picker.ts";
import {
	isEnabled,
	LANGUAGE_CHOICES,
	languageName,
	parseModelRef,
	PROMPT_MAX_CHARS,
	REPLY_MAX_CHARS,
	resolvePreferences,
	type TitlePreferences,
	titleWords,
} from "./policy.ts";

const ENABLE_ENV = "PI_AUTO_TITLE";
const MODEL_ENV = "PI_AUTO_TITLE_MODEL";
const LANGUAGE_ENV = "PI_AUTO_TITLE_LANGUAGE";
const WORDS_ENV = "PI_AUTO_TITLE_WORDS";

/** The environment variable that states each preference. */
const PREFERENCE_ENV: Record<keyof TitlePreferences, string> = {
	model: MODEL_ENV,
	language: LANGUAGE_ENV,
	words: WORDS_ENV,
};

/** Per-session state. Reset whenever a session starts. */
interface TitlerState {
	/** The title this extension set, if any. */
	titledByMe: string | null;
	/** The user took over the name; never auto-title again this session. */
	stoodDown: boolean;
	/** A generation is in flight. */
	inFlight: boolean;
}

function freshState(): TitlerState {
	return { titledByMe: null, stoodDown: false, inFlight: false };
}

export default function (pi: ExtensionAPI) {
	const state = freshState();

	pi.on("session_start", () => {
		Object.assign(state, freshState());
	});

	// The agent has finished its turn: the reply is delivered and nothing is
	// blocked anymore. The promise is deliberately not returned to Pi.
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || !isEnabled(process.env[ENABLE_ENV])) {
			return;
		}

		void settleTitling(pi, ctx, state).catch(() => {});
	});

	// A name that is not ours means the user took over: stand down for the
	// rest of this session, whether they renamed it or cleared it.
	pi.on("session_info_changed", () => {
		if (pi.getSessionName() !== state.titledByMe) {
			state.stoodDown = true;
		}
	});

	pi.registerCommand("retitle", {
		description: "Generate a new automatic title for this session",
		handler: async (_args, ctx) => {
			if (state.inFlight) {
				ctx.ui.notify("Already generating a title.", "warning");
				return;
			}

			const excerpt = conversationExcerpt(ctx);
			if (excerpt.prompt === "") {
				ctx.ui.notify("Nothing to title yet — say something first.", "warning");
				return;
			}

			state.inFlight = true;
			try {
				const result = await generateTitle(ctx, {
					promptText: excerpt.prompt,
					replyText: excerpt.reply,
					...preferenceInput(),
				});
				recordGeneration(pi, "retitle", result, result.title !== null);

				if (!result.title) {
					ctx.ui.notify(
						`Could not generate a title (${result.failure ?? "unknown reason"}).`,
						"warning",
					);
					return;
				}

				pi.setSessionName(result.title);
				state.titledByMe = result.title;
				state.stoodDown = false;
				ctx.ui.notify(`Session titled: ${result.title}`, "info");
			} finally {
				state.inFlight = false;
			}
		},
	});

	pi.registerCommand("title-model", {
		description: "Show or set the model titles are generated with",
		handler: async (args, ctx) => {
			const written = args.trim();

			if (written === "clear") {
				savePreferences({ model: undefined });
				ctx.ui.notify("Title model cleared; the session model is used.", "info");
				return;
			}

			if (written !== "") {
				const ref = parseModelRef(written);
				const model = ref ? ctx.modelRegistry.find(ref.provider, ref.modelId) : undefined;
				if (!ref || !model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
					ctx.ui.notify(`Not a usable model: ${written}`, "warning");
					return;
				}

				savePreferences({ model: written });
				ctx.ui.notify(`Title model set to ${written} (${configPath()}).`, "info");
				return;
			}

			const records = ctx.modelRegistry
				.getAll()
				.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
				.map((model) => ({
					provider: model.provider,
					id: model.id,
					contextWindow: model.contextWindow,
					reasoning: model.reasoning,
				}));
			const effective = resolvePreferences(
				{ model: process.env[MODEL_ENV] },
				loadPreferences(),
			).model;

			const picked = await pickModel(ctx, buildModelItems(records, effective));

			if (picked === undefined) {
				ctx.ui.notify(modelStatus(), "info");
				return;
			}

			if (picked === SESSION_MODEL_VALUE) {
				savePreferences({ model: undefined });
				ctx.ui.notify("Title model cleared; the session model is used.", "info");
				return;
			}

			savePreferences({ model: picked });
			ctx.ui.notify(`Title model set to ${picked} (${configPath()}).`, "info");
		},
	});

	pi.registerCommand("title-status", {
		description: "Show the titling preferences and the last generation record",
		handler: async (_args, ctx) => {
			const lines = [modelStatus(), languageStatus(), wordsStatus(), `Config file: ${configPath()}`];
			const record = lastRecord(ctx);

			if (!record) {
				lines.push("Last generation: none recorded in this session yet.");
			} else if (record.outcome === "titled") {
				lines.push(
					`Last generation: ${record.at} (${record.trigger})`,
					`  requested ${record.requested ?? "?"} (from ${record.source})` +
						` · responded ${record.respondedBy ?? "?"}` +
						(record.responseId ? ` · response ${record.responseId}` : "") +
						` · titled "${record.title}"${record.applied ? "" : " (not applied)"}`,
				);
			} else {
				lines.push(
					`Last generation: ${record.at} (${record.trigger})`,
					`  ${record.outcome} — ${record.reason ?? "unknown reason"}` +
						(record.requested ? ` · requested ${record.requested} (from ${record.source})` : ""),
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("title-language", {
		description: "Show or set the language titles are generated in",
		handler: async (args, ctx) => {
			const written = args.trim();

			if (written === "clear" || written.toLowerCase() === "auto") {
				savePreferences({ language: undefined });
				ctx.ui.notify("Title language cleared; titles match the conversation.", "info");
				return;
			}

			if (written !== "") {
				savePreferences({ language: written });
				ctx.ui.notify(
					`Title language set to ${languageName(written) ?? written} (${configPath()}).`,
					"info",
				);
				return;
			}

			const auto = "Auto (match the conversation)";
			const picked = await ctx.ui.select("Title language", [
				auto,
				...LANGUAGE_CHOICES.map((choice) => choice.label),
			]);

			if (picked === undefined) {
				ctx.ui.notify(languageStatus(), "info");
				return;
			}

			const choice = LANGUAGE_CHOICES.find((entry) => entry.label === picked);
			savePreferences({ language: picked === auto ? undefined : choice?.code });
			ctx.ui.notify(`Title language: ${picked} (${configPath()}).`, "info");
		},
	});

	pi.registerCommand("title-words", {
		description: "Show or set how many words titles stay within",
		handler: async (args, ctx) => {
			const written = args.trim();

			if (written === "clear") {
				savePreferences({ words: undefined });
				ctx.ui.notify(`Title words cleared; titles stay within ${titleWords(undefined)} words.`, "info");
				return;
			}

			if (written === "") {
				ctx.ui.notify(`${wordsStatus()}\nSet it with /title-words <number>, or clear.`, "info");
				return;
			}

			if (!/^\d+$/.test(written) || Number(written) < 1) {
				ctx.ui.notify(`Not a number of words: ${written}`, "warning");
				return;
			}

			savePreferences({ words: written });
			ctx.ui.notify(`Titles stay within ${Number(written)} words (${configPath()}).`, "info");
		},
	});
}

/** The preferences generation runs under: environment over config file. */
function preferenceInput(): { modelOverride?: string; language?: string; words?: string } {
	const prefs = resolvePreferences(
		{
			model: process.env[MODEL_ENV],
			language: process.env[LANGUAGE_ENV],
			words: process.env[WORDS_ENV],
		},
		loadPreferences(),
	);

	return { modelOverride: prefs.model, language: prefs.language, words: prefs.words };
}

/** Which layer states a preference: the environment, the file, or neither. */
function preferenceSource(key: keyof TitlePreferences): string {
	if (process.env[PREFERENCE_ENV[key]]?.trim()) {
		return "environment";
	}

	return loadPreferences()[key] ? "config file" : "default";
}

function modelStatus(): string {
	const prefs = resolvePreferences(
		{ model: process.env[MODEL_ENV] },
		loadPreferences(),
	);

	return prefs.model
		? `Title model: ${prefs.model} (from ${preferenceSource("model")})`
		: "Title model: the session model (default)";
}

function languageStatus(): string {
	const prefs = resolvePreferences(
		{ language: process.env[LANGUAGE_ENV] },
		loadPreferences(),
	);
	const name = languageName(prefs.language);

	return name
		? `Title language: ${name} (from ${preferenceSource("language")})`
		: "Title language: auto (matches the conversation)";
}

function wordsStatus(): string {
	const prefs = resolvePreferences({ words: process.env[WORDS_ENV] }, loadPreferences());

	return `Title words: at most ${titleWords(prefs.words)} (from ${preferenceSource("words")})`;
}

/** Title once, after the first settled turn, then never again on its own. */
async function settleTitling(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: TitlerState,
): Promise<void> {
	if (state.stoodDown || state.inFlight || state.titledByMe) {
		return;
	}

	if (pi.getSessionName()) {
		return;
	}

	const excerpt = conversationExcerpt(ctx);
	if (excerpt.prompt === "") {
		return;
	}

	state.inFlight = true;
	try {
		const result = await generateTitle(ctx, {
			promptText: excerpt.prompt,
			replyText: excerpt.reply,
			...preferenceInput(),
		});
		const applied = result.title !== null && !pi.getSessionName();
		recordGeneration(pi, "auto", result, applied);

		if (!applied || !result.title) {
			return;
		}

		pi.setSessionName(result.title);
		state.titledByMe = result.title;
	} finally {
		state.inFlight = false;
	}
}

/** One generation attempt, as the session record keeps it. */
interface TitleRecord {
	at: string;
	trigger: "auto" | "retitle";
	requested: string | null;
	source: string;
	respondedBy: string | null;
	responseId: string | null;
	outcome: "titled" | "failed" | "skipped";
	title?: string;
	applied?: boolean;
	reason?: string;
}

/**
 * Leave the attempt's evidence in the session file, where it can be
 * grepped and outlives the process: what was asked, which layer chose
 * it, what the provider reports answering, and how it ended.
 */
function recordGeneration(
	pi: ExtensionAPI,
	trigger: "auto" | "retitle",
	result: GenerationResult,
	applied: boolean,
): void {
	const source = preferenceSource("model");
	const record: TitleRecord = {
		at: new Date().toISOString(),
		trigger,
		requested: result.requested,
		source: source === "default" ? "session" : source,
		respondedBy: result.respondedBy,
		responseId: result.responseId,
		outcome: result.title
			? "titled"
			: result.respondedBy || result.failure === "request failed"
				? "failed"
				: "skipped",
	};

	if (result.title) {
		record.title = result.title;
		record.applied = applied;
	}

	if (result.failure) {
		record.reason = result.failure;
	}

	pi.appendEntry("pi-auto-title", record);
}

/** The most recent generation record in this session, if any. */
function lastRecord(ctx: ExtensionContext): TitleRecord | null {
	let found: TitleRecord | null = null;
	for (const entry of ctx.sessionManager.getEntries()) {
		const candidate = entry as {
			type?: string;
			customType?: string;
			data?: TitleRecord;
		};

		if (candidate.type === "custom" && candidate.customType === "pi-auto-title") {
			found = candidate.data ?? found;
		}
	}

	return found;
}

/** The first user prompt and the first assistant reply, bounded in size. */
function conversationExcerpt(ctx: ExtensionContext): { prompt: string; reply?: string } {
	let prompt = "";
	let reply: string | undefined;

	for (const raw of ctx.sessionManager.getEntries()) {
		const entry = raw as {
			type?: string;
			message?: { role?: string; content?: unknown };
		};

		if (entry.type !== "message") {
			continue;
		}

		if (entry.message?.role === "user" && prompt === "") {
			prompt = blockText(entry.message.content).slice(0, PROMPT_MAX_CHARS);
		} else if (entry.message?.role === "assistant" && reply === undefined) {
			reply = blockText(entry.message.content).slice(0, REPLY_MAX_CHARS);
		}

		if (prompt !== "" && reply !== undefined) {
			break;
		}
	}

	return { prompt, reply };
}

function blockText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.filter((block) => (block as { type?: string }).type === "text")
			.map((block) => (block as { text?: string }).text ?? "")
			.join("\n");
	}

	return "";
}
