/**
 * Opt-in context pruning (“microcompact”-style) for Pi sessions.
 *
 * This only affects the in-memory context for the current request; it does not rewrite session
 * history persisted on disk.
 */

export { default } from "./context-pruning/extension.js";

export type { ContextPruningLogEntry } from "./context-pruning/pruner.js";
export { pruneContextMessages } from "./context-pruning/pruner.js";
export type {
  ContextPruningConfig,
  ContextPruningLogConfig,
  ContextPruningLogMode,
  ContextPruningToolMatch,
  EffectiveContextPruningSettings,
} from "./context-pruning/settings.js";
export {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
} from "./context-pruning/settings.js";
