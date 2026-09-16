/**
 * Headless test harness: load `src/*.ts` and drive the plugin without Obsidian.
 *
 * There is no Obsidian runtime outside the app, so these tests bundle the
 * TypeScript in memory with esbuild (already a devDependency, used by the real
 * build) and substitute a minimal `obsidian` module. Nothing is written to disk
 * and no generated test files are needed.
 *
 * This complements `e2e/`, which drives the real app. Use these tests to pin
 * pure logic and call contracts cheaply; use the e2e suite to prove the plugin
 * actually works inside Obsidian.
 *
 * The `obsidian` stand-ins only need to be *constructible*: `src/` declares
 * classes that extend `Plugin`, `SuggestModal`, `Modal` and `PluginSettingTab`
 * at module scope, so those base classes are evaluated the moment the bundle
 * loads, whether or not a test touches them.
 */

const path = require("node:path");
const { buildSync } = require("esbuild");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Compiled bundles, keyed by entry point. esbuild is slow enough to be worth caching. */
const bundleCache = new Map();

/**
 * Bundle a TypeScript entry point to CommonJS source text.
 *
 * `platform: "node"` and `format: "cjs"` match how the plugin ships (see
 * esbuild.config.mjs), so the module semantics tests observe are the shipped
 * ones — in particular non-strict CJS, which the `suggester()` helper depends on
 * (it reads `this.app`, where `this` is the global object at runtime).
 */
function bundle(entry) {
	if (!bundleCache.has(entry)) {
		const result = buildSync({
			entryPoints: [path.join(PROJECT_ROOT, entry)],
			bundle: true,
			write: false,
			platform: "node",
			format: "cjs",
			target: "es2018",
			external: ["obsidian", "electron"],
		});
		bundleCache.set(entry, result.outputFiles[0].text);
	}
	return bundleCache.get(entry);
}

/**
 * Evaluate a bundled entry point with `require` calls resolved against `mocks`.
 *
 * @param {string} entry - Repo-relative entry point, e.g. `"src/main.ts"`.
 * @param {Record<string, unknown>} mocks - Module id → replacement module.
 * @returns {Record<string, any>} The entry point's exports.
 */
function loadModule(entry, mocks = {}) {
	const text = bundle(entry);
	const module = { exports: {} };
	const requireShim = (id) =>
		Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : require(id);

	// eslint-disable-next-line no-new-func
	new Function("require", "module", "exports", text)(requireShim, module, module.exports);

	return module.exports;
}

/**
 * A stand-in for the `obsidian` module.
 *
 * `notices` collects every `new Notice(...)` message in order, which is how the
 * tests assert on user-facing feedback.
 */
function createObsidianMock() {
	const notices = [];

	class Notice {
		constructor(message) {
			this.message = message;
			notices.push(String(message));
		}
		hide() {}
	}

	class Stub {
		constructor(...args) {
			this.args = args;
		}
	}

	class Modal extends Stub {
		open() {}
		close() {}
	}

	/**
	 * Opening a suggester is a no-op by default, so `suggester()` never resolves
	 * and a test that reaches an unexpected prompt hangs rather than silently
	 * picking something. Tests that *expect* a prompt install `onOpen` via
	 * `harness.answerSuggester()`.
	 */
	class SuggestModal extends Stub {
		open() {
			SuggestModal.onOpen?.(this);
		}
		close() {}
	}
	SuggestModal.onOpen = null;

	class Setting {
		constructor() {
			// Every configuration method returns `this` so settings.ts can chain.
			return new Proxy(this, { get: () => () => this });
		}
	}

	const obsidian = {
		App: Stub,
		Editor: Stub,
		MarkdownView: Stub,
		Modal,
		Notice,
		Plugin: Stub,
		PluginSettingTab: Stub,
		Setting,
		SuggestModal,
		TAbstractFile: Stub,
		TFile: Stub,
		TFolder: Stub,
		normalizePath: (p) => p,
	};

	return { obsidian, notices, SuggestModal };
}

/** DEFAULT_SETTINGS is not exported from src/main.ts, so mirror the parts tests need. */
function defaultSpacingMethod(overrides = {}) {
	return {
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
		...overrides,
	};
}

function defaultSettings(overrides = {}) {
	return {
		logFilePath: "",
		logOnboardAction: true,
		logRemoveAction: true,
		logNoteTitle: true,
		logFrontMatterProperties: [],
		contexts: [],
		spacingMethods: [defaultSpacingMethod()],
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

/**
 * Build a plugin instance wired to recording doubles.
 *
 * The plugin is constructed without running `onload()`: these tests exercise
 * individual methods, so registering commands and settings tabs would only add
 * Obsidian surface to fake. Collaborators the methods under test reach for
 * (`app`, `settings`, `logger`, the frontmatter queue) are supplied directly.
 *
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.frontmatter]
 *   Starting frontmatter for the note under test, as `processFrontMatter` would
 *   hand it to a callback. Mutations the plugin makes are visible afterwards on
 *   `harness.frontmatter`, which is how tests detect direct writes.
 * @param {Record<string, unknown>} [options.settings] - Merged over the defaults.
 * @param {string} [options.notePath]
 * @returns {object} The harness: `plugin`, `file`, `frontmatter`, `notices`,
 *   `queued`, `logs`, `processedQueue`, and `answerSuggester()`.
 */
function createPluginHarness({ frontmatter = {}, settings = {}, notePath = "Note.md" } = {}) {
	const { obsidian, notices, SuggestModal } = createObsidianMock();
	const { default: SpacedEverythingPlugin } = loadModule("src/main.ts", { obsidian });

	const plugin = new SpacedEverythingPlugin();
	const file = { path: notePath, basename: notePath.replace(/\.md$/, ""), extension: "md" };
	const noteFrontmatter = { ...frontmatter };

	/** Every `queueFrontmatterUpdate` call, in order. */
	const queued = [];
	/** Every `logger.log` call, in order, as an argument array. */
	const logs = [];
	/** One entry per `processFrontmatterQueue()` call: the queue as it was flushed. */
	const processedQueue = [];

	plugin.settings = defaultSettings(settings);

	plugin.app = {
		workspace: { getActiveFile: () => file },
		metadataCache: { getFileCache: () => ({ frontmatter: noteFrontmatter }) },
		fileManager: {
			processFrontMatter: async (target, callback) => {
				if (target !== file) throw new Error(`processFrontMatter called with ${target?.path}`);
				await callback(noteFrontmatter);
			},
		},
		vault: { getMarkdownFiles: () => [file] },
	};

	// `suggester()` reads `this.app`, which is the global object under CJS.
	globalThis.app = plugin.app;

	plugin.logger = { log: (...args) => logs.push(args) };

	plugin.queueFrontmatterUpdate = (target, updates) => {
		queued.push({ file: target, updates });
	};
	plugin.processFrontmatterQueue = async () => {
		processedQueue.push(queued.map((entry) => entry.updates));
	};

	/** One entry per suggester opened: `{ promptText, items }`. */
	const prompts = [];

	return {
		plugin,
		file,
		notices,
		queued,
		logs,
		processedQueue,
		prompts,
		/** The live frontmatter object; unchanged unless the plugin wrote to it directly. */
		frontmatter: noteFrontmatter,
		/**
		 * Answer the next suggester prompt(s) with `choices`, in order.
		 *
		 * Every prompt that opens is appended to `harness.prompts`, so a test can
		 * assert on what the user was offered as well as what they picked.
		 *
		 * `null` answers as if the user pressed Escape. An unanswered prompt throws
		 * rather than hanging, so an unexpected extra prompt fails loudly.
		 */
		answerSuggester(...choices) {
			const remaining = [...choices];
			SuggestModal.onOpen = (modal) => {
				prompts.push({ promptText: modal.promptText, items: modal.items });
				if (remaining.length === 0) {
					throw new Error(`Unexpected suggester prompt with items ${JSON.stringify(modal.items)}`);
				}
				// Resolve asynchronously: the real modal never calls back synchronously
				// from open(), and main.ts awaits the promise.
				const choice = remaining.shift();
				setImmediate(() => modal.onChooseItem(choice));
			};
		},
	};
}

module.exports = {
	PROJECT_ROOT,
	bundle,
	loadModule,
	createObsidianMock,
	createPluginHarness,
	defaultSettings,
	defaultSpacingMethod,
};
