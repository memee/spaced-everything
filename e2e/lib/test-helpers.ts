/**
 * Shared E2E helpers: path constants, Obsidian page discovery, and thin wrappers
 * around the plugin's user-facing surfaces (commands, suggester modals, frontmatter).
 *
 * Ported from the notor plugin's e2e setup. The chat/LLM/MCP helpers are gone; the
 * generic Obsidian pieces (page discovery, settings-modal handling) are kept.
 *
 * IMPORTANT — the `__name` trap: tsx compiles these files with esbuild, which
 * rewrites *nested function declarations inside a typed `page.evaluate` callback*
 * to reference an esbuild `__name` helper that does not exist in the Obsidian page.
 * The call then throws `ReferenceError: __name is not defined` at runtime, and a
 * passing typecheck will not catch it. Keep evaluate callbacks free of local
 * function/arrow *declarations* (inline `.map`/`.filter` callbacks are fine), or use
 * the template-string form of `page.evaluate`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, ElementHandle, Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

export const E2E_DIR = path.resolve(LIB_DIR, "..");
export const PROJECT_ROOT = path.resolve(E2E_DIR, "..");

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
}

/** The plugin's real manifest — the single source of truth for id and version. */
export const MANIFEST: PluginManifest = JSON.parse(
	fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8"),
);
export const PLUGIN_ID = MANIFEST.id;

/** Committed seed vault, copied into the generated vault on every reset. */
export const FIXTURE_VAULT_DIR = path.join(E2E_DIR, "fixtures", "vault");

/** Generated, disposable vault (gitignored). */
export const VAULT_PATH = process.env.E2E_VAULT_PATH
	? path.resolve(process.env.E2E_VAULT_PATH)
	: path.join(E2E_DIR, "test-vault");

/**
 * Electron `--user-data-dir` for the test instance (gitignored but persistent).
 * Keeping it across runs is what stops Obsidian's "Trust author" dialog from
 * reappearing, and it isolates the test instance from the user's real Obsidian.
 */
export const USER_DATA_DIR = path.join(E2E_DIR, "test-user-data");

export const PLUGIN_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID);
export const PLUGIN_DATA_PATH = path.join(PLUGIN_DIR, "data.json");

export const RESULTS_DIR = path.join(E2E_DIR, "results");
export const LOGS_DIR = path.join(RESULTS_DIR, "logs");

export const CDP_PORT = parseInt(process.env.CDP_PORT ?? "9222", 10);

/** Every command the plugin registers, fully qualified (src/main.ts onload). */
export const COMMAND_IDS = [
	"log-review-outcome",
	"open-next-review-item",
	"toggle-note-contexts",
	"capture-thought",
	"update-spacing-method",
].map((id) => `${PLUGIN_ID}:${id}`);

export const CMD_LOG_REVIEW_OUTCOME = `${PLUGIN_ID}:log-review-outcome`;
export const CMD_OPEN_NEXT_REVIEW_ITEM = `${PLUGIN_ID}:open-next-review-item`;
export const CMD_TOGGLE_NOTE_CONTEXTS = `${PLUGIN_ID}:toggle-note-contexts`;
export const CMD_CAPTURE_THOUGHT = `${PLUGIN_ID}:capture-thought`;
export const CMD_UPDATE_SPACING_METHOD = `${PLUGIN_ID}:update-spacing-method`;

/** `formatTimestamp()` in UTC mode: ISO 8601, seconds precision, trailing Z. */
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// ---------------------------------------------------------------------------
// Generic polling
// ---------------------------------------------------------------------------

/**
 * Poll `fn` until `pred` accepts its value, or throw on timeout.
 * Obsidian's metadataCache updates asynchronously after a file write, so nearly
 * every frontmatter assertion needs to poll rather than read once.
 */
export async function pollUntil<T>(
	fn: () => Promise<T> | T,
	pred: (value: T) => boolean,
	timeoutMs = 10_000,
	intervalMs = 250,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	let havelast = false;

	while (Date.now() < deadline) {
		last = await fn();
		havelast = true;
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	throw new Error(
		`pollUntil timed out after ${timeoutMs}ms; last value: ` +
		`${havelast ? JSON.stringify(last) : "<never resolved>"}`,
	);
}

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

/**
 * Find the Obsidian vault page across all CDP contexts.
 *
 * Obsidian spawns several renderer pages (title bar, popouts, about:blank), so the
 * first page is not reliably the vault. notor probed for its chat view's root
 * selector; this plugin renders no view of its own, so we probe for the app object
 * with our plugin loaded instead.
 */
export async function findVaultPage(browser: Browser, timeout = 30_000): Promise<Page> {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				try {
					const ready = await Promise.race([
						p.evaluate((id: string) => {
							const app = (window as unknown as { app?: any }).app;
							return Boolean(app?.workspace?.layoutReady && app?.plugins?.plugins?.[id]);
						}, PLUGIN_ID),
						new Promise<boolean>((r) => setTimeout(() => r(false), 2_000)),
					]);
					if (ready) return p;
				} catch {
					// Page closing, or not an Obsidian renderer — try the next one.
				}
			}
		}
		await new Promise((r) => setTimeout(r, 500));
	}

	throw new Error(
		`Could not find a page with window.app.plugins.plugins["${PLUGIN_ID}"] within ${timeout}ms.\n` +
		`Check that: main.js was copied into the vault (npm run build), the plugin id is in\n` +
		`.obsidian/community-plugins.json, and the one-time "Trust author" dialog has been\n` +
		`accepted for the test vault (see e2e/README.md).`,
	);
}

/** Wait until the workspace is ready and the metadataCache has indexed the vault. */
export async function waitForVaultReady(page: Page, probeNote = "Overdue.md"): Promise<void> {
	await pollUntil(
		() =>
			page.evaluate((notePath: string) => {
				const app = (window as unknown as { app?: any }).app;
				if (!app?.workspace?.layoutReady) return false;
				const file = app.vault.getAbstractFileByPath(notePath);
				if (!file) return false;
				return Boolean(app.metadataCache.getFileCache(file)?.frontmatter);
			}, probeNote),
		(ready) => ready === true,
		20_000,
	);
}

export async function waitForSelector(
	page: Page,
	selector: string,
	timeoutMs = 8_000,
): Promise<ElementHandle | null> {
	try {
		return await page.waitForSelector(selector, { timeout: timeoutMs });
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Notes and commands
// ---------------------------------------------------------------------------

/**
 * Open a note in the current leaf and wait until it is the active markdown view.
 *
 * Four of the plugin's five commands use `editorCallback`, which Obsidian only
 * dispatches when a MarkdownView is active — without this, `runCommand()` silently
 * returns false.
 */
export async function openNote(page: Page, notePath: string): Promise<void> {
	await page.evaluate(async (p: string) => {
		const app = (window as unknown as { app?: any }).app;
		const file = app.vault.getAbstractFileByPath(p);
		if (!file) throw new Error(`openNote: "${p}" not found in vault`);
		await app.workspace.getLeaf(false).openFile(file, { active: true });
	}, notePath);

	await pollUntil(() => getActiveFilePath(page), (p) => p === notePath, 10_000);
	await pollUntil(
		() =>
			page.evaluate(() => {
				const app = (window as unknown as { app?: any }).app;
				return app.workspace.activeLeaf?.view?.getViewType?.() ?? null;
			}),
		(type) => type === "markdown",
		5_000,
	);
}

export async function getActiveFilePath(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const app = (window as unknown as { app?: any }).app;
		return app.workspace.getActiveFile()?.path ?? null;
	});
}

/**
 * Run a command by id. The returned boolean is Obsidian's own: `false` means the
 * command did not run — usually an `editorCallback` command with no active
 * MarkdownView (call `openNote()` first).
 */
export async function runCommand(page: Page, commandId: string): Promise<boolean> {
	return page.evaluate((id: string) => {
		const app = (window as unknown as { app?: any }).app;
		return Boolean(app.commands.executeCommandById(id));
	}, commandId);
}

/** Ids of every command this plugin has registered, sorted. */
export async function getRegisteredCommandIds(page: Page): Promise<string[]> {
	return page.evaluate((prefix: string) => {
		const app = (window as unknown as { app?: any }).app;
		return Object.keys(app.commands.commands)
			.filter((id) => id.startsWith(prefix))
			.sort();
	}, `${PLUGIN_ID}:`);
}

// ---------------------------------------------------------------------------
// Suggester modals (src/suggester.ts — Obsidian SuggestModal)
// ---------------------------------------------------------------------------

export const SUGGESTION_ITEM_SELECTOR = ".prompt .suggestion-item";

/** Visible rows of the open suggester, trimmed. */
export async function getSuggestionTexts(page: Page, timeoutMs = 8_000): Promise<string[]> {
	await page.locator(SUGGESTION_ITEM_SELECTOR).first().waitFor({ timeout: timeoutMs });
	const texts = await page.locator(SUGGESTION_ITEM_SELECTOR).allInnerTexts();
	return texts.map((t) => t.trim());
}

/**
 * Click the suggester row whose text matches `text` exactly.
 *
 * Exact matching matters: the default review options include both "Fruitful" and
 * "Unfruitful", and the suggester filters by substring.
 */
export async function pickSuggestion(page: Page, text: string, timeoutMs = 8_000): Promise<void> {
	const rows = page.locator(SUGGESTION_ITEM_SELECTOR);
	await rows.first().waitFor({ timeout: timeoutMs });

	const count = await rows.count();
	for (let i = 0; i < count; i++) {
		const row = rows.nth(i);
		const label = ((await row.innerText()) ?? "").trim();
		if (label === text) {
			await row.click();
			await page
				.locator(".prompt")
				.waitFor({ state: "detached", timeout: 5_000 })
				.catch(() => {
					// A chained prompt may replace this one; not an error.
				});
			return;
		}
	}

	const seen = await getSuggestionTexts(page);
	throw new Error(`pickSuggestion: no row exactly matching "${text}". Rows: ${JSON.stringify(seen)}`);
}

/** True when a suggester prompt is currently open. */
export async function isSuggesterOpen(page: Page): Promise<boolean> {
	return (await page.locator(".prompt").count()) > 0;
}

// ---------------------------------------------------------------------------
// Frontmatter and vault files
// ---------------------------------------------------------------------------

export type Frontmatter = Record<string, unknown> | null;

/**
 * Frontmatter as Obsidian's metadataCache sees it (the same source the plugin
 * reads). JSON round-tripped to drop the non-serializable `position` field.
 */
export async function getFrontmatter(page: Page, notePath: string): Promise<Frontmatter> {
	return page.evaluate((p: string) => {
		const app = (window as unknown as { app?: any }).app;
		const file = app.vault.getAbstractFileByPath(p);
		const fm = file ? app.metadataCache.getFileCache(file)?.frontmatter : null;
		return fm ? JSON.parse(JSON.stringify(fm)) : null;
	}, notePath);
}

/**
 * Wait until a note's frontmatter satisfies `pred`, requiring the predicate to hold
 * on `stableReads` consecutive polls.
 *
 * The stability requirement is not paranoia: `processFrontMatter` rewrites the whole
 * file, and the metadataCache can briefly report empty or partial frontmatter while
 * that write lands. A single passing read can therefore be a mid-write snapshot,
 * which produced intermittent `undefined` values before this was added. For the same
 * reason, prefer predicates that assert the keys you are about to read are *present*
 * (`typeof fm?.["se-interval"] === "number"`) over ones that merely check a key is
 * absent or different.
 */
export async function waitForFrontmatter(
	page: Page,
	notePath: string,
	pred: (fm: Frontmatter) => boolean,
	timeoutMs = 10_000,
	stableReads = 2,
): Promise<Frontmatter> {
	const deadline = Date.now() + timeoutMs;
	let consecutive = 0;
	let last: Frontmatter = null;

	while (Date.now() < deadline) {
		last = await getFrontmatter(page, notePath);
		if (pred(last)) {
			consecutive += 1;
			if (consecutive >= stableReads) return last;
		} else {
			consecutive = 0;
		}
		await new Promise((r) => setTimeout(r, 200));
	}

	throw new Error(
		`waitForFrontmatter timed out after ${timeoutMs}ms for "${notePath}"; ` +
		`last frontmatter: ${JSON.stringify(last)}`,
	);
}

/** Set frontmatter keys from the test, using the same API the plugin uses. */
export async function setFrontmatter(
	page: Page,
	notePath: string,
	updates: Record<string, unknown>,
): Promise<void> {
	await page.evaluate(
		async (args: { notePath: string; updates: Record<string, unknown> }) => {
			const app = (window as unknown as { app?: any }).app;
			const file = app.vault.getAbstractFileByPath(args.notePath);
			if (!file) throw new Error(`setFrontmatter: "${args.notePath}" not found`);
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				for (const [key, value] of Object.entries(args.updates)) {
					if (value === undefined) delete fm[key];
					else fm[key] = value;
				}
			});
		},
		{ notePath, updates },
	);
}

/** Read a note straight off disk (asserts what was actually written). */
export function readVaultFile(relPath: string, vaultPath = VAULT_PATH): string {
	return fs.readFileSync(path.join(vaultPath, relPath), "utf8");
}

/** Markdown file names in a vault-relative directory ([] when it doesn't exist). */
export function listVaultFiles(relDir: string, vaultPath = VAULT_PATH): string[] {
	const dir = path.join(vaultPath, relDir);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

/** The live settings object the plugin loaded from data.json. */
export async function getPluginSettings(page: Page): Promise<Record<string, unknown>> {
	return page.evaluate((id: string) => {
		const app = (window as unknown as { app?: any }).app;
		return JSON.parse(JSON.stringify(app.plugins.plugins[id].settings));
	}, PLUGIN_ID);
}

/** Text of the notices currently on screen. */
export async function getNoticeTexts(page: Page): Promise<string[]> {
	const texts = await page.locator(".notice-container .notice").allInnerTexts();
	return texts.map((t) => t.trim());
}

/** Wait for a notice containing `substring`; returns its full text. */
export async function waitForNotice(
	page: Page,
	substring: string,
	timeoutMs = 8_000,
): Promise<string> {
	const notices = await pollUntil(
		() => getNoticeTexts(page),
		(all) => all.some((t) => t.includes(substring)),
		timeoutMs,
	);
	return notices.find((t) => t.includes(substring))!;
}

/**
 * A complete plugin settings object, mirroring DEFAULT_SETTINGS in src/main.ts.
 *
 * Hand-maintained on purpose: importing from `src/` would pull in the `obsidian`
 * module, which only exists inside the app. Keep this in sync when DEFAULT_SETTINGS
 * changes — the smoke spec asserts the spacing-method name to catch drift early.
 */
export function buildDefaultSettings(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		logFilePath: "",
		logOnboardAction: true,
		logRemoveAction: true,
		logNoteTitle: true,
		logFrontMatterProperties: [],
		contexts: [],
		spacingMethods: [
			{
				name: "SuperMemo 2.0 (Simplified)",
				spacingAlgorithm: "SuperMemo2.0",
				customScriptFileName: "",
				reviewOptions: [
					{ name: "Fruitful", score: 1 },
					{ name: "Ignore", score: 3 },
					{ name: "Unfruitful", score: 5 },
				],
				defaultInterval: 1,
				defaultEaseFactor: 2.5,
			},
		],
		capturedThoughtTitleTemplate: "Inbox {{unixtime}}",
		capturedThoughtDirectory: "",
		capturedThoughtNoteTemplate: "## Captured thought\n{{thought}}",
		includeShortThoughtInAlias: true,
		shortCapturedThoughtThreshold: 200,
		openCapturedThoughtInNewTab: false,
		onboardingExcludedFolders: [],
		timestampTimeZone: "UTC",
		...overrides,
	};
}

export const DEFAULT_SPACING_METHOD_NAME = "SuperMemo 2.0 (Simplified)";

// ---------------------------------------------------------------------------
// Obsidian settings modal
// ---------------------------------------------------------------------------

/**
 * Scope for queries inside the active settings tab.
 *
 * Obsidian's settings sidebar search renders `.setting-item` rows of its own, so an
 * unscoped `.setting-item` query over-counts.
 */
export const SETTINGS_CONTENT_SELECTOR = ".modal.mod-settings .vertical-tab-content";

/**
 * Write `settingsPopoutWindow: false` into the vault's app.json.
 *
 * Obsidian 1.12+ otherwise mounts the settings modal into a detached OS window that
 * has no `window.app`, which breaks `document`-scoped queries, clicks and
 * screenshots. Must happen before launch.
 */
export function disableSettingsPopout(vaultPath: string): void {
	const appJsonPath = path.join(vaultPath, ".obsidian", "app.json");
	let config: Record<string, unknown> = {};

	if (fs.existsSync(appJsonPath)) {
		try {
			config = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
		} catch {
			config = {};
		}
	}

	if (config.settingsPopoutWindow === false) return;

	config.settingsPopoutWindow = false;
	fs.mkdirSync(path.dirname(appJsonPath), { recursive: true });
	fs.writeFileSync(appJsonPath, JSON.stringify(config, null, 2));
}

/**
 * Open the settings modal on a plugin's tab via the app API.
 *
 * Not `Meta+,`: the hotkey works over CDP but lands on the About tab, and matching
 * a nav item by its visible label is brittle.
 */
export async function openPluginSettings(page: Page, tabId = PLUGIN_ID): Promise<boolean> {
	const opened = await page.evaluate((id: string) => {
		const app = (window as unknown as { app?: any }).app;
		const setting = app?.setting;
		if (!setting?.open || !setting.openTabById) return false;
		try {
			app?.vault?.setConfig?.("settingsPopoutWindow", false);
		} catch {
			// Older builds have no setConfig; app.json already carries the flag.
		}
		setting.open();
		setting.openTabById(id);
		return setting.activeTab != null;
	}, tabId);

	if (!opened) return false;

	await waitForSelector(page, SETTINGS_CONTENT_SELECTOR, 8_000);
	await page.waitForTimeout(600);
	return true;
}

export async function getActiveSettingsTabId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const app = (window as unknown as { app?: any }).app;
		return app?.setting?.activeTab?.id ?? null;
	});
}

export async function closeSettings(page: Page): Promise<void> {
	await page.evaluate(() => {
		const app = (window as unknown as { app?: any }).app;
		app?.setting?.close?.();
	});
	await page.waitForTimeout(400);
}
