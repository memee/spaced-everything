/**
 * Vault reset — rebuild the disposable test vault from the committed fixture.
 *
 * Replaces notor's version, which surgically deleted a hard-coded list of
 * test-generated notes. Here the whole note tree is disposable: it is wiped and
 * re-copied from `e2e/fixtures/vault/`, so every run starts from identical content
 * no matter what the previous run created or mutated.
 *
 * `.obsidian/` is deliberately *not* wiped wholesale. Obsidian writes its own state
 * there, and the fixture's four json files are copied over the top of it. The plugin
 * directory and `workspace.json` are the exceptions — those are rebuilt.
 *
 * Unlike notor, the plugin is COPIED into the vault (not symlinked to a build dir),
 * because this repo's esbuild writes `main.js` to the repo root. A consequence worth
 * knowing: the plugin's `data.json` therefore lives inside the disposable vault, so
 * settings can simply be written before launch — no backup/restore of a real
 * data.json is needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildDefaultSettings,
	disableSettingsPopout,
	FIXTURE_VAULT_DIR,
	PLUGIN_ID,
	PROJECT_ROOT,
	VAULT_PATH,
} from "./test-helpers";

export interface VaultResetOptions {
	/**
	 * Plugin settings written to the vault's data.json.
	 *   - omitted → `buildDefaultSettings()`
	 *   - `null`  → do not write data.json (plugin falls back to its own defaults)
	 */
	settings?: Record<string, unknown> | null;
	/** Keep `.obsidian/workspace.json` instead of deleting it (default: delete). */
	keepWorkspace?: boolean;
	/** Suppress the progress log line. */
	quiet?: boolean;
}

function ensurePluginEnabled(obsidianDir: string): void {
	const communityPluginsPath = path.join(obsidianDir, "community-plugins.json");
	let enabled: string[] = [];

	if (fs.existsSync(communityPluginsPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(communityPluginsPath, "utf8"));
			if (Array.isArray(parsed)) enabled = parsed;
		} catch {
			enabled = [];
		}
	}

	if (!enabled.includes(PLUGIN_ID)) {
		enabled.push(PLUGIN_ID);
		fs.writeFileSync(communityPluginsPath, JSON.stringify(enabled, null, 2));
	}
}

/** Copy the built plugin into the vault. Throws if the build output is missing. */
export function copyPluginIntoVault(vaultPath = VAULT_PATH): string {
	const mainJs = path.join(PROJECT_ROOT, "main.js");
	if (!fs.existsSync(mainJs)) {
		throw new Error(`main.js not found at ${mainJs} — run "npm run build" first`);
	}

	const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
	fs.mkdirSync(pluginDir, { recursive: true });

	fs.copyFileSync(mainJs, path.join(pluginDir, "main.js"));
	fs.copyFileSync(
		path.join(PROJECT_ROOT, "manifest.json"),
		path.join(pluginDir, "manifest.json"),
	);

	// This plugin ships no styles.css today; copy it if one is ever added.
	const styles = path.join(PROJECT_ROOT, "styles.css");
	if (fs.existsSync(styles)) {
		fs.copyFileSync(styles, path.join(pluginDir, "styles.css"));
	}

	return pluginDir;
}

export function resetVault(vaultPath = VAULT_PATH, options: VaultResetOptions = {}): void {
	if (!fs.existsSync(FIXTURE_VAULT_DIR)) {
		throw new Error(`Fixture vault missing at ${FIXTURE_VAULT_DIR}`);
	}

	const obsidianDir = path.join(vaultPath, ".obsidian");
	fs.mkdirSync(obsidianDir, { recursive: true });

	// 1. Wipe the note tree — everything except Obsidian's own config directory.
	for (const entry of fs.readdirSync(vaultPath)) {
		if (entry === ".obsidian") continue;
		fs.rmSync(path.join(vaultPath, entry), { recursive: true, force: true });
	}

	// 2. Rebuild the plugin dir from scratch (drops stale main.js and data.json),
	//    and clear the saved layout so no test inherits another's open tabs.
	fs.rmSync(path.join(obsidianDir, "plugins", PLUGIN_ID), { recursive: true, force: true });
	if (!options.keepWorkspace) {
		fs.rmSync(path.join(obsidianDir, "workspace.json"), { force: true });
	}

	// 3. Copy the fixture over: seed notes, plus the four .obsidian json files
	//    (overwriting whatever Obsidian rewrote during the last run).
	fs.cpSync(FIXTURE_VAULT_DIR, vaultPath, { recursive: true, force: true });

	// 4. Install the freshly built plugin.
	copyPluginIntoVault(vaultPath);

	// 5. Settings live inside the disposable vault, so just write them.
	if (options.settings !== null) {
		fs.writeFileSync(
			path.join(obsidianDir, "plugins", PLUGIN_ID, "data.json"),
			JSON.stringify(options.settings ?? buildDefaultSettings(), null, 2),
		);
	}

	// 6. Belt and braces — the fixture app.json already carries both flags.
	disableSettingsPopout(vaultPath);
	ensurePluginEnabled(obsidianDir);

	if (!options.quiet) {
		console.log(`[vault] Reset from fixture → ${vaultPath}`);
	}
}
