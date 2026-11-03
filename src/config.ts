// The persisted half of the preferences: a small JSON file of our own
// in Pi's agent directory, next to Pi's settings but never inside them.
// Reads are tolerant — a missing or malformed file is no preferences at
// all — and writes are atomic, so a crash mid-write keeps the old file.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TitlePreferences } from "./policy.ts";

export const CONFIG_FILE_NAME = "pi-auto-title.json";

/** Where the config file lives: Pi's agent directory. */
export function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
		? process.env.PI_CODING_AGENT_DIR
		: join(homedir(), ".pi", "agent");

	return join(agentDir, CONFIG_FILE_NAME);
}

/** The preferences the config file states, or none when it says nothing usable. */
export function loadPreferences(): TitlePreferences {
	const none: TitlePreferences = { model: undefined, language: undefined, words: undefined, update: undefined };

	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null) {
			return none;
		}

		const record = parsed as Record<string, unknown>;
		return {
			model: asWritten(record.model),
			language: asWritten(record.language),
			words: asWritten(typeof record.words === "number" ? String(record.words) : record.words),
			update: asWritten(record.update),
		};
	} catch {
		return none;
	}
}

/**
 * Merge a patch into the stored preferences and write the result. A key
 * patched to undefined is removed; keys the patch does not mention are
 * kept. Returns the preferences now stored.
 */
export function savePreferences(patch: TitlePreferences): TitlePreferences {
	const next: TitlePreferences = { ...loadPreferences() };

	for (const key of ["model", "language", "words", "update"] as const) {
		if (key in patch) {
			const value = patch[key]?.trim();
			if (value) {
				next[key] = value;
			} else {
				delete next[key];
			}
		}
	}

	// Write through a symlink (a config kept in a dotfiles repo) rather than
	// replacing the link with a plain file.
	const path = existsSync(configPath()) ? realpathSync(configPath()) : configPath();
	mkdirSync(join(path, ".."), { recursive: true });

	const written: Record<string, string | number> = {};
	if (next.model) {
		written.model = next.model;
	}

	if (next.language) {
		written.language = next.language;
	}

	if (next.words) {
		const words = Number(next.words);
		written.words = Number.isFinite(words) ? words : next.words;
	}

	if (next.update) {
		written.update = next.update;
	}

	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(written, null, 2)}\n`, "utf8");
	renameSync(temp, path);

	return next;
}

/** Whether a config file exists at all, for status messages. */
export function configFileExists(): boolean {
	return existsSync(configPath());
}

function asWritten(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
