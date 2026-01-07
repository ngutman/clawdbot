import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { loadSettingsFromEnv } from "./env.js";
import { type ContextPruningLogEntry, pruneContextMessages } from "./pruner.js";

const ENTRY_TYPE = "clawdbot.contextPruning";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId?.();
    const loaded = loadSettingsFromEnv({ sessionId });
    if (!loaded) return undefined;
    let logEntry: ContextPruningLogEntry | null = null;
    const next = pruneContextMessages({
      messages: event.messages as AgentMessage[],
      settings: loaded.settings,
      ctx,
      contextWindowTokensOverride: loaded.contextWindowTokens,
      logMode: loaded.settings.log.mode,
      onLogEntry: loaded.settings.log.enabled
        ? (entry) => {
            logEntry = entry;
          }
        : undefined,
    });
    if (loaded.settings.log.enabled && logEntry) {
      const changed = next !== event.messages;
      if (loaded.settings.log.mode === "always" || changed) {
        api.appendEntry(ENTRY_TYPE, logEntry);
      }
    }
    if (next === event.messages) return undefined;
    return { messages: next };
  });
}
