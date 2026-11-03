import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadPreferences, savePreferences } from "../src/config.ts";

describe("config file", () => {
	let dir: string;
	let savedEnv: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-auto-title-"));
		savedEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
	});

	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = savedEnv;
		}

		rmSync(dir, { recursive: true, force: true });
	});

	it("lives in the agent directory under its own name", () => {
		assert.equal(configPath(), join(dir, "pi-auto-title.json"));
	});

	it("reads a missing file as no preferences", () => {
		assert.deepEqual(loadPreferences(), { model: undefined, language: undefined, words: undefined });
	});

	it("round-trips what it saves", () => {
		savePreferences({ model: "mock/mock-1", language: "zh" });
		assert.deepEqual(loadPreferences(), { model: "mock/mock-1", language: "zh", words: undefined });
		assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), {
			model: "mock/mock-1",
			language: "zh",
		});
	});

	it("keeps unpatched keys and removes cleared ones", () => {
		savePreferences({ model: "mock/mock-1", language: "zh" });
		savePreferences({ language: "en" });
		assert.deepEqual(loadPreferences(), { model: "mock/mock-1", language: "en", words: undefined });

		savePreferences({ model: undefined });
		assert.deepEqual(loadPreferences(), { model: undefined, language: "en", words: undefined });
	});

	it("stores the word limit as a number and reads it back", () => {
		savePreferences({ words: "3" });
		assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), { words: 3 });
		assert.equal(loadPreferences().words, "3");

		savePreferences({ words: undefined });
		assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), {});
	});

	it("reads a word limit written as a string too", () => {
		writeFileSync(configPath(), '{ "words": "5" }', "utf8");
		assert.equal(loadPreferences().words, "5");
	});

	it("writes through a symlinked config file and keeps the link", () => {
		const target = join(dir, "kept-elsewhere.json");
		writeFileSync(target, '{ "language": "en" }', "utf8");
		symlinkSync(target, configPath());

		savePreferences({ words: "2" });
		assert.ok(lstatSync(configPath()).isSymbolicLink());
		assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { language: "en", words: 2 });
	});

	it("reads a malformed file as no preferences", () => {
		writeFileSync(configPath(), "{ not json", "utf8");
		assert.deepEqual(loadPreferences(), { model: undefined, language: undefined, words: undefined });
	});
});
