# End-to-end tests

These tests drive the plugin inside the **real Obsidian app**. There is no mocked
Obsidian API: a disposable vault is built from a committed fixture, the built plugin
is copied into it, Obsidian is launched against it, and Playwright attaches over the
Chrome DevTools Protocol to run commands and inspect the results.

Ported from the [notor](https://github.com/) plugin's e2e setup.

For the fast, Obsidian-free half of the test suite — the SuperMemo golden vectors and
the call contracts around them — see [`tests/`](../tests/README.md). Logic changes
should fail there first; this suite is for what only breaks inside the real app.

## How it works

```
                    ┌──────────────────────────────┐
  npm run e2e  ───▶  │  Playwright runner           │
                    │  e2e/tests/*.spec.ts         │
                    │  fixture: lib/obsidian-      │
                    │           fixture.ts         │
                    └──────────────┬───────────────┘
                                   │  shared lib/
  npx tsx           ┌──────────────┴───────────────┐
  e2e/scripts/  ──▶ │  Standalone harness          │
  *-test.ts         │  runTest() in                │
                    │  lib/test-harness.ts         │
                    └──────────────┬───────────────┘
                                   ▼
        1. reset e2e/test-vault/ from e2e/fixtures/vault/
        2. copy main.js + manifest.json into the vault's plugin dir
        3. write the plugin's data.json (settings for this test)
        4. spawn Obsidian: --user-data-dir=e2e/test-user-data
                           --remote-debugging-port=9222
        5. chromium.connectOverCDP() → find the page whose window.app has
           the plugin loaded
        6. run the test: app.commands.executeCommandById(...), click
           suggester rows, then assert on metadataCache frontmatter and
           the files on disk
        7. SIGTERM Obsidian
```

The plugin source is **not** instrumented for tests. Assertions read the same state
the user would see: `window.app`, the metadataCache, notices, and note files on disk.
The log collector captures console output and uncaught errors so a run can assert
"nothing threw".

## Prerequisites

- **Obsidian** installed at the default location, or `OBSIDIAN_PATH` set to the binary.
  - macOS: `/Applications/Obsidian.app`
  - Windows: `%LOCALAPPDATA%\Obsidian\Obsidian.exe`
  - Linux: on `$PATH`
- **Node 18+** and `npm install`.
- No `npx playwright install` needed: we attach to Obsidian's own Chromium rather
  than downloading a browser.

Your everyday Obsidian can stay open. The test instance uses its own
`--user-data-dir`, and Electron's single-instance lock is per user-data directory.

## Quick start

```bash
npm run build              # produces main.js at the repo root
npm run e2e:setup-vault    # creates e2e/test-vault/ from the fixture
npm run e2e                # run every spec
```

On the very first launch against a new vault, Obsidian may show a **"Trust author and
enable plugins"** dialog, and it opens the Community plugins settings pane by itself.
If the suite cannot find the plugin, run the debug runner and click through the
dialog once:

```bash
npm run e2e:run -- --duration 60 --skip-build
```

That state persists in `e2e/test-user-data/`, so it only has to be done once. **Do not
delete that directory** unless you want the dialog back.

### Everyday commands

```bash
npm run e2e                                   # all specs
npm run e2e -- tests/smoke.spec.ts            # one spec file
npm run e2e -- -g "Unfruitful"                # tests matching a name
E2E_SKIP_BUILD=1 npm run e2e                  # reuse the current main.js
npm run e2e:typecheck                         # typecheck e2e/ only

npm run e2e:run                               # launch, watch 15s, report
npm run e2e:run:quick                         # same, 10s
npm run e2e:run -- --duration 60 --skip-build # long interactive window

npx tsx e2e/scripts/smoke-test.ts             # a standalone harness script
```

## Layout

| Path | Tracked | What it is |
| --- | --- | --- |
| `fixtures/vault/` | yes | Seed vault: notes plus four `.obsidian` json files. Edit this to change test data. |
| `test-vault/` | no | Generated vault, rebuilt from the fixture before every test. Disposable. |
| `test-user-data/` | no | Electron profile for the test instance. Persistent — holds the vault registration and trust state. |
| `results/` | no | Logs, screenshots, `test-results.json`, per-script result files. |
| `lib/` | yes | Launcher, log collector, helpers, vault reset, Playwright fixture, standalone harness. |
| `tests/` | yes | Playwright specs. |
| `scripts/` | yes | Standalone harness scripts plus `setup-vault.ts`. |

`main.js` and `manifest.json` are **copied** into the vault on every reset (notor
symlinked a build directory instead; this repo builds `main.js` to the repo root).
A side effect worth knowing: the plugin's `data.json` lives inside the disposable
vault, so tests can set settings just by writing it before launch.

## Writing tests

### Spec style (the regression suite)

```ts
import { expect, test } from "../lib/obsidian-fixture";
import { CMD_LOG_REVIEW_OUTCOME, runCommand, waitForFrontmatter } from "../lib/test-helpers";

test.use({
  pluginSettings: { capturedThoughtDirectory: "Inbox" }, // merged into the defaults
  seedNote: "Overdue.md",                                // opened before the test
});

test("reviewing updates the interval", async ({ obsidianPage, logCollector }) => {
  expect(await runCommand(obsidianPage, CMD_LOG_REVIEW_OUTCOME)).toBe(true);
  // ...
});
```

Both `pluginSettings` and `seedNote` are option fixtures, settable per file or per
`describe`. `seedNote` defaults to `Plain.md`; pass `null` for an empty workspace.

### Harness style (exploration and debugging)

```ts
import { runTest, type TestContext } from "../lib/test-harness";

runTest({ name: "my-test", seedNote: "Plain.md" }, async (ctx: TestContext) => {
  ctx.check("some claim", condition, `detail`, await ctx.screenshot("01-state"));
});
```

Results land in `results/my-test-results.json`, screenshots in
`results/screenshots/my-test/`. `Passed: 0/0` means the harness died before any
assertion — look for `Fatal error`, not success.

### Helpers (`lib/test-helpers.ts`)

| Helper | Purpose |
| --- | --- |
| `openNote(page, path)` | Open a note and wait for it to be the active markdown view |
| `runCommand(page, id)` | `executeCommandById`; returns Obsidian's boolean |
| `getRegisteredCommandIds(page)` | The plugin's command ids, sorted |
| `getSuggestionTexts(page)` | Rows of the open suggester |
| `pickSuggestion(page, text)` | Click the row matching `text` **exactly** |
| `getFrontmatter` / `waitForFrontmatter` | Frontmatter via the metadataCache, with polling |
| `setFrontmatter(page, path, updates)` | Rewrite keys from a test, via `processFrontMatter` |
| `readVaultFile` / `listVaultFiles` | Read what actually landed on disk |
| `waitForNotice(page, substring)` | Wait for a notice and return its text |
| `getPluginSettings(page)` | The live settings object |
| `buildDefaultSettings(overrides)` | A full settings object mirroring `DEFAULT_SETTINGS` |
| `openPluginSettings` / `closeSettings` / `SETTINGS_CONTENT_SELECTOR` | Settings modal |
| `pollUntil(fn, pred)` | Generic polling |

`buildDefaultSettings()` is hand-maintained: importing `src/` would pull in the
`obsidian` module, which only exists inside the app. **Keep it in sync with
`DEFAULT_SETTINGS` in `src/main.ts`.** The smoke spec asserts the default spacing
method, so drift shows up as a failure there rather than as silent nonsense.

### Frontmatter keys the code writes

`se-interval`, `se-ease`, `se-last-reviewed`, `se-method`, `se-contexts`,
`se-capture-time`, and `aliases`. Assert on these, not on the names in the root
README: it documents `se-spacing-method`, but the code reads and writes `se-method`.
Note also that removing a note from Spaced Everything leaves `se-method` behind.

## Gotchas

Most of these cost someone hours once already.

- **Trust dialog.** One-time per vault; persists via the vault id pinned in
  `test-user-data/obsidian.json`. Keep that directory.
- **`editorCallback` commands need an active markdown view.** Without one,
  `executeCommandById` returns `false` and nothing happens. Call `openNote()` first,
  or rely on `seedNote`.
- **Frontmatter reads can catch a mid-write snapshot.** `processFrontMatter` rewrites
  the whole file and the metadataCache can briefly report empty or partial
  frontmatter. `waitForFrontmatter` therefore requires two consecutive passing polls,
  and predicates should assert the keys you are about to read are *present*
  (`typeof fm?.["se-interval"] === "number"`) rather than merely absent or changed.
  Skipping this produced intermittent `undefined` failures.
- **Suggester matching must be exact.** The default review options include both
  `Fruitful` and `Unfruitful`, and the suggester filters by substring.
  `pickSuggestion` matches whole row text for this reason.
- **Settings popout.** Obsidian 1.12+ mounts settings into a separate OS window with
  no `window.app` of its own, which breaks `document` queries, clicks and
  screenshots. The reset writes `settingsPopoutWindow: false` into the vault's
  `app.json` before launch. Don't fight it, and don't hunt for a popout page.
- **Open settings via the API.** `app.setting.openTabById(...)` (that is what
  `openPluginSettings` does). `Meta+,` works over CDP but lands on the About tab.
- **Scope settings queries** to `SETTINGS_CONTENT_SELECTOR`; the settings sidebar
  search renders `.setting-item` rows of its own.
- **The `__name` trap.** tsx compiles these files with esbuild, which rewrites nested
  function declarations inside a typed `page.evaluate` callback to an esbuild
  `__name` helper that does not exist in the page. It throws at runtime and the
  typecheck passes. Keep evaluate callbacks free of local function declarations
  (inline `.map`/`.filter` callbacks are fine), or use the template-string form.
- **Port 9222.** One Obsidian at a time owns it, hence `workers: 1`. If a run dies
  hard, check `lsof -i :9222`.
- **The test profile self-updates.** Obsidian may download a newer version into
  `test-user-data/` independently of `/Applications`, so the test instance can be a
  version ahead of your everyday app.
- **Production builds are minified**, so stack traces from page errors are terse.
  Run `npm run dev` and `E2E_SKIP_BUILD=1` for readable ones.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBSIDIAN_PATH` | auto-detected | Path to the Obsidian binary |
| `E2E_VAULT_PATH` | `e2e/test-vault` | Use a different vault |
| `CDP_PORT` | `9222` | Remote debugging port |
| `E2E_SKIP_BUILD` | unset | `1` skips the build in Playwright's global setup |

## Troubleshooting

**`Could not find a page with window.app.plugins.plugins["spaced-everything"]`**
The plugin never loaded. Check in order: `npm run build` was run (the vault gets a
copy of `main.js`), `.obsidian/community-plugins.json` lists the plugin, restricted
mode is off, and the one-time trust dialog has been accepted.

**Obsidian doesn't launch.** Verify the install path or set `OBSIDIAN_PATH`. Make
sure no earlier test instance is still holding port 9222.

**A test times out waiting on frontmatter.** The command probably didn't run
(`runCommand` returned `false`) or a suggester is still open waiting for a choice.
Check the failure screenshot Playwright attached, and
`results/logs/<test>/latest-summary.json`.

**Nothing seems to happen.** Watch it live: `npm run e2e:run -- --duration 60`
leaves a real, interactive Obsidian window open against the test vault.
