// Identity of the hub for the shared core libraries (state, jobs, rendering).
// The hub drives no CLI of its own: every step runs through an installed
// bridge plugin (see scripts/lib/registry.mjs). `scripts/build.mjs` copies
// this file to scripts/lib/provider.mjs.
export default {
  id: "hub",
  pluginName: "bridges-hub",
  displayName: "Bridges Hub",
  productName: "Bridges Hub",
  cliName: "node",
  resumeCommand: () => null
};
