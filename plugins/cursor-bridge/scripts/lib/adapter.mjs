// The provider module is copied next to this file by `scripts/build.mjs`.
// See `providers/README.md` for the contract it implements.
import provider from "./provider.mjs";

export const adapter = Object.freeze({
  sessionEnv: "AGENT_BRIDGES_SESSION_ID",
  efforts: null,
  promptVia: "arg",
  maxArgPromptChars: 24000,
  structuredOutput: "prompt",
  versionArgs: ["--version"],
  authArgs: null,
  readOnlyEnforced: () => true,
  // Every plugin writes to the same CLAUDE_ENV_FILE, so CLAUDE_PLUGIN_DATA
  // exported there would be clobbered by whichever plugin ran last.
  dataEnv: `AGENT_BRIDGES_DATA_${provider.id.toUpperCase()}`,
  ...provider
});

export function bridgeCommand(name, ...rest) {
  const suffix = rest.filter((part) => part != null && part !== "").join(" ");
  return `/${adapter.pluginName}:${name}${suffix ? ` ${suffix}` : ""}`;
}
