// Pure policy for pi-auto-title: configuration parsing and cleanup of
// generated titles. Nothing here touches Pi or the network, which is why
// it is unit-tested rather than live-tested.

export const DEFAULT_MAX_LENGTH = 60;
/** How many words a title may have unless configured otherwise. */
export const DEFAULT_WORDS = 4;
export const PROMPT_MAX_CHARS = 1500;
export const REPLY_MAX_CHARS = 500;
export const GENERATE_TIMEOUT_MS = 15_000;
export const GENERATE_MAX_TOKENS = 64;

/** Trailing punctuation a generated title should not end with. */
const trailingPunctuation = /[.。!！?？;；,，、:：)\]}"'\s]+$/u;

/** Wrapping decorations a model may put around its answer. */
const wrappingPairs: Array<[string, string]> = [
	['"', '"'],
	["'", "'"],
	["\u201c", "\u201d"],
	["\u300c", "\u300d"],
	["\u300e", "\u300f"],
	["`", "`"],
	["*", "*"],
];

/**
 * Turn a model's raw output into a usable session title. Takes the first
 * line, strips wrapping quotes or brackets, collapses whitespace, drops
 * trailing punctuation, and caps the length. Returns null when nothing
 * title-worthy remains.
 */
export function sanitizeTitle(raw: string, maxLength: number): string | null {
	if (maxLength <= 0) {
		return null;
	}

	let title = raw.split("\n", 1)[0].trim();

	let unwrapped = true;
	while (unwrapped && title.length >= 2) {
		unwrapped = false;
		for (const [open, close] of wrappingPairs) {
			if (title.startsWith(open) && title.endsWith(close)) {
				title = title.slice(open.length, title.length - close.length).trim();
				unwrapped = true;
				break;
			}
		}
	}

	title = title.replace(/\s+/gu, " ").replace(trailingPunctuation, "");
	if (title === "") {
		return null;
	}

	if ([...title].length > maxLength) {
		title = [...title].slice(0, maxLength).join("").trim();
		if (title === "") {
			return null;
		}
	}

	return title;
}

/** Parse "provider/model-id" into its parts; null when the shape is wrong. */
export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
	const slash = ref.indexOf("/");
	if (slash <= 0) {
		return null;
	}

	const provider = ref.slice(0, slash).trim();
	const modelId = ref.slice(slash + 1).trim();
	if (provider === "" || modelId === "") {
		return null;
	}

	return { provider, modelId };
}

/**
 * Whether titling is enabled. Unset means on; the usual "false" spellings
 * turn it off.
 */
export function isEnabled(value: string | undefined): boolean {
	if (value === undefined) {
		return true;
	}

	return !["0", "false", "off", "no", "n"].includes(value.trim().toLowerCase());
}

/**
 * Raw titling preferences, as one layer (the environment, the config
 * file) states them. Resolution between layers is resolvePreferences.
 */
export interface TitlePreferences {
	model?: string;
	language?: string;
	/** The most words a title may have, as written; read with titleWords. */
	words?: string;
}

/**
 * Merge two preference layers, key by key: a value set in the higher
 * layer wins, an unset or blank one falls through to the lower layer.
 */
export function resolvePreferences(
	higher: TitlePreferences,
	lower: TitlePreferences,
): TitlePreferences {
	const pick = (a?: string, b?: string) => {
		const value = a?.trim() ? a : b?.trim() ? b : undefined;
		return value?.trim();
	};

	return {
		model: pick(higher.model, lower.model),
		language: pick(higher.language, lower.language),
		words: pick(higher.words, lower.words),
	};
}

/** The stored spelling for each language the picker offers. */
export const LANGUAGE_CHOICES: Array<{ code: string; label: string }> = [
	{ code: "en", label: "English" },
	{ code: "zh", label: "Simplified Chinese" },
	{ code: "zh-TW", label: "Traditional Chinese" },
	{ code: "ja", label: "Japanese" },
	{ code: "ko", label: "Korean" },
	{ code: "es", label: "Spanish" },
	{ code: "fr", label: "French" },
	{ code: "de", label: "German" },
];

/** Aliases a language preference may be written in, by stored code. */
const languageAliases: Record<string, string[]> = {
	en: ["en", "eng", "english"],
	zh: ["zh", "zh-cn", "zh-hans", "chi", "chinese", "simplified chinese"],
	"zh-TW": ["zh-tw", "zh-hant", "traditional chinese"],
	ja: ["ja", "jpn", "japanese"],
	ko: ["ko", "kor", "korean"],
	es: ["es", "spa", "spanish"],
	fr: ["fr", "fra", "french"],
	de: ["de", "deu", "german"],
};

/**
 * The language a title should be written in, as the name a prompt can
 * carry. Null means "match the conversation" — the preference is unset,
 * blank, or "auto". A value outside the known aliases is used verbatim,
 * so a hand-written config file may name any language.
 */
export function languageName(value: string | undefined): string | null {
	const written = value?.trim();
	if (!written || written.toLowerCase() === "auto") {
		return null;
	}

	const folded = written.toLowerCase();
	for (const { code, label } of LANGUAGE_CHOICES) {
		if (languageAliases[code].includes(folded)) {
			return label;
		}
	}

	return written;
}

/** Maximum title length from the environment, with a sane fallback. */
export function maxLengthFromEnv(value: string | undefined): number {
	return positiveInteger(value) ?? DEFAULT_MAX_LENGTH;
}

/**
 * The most words a title may have, from a written preference. Unset,
 * blank, or anything but a positive number means the default.
 */
export function titleWords(value: string | undefined): number {
	return positiveInteger(value) ?? DEFAULT_WORDS;
}

/** A written number rounded down, or null when it is not a positive one. */
function positiveInteger(value: string | undefined): number | null {
	if (value === undefined || value.trim() === "") {
		return null;
	}

	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n > 0 ? n : null;
}
