import type { EffectiveContextPruningSettings } from "./settings.js";
import { computeEffectiveSettings } from "./settings.js";

const ENV_SETTINGS = "CLAWDBOT_PI_CONTEXT_PRUNING";
const ENV_VERSION = 1;

type ContextPruningEnvPayloadV1 = {
  v: number;
  bySessionId?: Record<
    string,
    { config?: unknown; contextWindowTokens?: number | null }
  >;
};

export function loadSettingsFromEnv(params: { sessionId?: string }): {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number;
} | null {
  const raw = process.env[ENV_SETTINGS];
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const v = (parsed as { v?: unknown }).v;
    if (v !== ENV_VERSION) return null;
    const bySessionId = (parsed as ContextPruningEnvPayloadV1).bySessionId;
    if (!bySessionId || typeof bySessionId !== "object") return null;
    if (!params.sessionId) return null;

    const entry = bySessionId[params.sessionId];
    const cfg = entry?.config;
    if (!cfg) return null;
    const contextWindowTokens =
      typeof entry.contextWindowTokens === "number" &&
      Number.isFinite(entry.contextWindowTokens) &&
      entry.contextWindowTokens > 0
        ? entry.contextWindowTokens
        : undefined;
    const settings = computeEffectiveSettings(cfg);
    if (!settings) return null;
    return {
      settings,
      contextWindowTokens,
    };
  } catch {
    return null;
  }
}
