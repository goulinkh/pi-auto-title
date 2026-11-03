import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isEnabled,
	languageName,
	maxLengthFromEnv,
	parseModelRef,
	resolvePreferences,
	sanitizeTitle,
	titleWords,
	updatesEveryTurn,
} from "../src/policy.ts";

describe("sanitizeTitle", () => {
	it("returns the title unchanged when it is already clean", () => {
		assert.equal(sanitizeTitle("Fix the draw logic", 60), "Fix the draw logic");
	});

	it("strips wrapping quotation marks and backticks", () => {
		assert.equal(sanitizeTitle('"Fix the draw logic"', 60), "Fix the draw logic");
		assert.equal(sanitizeTitle("`Fix the draw logic`", 60), "Fix the draw logic");
		assert.equal(sanitizeTitle("\u201cFix the draw logic\u201d", 60), "Fix the draw logic");
		assert.equal(sanitizeTitle("**Fix the draw logic**", 60), "Fix the draw logic");
	});

	it("takes only the first line and collapses whitespace", () => {
		assert.equal(sanitizeTitle("Fix the draw\nThen something else", 60), "Fix the draw");
		assert.equal(sanitizeTitle("Fix   the\t draw", 60), "Fix the draw");
	});

	it("strips trailing sentence punctuation", () => {
		assert.equal(sanitizeTitle("Fix the draw logic.", 60), "Fix the draw logic");
		assert.equal(sanitizeTitle("Fix the draw logic!", 60), "Fix the draw logic");
		assert.equal(sanitizeTitle("Fix the draw logic?", 60), "Fix the draw logic");
		assert.equal(sanitizeTitle("\u4fee\u590d\u62bd\u7b7e\u903b\u8f91\u3002", 60), "\u4fee\u590d\u62bd\u7b7e\u903b\u8f91");
	});

	it("keeps a CJK title and caps its length", () => {
		const long = "\u4fee\u590d\u56e2\u4f53\u6d3b\u52a8\u62bd\u7b7e\u7684\u903b\u8f91\u548c\u6570\u636e\u5e93\u8868\u7ed3\u6784";
		const got = sanitizeTitle(long, 8);
		assert.equal(got, long.slice(0, 8));
	});

	it("returns null for empty or punctuation-only output", () => {
		assert.equal(sanitizeTitle("", 60), null);
		assert.equal(sanitizeTitle("   ", 60), null);
		assert.equal(sanitizeTitle("...", 60), null);
		assert.equal(sanitizeTitle('""', 60), null);
	});

	it("returns null when the maximum length is not positive", () => {
		assert.equal(sanitizeTitle("Hello", 0), null);
		assert.equal(sanitizeTitle("Hello", -1), null);
	});
});

describe("parseModelRef", () => {
	it("splits provider and model id", () => {
		assert.deepEqual(parseModelRef("openrouter/moonshot/kimi-k2:free"), {
			provider: "openrouter",
			modelId: "moonshot/kimi-k2:free",
		});
	});

	it("trims surrounding whitespace", () => {
		assert.deepEqual(parseModelRef("  anthropic / claude-haiku-4-5  "), {
			provider: "anthropic",
			modelId: "claude-haiku-4-5",
		});
	});

	it("rejects malformed references", () => {
		assert.equal(parseModelRef("no-slash-here"), null);
		assert.equal(parseModelRef("/missing-provider"), null);
		assert.equal(parseModelRef("missing-id/"), null);
		assert.equal(parseModelRef(""), null);
	});
});

describe("isEnabled", () => {
	it("is on when unset", () => {
		assert.equal(isEnabled(undefined), true);
	});

	it("is on for truthy spellings", () => {
		assert.equal(isEnabled("true"), true);
		assert.equal(isEnabled("1"), true);
		assert.equal(isEnabled("yes"), true);
	});

	it("is off for the usual false spellings", () => {
		for (const value of ["0", "false", "off", "no", "n", "FALSE", " Off "]) {
			assert.equal(isEnabled(value), false, value);
		}
	});
});

describe("maxLengthFromEnv", () => {
	it("falls back to 60 when unset or invalid", () => {
		assert.equal(maxLengthFromEnv(undefined), 60);
		assert.equal(maxLengthFromEnv("abc"), 60);
		assert.equal(maxLengthFromEnv("0"), 60);
		assert.equal(maxLengthFromEnv("-5"), 60);
	});

	it("parses a positive integer", () => {
		assert.equal(maxLengthFromEnv("100"), 100);
		assert.equal(maxLengthFromEnv("45.9"), 45);
	});
});

describe("titleWords", () => {
	it("falls back to 4 when unset or invalid", () => {
		assert.equal(titleWords(undefined), 4);
		assert.equal(titleWords(""), 4);
		assert.equal(titleWords("many"), 4);
		assert.equal(titleWords("0"), 4);
		assert.equal(titleWords("-2"), 4);
	});

	it("parses a positive number of words", () => {
		assert.equal(titleWords("3"), 3);
		assert.equal(titleWords(" 6 "), 6);
		assert.equal(titleWords("2.7"), 2);
	});
});

describe("updatesEveryTurn", () => {
	it("updates after every turn unless told once", () => {
		assert.equal(updatesEveryTurn(undefined), true);
		assert.equal(updatesEveryTurn("turn"), true);
		assert.equal(updatesEveryTurn("something else"), true);
		assert.equal(updatesEveryTurn("once"), false);
		assert.equal(updatesEveryTurn(" Once "), false);
	});
});

describe("languageName", () => {
	it("leaves unset and auto to the conversation", () => {
		assert.equal(languageName(undefined), null);
		assert.equal(languageName(""), null);
		assert.equal(languageName("auto"), null);
		assert.equal(languageName(" Auto "), null);
	});

	it("names the known languages however they are spelled", () => {
		assert.equal(languageName("en"), "English");
		assert.equal(languageName("English"), "English");
		assert.equal(languageName("zh"), "Simplified Chinese");
		assert.equal(languageName("chinese"), "Simplified Chinese");
		assert.equal(languageName("zh-TW"), "Traditional Chinese");
		assert.equal(languageName("ja"), "Japanese");
		assert.equal(languageName("Korean"), "Korean");
	});

	it("carries an unknown language verbatim", () => {
		assert.equal(languageName("Klingon"), "Klingon");
	});
});

describe("resolvePreferences", () => {
	it("prefers the higher layer key by key", () => {
		assert.deepEqual(
			resolvePreferences(
				{ model: "a/b" },
				{ model: "c/d", language: "zh" },
			),
			{ model: "a/b", language: "zh", words: undefined, update: undefined },
		);
		assert.deepEqual(
			resolvePreferences({ words: "2" }, { words: "5", language: "en" }),
			{ model: undefined, language: "en", words: "2", update: undefined },
		);
	});

	it("treats blank values as unset", () => {
		assert.deepEqual(
			resolvePreferences({ language: "  " }, { language: "en" }),
			{ model: undefined, language: "en", words: undefined, update: undefined },
		);
		assert.deepEqual(resolvePreferences({}, {}), {
			model: undefined,
			language: undefined,
			words: undefined,
			update: undefined,
		});
	});
});
