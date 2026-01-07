import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ImageContent,
  TextContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type {
  ContextPruningLogMode,
  EffectiveContextPruningSettings,
} from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
// We currently skip pruning tool results that contain images. Still, we count them (approx.) so
// we start trimming prunable tool results earlier when image-heavy context is consuming the window.
const IMAGE_CHAR_ESTIMATE = 8_000;

function asText(text: string): TextContent {
  return { type: "text", text };
}

function extractText(
  content: ReadonlyArray<TextContent | ImageContent>,
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

function hasImageBlocks(
  content: ReadonlyArray<TextContent | ImageContent>,
): boolean {
  for (const block of content) {
    if (block.type === "image") return true;
  }
  return false;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") return content.length;
    let chars = 0;
    for (const b of content) {
      if (b.type === "text") chars += b.text.length;
      if (b.type === "image") chars += IMAGE_CHAR_ESTIMATE;
    }
    return chars;
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") chars += b.text.length;
      if (b.type === "thinking") chars += b.thinking.length;
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") chars += b.text.length;
      if (b.type === "image") chars += IMAGE_CHAR_ESTIMATE;
    }
    return chars;
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) return messages.length;

  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    remaining--;
    if (remaining === 0) return i;
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function softTrimText(params: {
  text: string;
  headChars: number;
  tailChars: number;
}): string {
  const { text, headChars, tailChars } = params;
  if (headChars <= 0 && tailChars <= 0) return "";
  if (headChars + tailChars >= text.length) return text;

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return `${head}\n...\n${tail}`;
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  // Ignore image tool results for now: these are often directly relevant and hard to partially prune safely.
  if (hasImageBlocks(msg.content)) return null;

  const rawText = extractText(msg.content);
  if (rawText.length <= settings.softTrim.maxChars) return null;

  const trimmed = softTrimText({
    text: rawText,
    headChars: settings.softTrim.headChars,
    tailChars: settings.softTrim.tailChars,
  });

  const note = `\n\n[Tool result trimmed: kept first ${settings.softTrim.headChars} chars and last ${settings.softTrim.tailChars} chars of ${rawText.length} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

export type ContextPruningLogEntry = {
  cutoffIndex: number;
  keepLastAssistants: number;
  contextWindowTokens: number;
  charWindow: number;
  totalCharsBefore: number;
  totalCharsAfter: number;
  ratioBefore: number;
  ratioAfter: number;
  softTrimRatio: number;
  hardClearRatio: number;
  minPrunableToolChars: number;
  prunableToolResults: number;
  skippedToolResultsWithImages: number;
  softTrimmedToolResults: number;
  hardClearedToolResults: number;
  hardClearEligibleToolChars: number;
};

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  contextWindowTokensOverride?: number;
  logMode?: ContextPruningLogMode;
  onLogEntry?: (entry: ContextPruningLogEntry) => void;
}): AgentMessage[] {
  const { messages, settings, ctx } = params;
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) return messages;

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) return messages;

  const cutoffIndex = findAssistantCutoffIndex(
    messages,
    settings.keepLastAssistants,
  );
  if (cutoffIndex === null) return messages;

  const onLogEntry = params.onLogEntry;
  const shouldLog = typeof onLogEntry === "function";
  const logEvenIfNoop = params.logMode === "always";

  const totalCharsBefore = estimateContextChars(messages);
  let totalChars = totalCharsBefore;
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    if (shouldLog && logEvenIfNoop) {
      onLogEntry({
        cutoffIndex,
        keepLastAssistants: settings.keepLastAssistants,
        contextWindowTokens,
        charWindow,
        totalCharsBefore,
        totalCharsAfter: totalCharsBefore,
        ratioBefore: ratio,
        ratioAfter: ratio,
        softTrimRatio: settings.softTrimRatio,
        hardClearRatio: settings.hardClearRatio,
        minPrunableToolChars: settings.minPrunableToolChars,
        prunableToolResults: 0,
        skippedToolResultsWithImages: 0,
        softTrimmedToolResults: 0,
        hardClearedToolResults: 0,
        hardClearEligibleToolChars: 0,
      });
    }
    return messages;
  }

  const isToolPrunable = makeToolPrunablePredicate(settings.tools);
  const prunableToolIndexes: number[] = [];
  let skippedToolResultsWithImages = 0;
  let softTrimmedToolResults = 0;
  let next: AgentMessage[] | null = null;

  for (let i = 0; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") continue;
    if (!isToolPrunable(msg.toolName)) continue;
    if (hasImageBlocks(msg.content)) {
      skippedToolResultsWithImages++;
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) continue;

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) next = messages.slice();
    next[i] = updated as unknown as AgentMessage;
    softTrimmedToolResults++;
  }

  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    if (shouldLog && (logEvenIfNoop || softTrimmedToolResults > 0)) {
      onLogEntry({
        cutoffIndex,
        keepLastAssistants: settings.keepLastAssistants,
        contextWindowTokens,
        charWindow,
        totalCharsBefore,
        totalCharsAfter: totalChars,
        ratioBefore: totalCharsBefore / charWindow,
        ratioAfter: ratio,
        softTrimRatio: settings.softTrimRatio,
        hardClearRatio: settings.hardClearRatio,
        minPrunableToolChars: settings.minPrunableToolChars,
        prunableToolResults: prunableToolIndexes.length,
        skippedToolResultsWithImages,
        softTrimmedToolResults,
        hardClearedToolResults: 0,
        hardClearEligibleToolChars: 0,
      });
    }
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    if (shouldLog && logEvenIfNoop) {
      onLogEntry({
        cutoffIndex,
        keepLastAssistants: settings.keepLastAssistants,
        contextWindowTokens,
        charWindow,
        totalCharsBefore,
        totalCharsAfter: totalChars,
        ratioBefore: totalCharsBefore / charWindow,
        ratioAfter: ratio,
        softTrimRatio: settings.softTrimRatio,
        hardClearRatio: settings.hardClearRatio,
        minPrunableToolChars: settings.minPrunableToolChars,
        prunableToolResults: prunableToolIndexes.length,
        skippedToolResultsWithImages,
        softTrimmedToolResults,
        hardClearedToolResults: 0,
        hardClearEligibleToolChars: 0,
      });
    }
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") continue;
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    if (shouldLog && logEvenIfNoop) {
      onLogEntry({
        cutoffIndex,
        keepLastAssistants: settings.keepLastAssistants,
        contextWindowTokens,
        charWindow,
        totalCharsBefore,
        totalCharsAfter: totalChars,
        ratioBefore: totalCharsBefore / charWindow,
        ratioAfter: ratio,
        softTrimRatio: settings.softTrimRatio,
        hardClearRatio: settings.hardClearRatio,
        minPrunableToolChars: settings.minPrunableToolChars,
        prunableToolResults: prunableToolIndexes.length,
        skippedToolResultsWithImages,
        softTrimmedToolResults,
        hardClearedToolResults: 0,
        hardClearEligibleToolChars: prunableToolChars,
      });
    }
    return outputAfterSoftTrim;
  }

  let hardClearedToolResults = 0;
  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) break;
    const current = (next ?? messages)[i];
    const msg = current;
    if (!msg || msg.role !== "toolResult") continue;

    const beforeChars = estimateMessageChars(msg);
    const cleared: ToolResultMessage = {
      ...msg,
      content: [asText(settings.hardClear.placeholder)],
    };
    if (!next) next = messages.slice();
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
    hardClearedToolResults++;
  }

  if (
    shouldLog &&
    (logEvenIfNoop || softTrimmedToolResults > 0 || hardClearedToolResults > 0)
  ) {
    onLogEntry({
      cutoffIndex,
      keepLastAssistants: settings.keepLastAssistants,
      contextWindowTokens,
      charWindow,
      totalCharsBefore,
      totalCharsAfter: totalChars,
      ratioBefore: totalCharsBefore / charWindow,
      ratioAfter: ratio,
      softTrimRatio: settings.softTrimRatio,
      hardClearRatio: settings.hardClearRatio,
      minPrunableToolChars: settings.minPrunableToolChars,
      prunableToolResults: prunableToolIndexes.length,
      skippedToolResultsWithImages,
      softTrimmedToolResults,
      hardClearedToolResults,
      hardClearEligibleToolChars: prunableToolChars,
    });
  }

  return next ?? messages;
}
