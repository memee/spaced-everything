#!/usr/bin/env npx tsx
/**
 * Set up (or re-create) the generated test vault.
 *
 * Run this once after `npm run build` before the first e2e run, so Obsidian's
 * one-time "Trust author and enable plugins" dialog can be accepted against a vault
 * that already exists. After that the test fixtures reset the vault themselves, so
 * this script is mainly for inspecting or repairing the vault by hand.
 *
 * Usage:
 *   npx tsx e2e/scripts/setup-vault.ts
 *   npx tsx e2e/scripts/setup-vault.ts --clean          # delete the vault first
 *   npx tsx e2e/scripts/setup-vault.ts --vault /path    # use a different location
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resetVault } from "../lib/vault-reset";
import { FIXTURE_VAULT_DIR, MANIFEST, PLUGIN_ID, PROJECT_ROOT, VAULT_PATH } from "../lib/test-helpers";

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
	const idx = args.indexOf(`--${name}`);
	const value = idx !== -1 ? args[idx + 1] : undefined;
	return value ?? defaultVal;
}

const vaultPath = path.resolve(getArg("vault", VAULT_PATH));
const clean = args.includes("--clean");

console.log(`=== Set up test vault for ${MANIFEST.name} (${PLUGIN_ID}) ===`);
console.log(`Fixture: ${FIXTURE_VAULT_DIR}`);
console.log(`Vault:   ${vaultPath}`);

if (!fs.existsSync(path.join(PROJECT_ROOT, "main.js"))) {
	console.error("\nmain.js is missing — run 'npm run build' first!");
	process.exit(1);
}

if (clean && fs.existsSync(vaultPath)) {
	console.log("Removing existing vault (--clean)...");
	fs.rmSync(vaultPath, { recursive: true, force: true });
}

resetVault(vaultPath, { quiet: true });

const pluginDir = path.join(vaultPath, ".obsidian", "plugins", PLUGIN_ID);
const checks: Array<[string, boolean]> = [
	["vault directory", fs.existsSync(vaultPath)],
	[".obsidian directory", fs.existsSync(path.join(vaultPath, ".obsidian"))],
	["plugin directory", fs.existsSync(pluginDir)],
	["plugin main.js", fs.existsSync(path.join(pluginDir, "main.js"))],
	["plugin manifest.json", fs.existsSync(path.join(pluginDir, "manifest.json"))],
	["plugin data.json", fs.existsSync(path.join(pluginDir, "data.json"))],
	[
		`community-plugins.json lists ${PLUGIN_ID}`,
		(() => {
			const file = path.join(vaultPath, ".obsidian", "community-plugins.json");
			if (!fs.existsSync(file)) return false;
			try {
				return JSON.parse(fs.readFileSync(file, "utf8")).includes(PLUGIN_ID);
			} catch {
				return false;
			}
		})(),
	],
];

console.log("");
let ok = true;
for (const [label, passed] of checks) {
	console.log(`  ${passed ? "✓" : "✗"} ${label}`);
	if (!passed) ok = false;
}

const notes = fs.readdirSync(vaultPath).filter((f) => f.endsWith(".md")).sort();
console.log(`\nSeed notes: ${notes.join(", ") || "(none)"}`);

if (!ok) {
	console.error("\nVault setup incomplete — see the failed checks above.");
	process.exit(1);
}

console.log("\nVault ready. Next: npm run e2e:run -- --duration 60 --skip-build");
console.log("On the very first launch, accept Obsidian's \"Trust author\" dialog once.");
