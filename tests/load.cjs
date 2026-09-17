const { buildSync } = require('esbuild');

// Bundle TypeScript in memory; no Obsidian runtime or generated test files needed.
exports.load = (entry, mocks = {}) => {
  const { text } = buildSync({ entryPoints: [entry], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0];
  const module = { exports: {} };
  new Function('require', 'module', 'exports', text)(
    name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : require(name),
    module, module.exports);
  return module.exports;
};
