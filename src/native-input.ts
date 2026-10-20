import { z } from "zod";
import type { Message } from "./traces.js";
import type { NativeContext } from "./native-timing.js";
import type { Span } from "./schema.js";

/** This is the CLI's text/tool request snapshot, not the provider's wire payload. */
export function enrichNativeInput(
  span: Span,
  context: NativeContext,
  maxChars: number,
) {
  let truncated = false;
  const clip = (value: string) => {
    if (value.length <= maxChars) return value;
    truncated = true;
    return value.slice(0, maxChars) + "\n[truncated by lmnr-antigravity]";
  };
  const roles = {
    0: "unspecified",
    1: "user",
    2: "assistant",
    3: "unknown",
    4: "tool",
    5: "system",
    6: "context",
  } as const;
  const messages: Message[] = [];
  if (context.systemPrompt)
    messages.push({ role: "system", content: clip(context.systemPrompt) });
  for (const message of context.messagePrompts) {
    messages.push({
      role: roles[message.source],
      ...(message.prompt !== undefined && !message.toolCalls
        ? { content: clip(message.prompt) }
        : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls
        ? {
            parts: [
              ...(message.prompt === undefined
                ? []
                : [{ type: "text" as const, content: clip(message.prompt) }]),
              ...message.toolCalls.map((call) => ({
                type: "tool_call" as const,
                id: call.id,
                name: call.name,
                arguments:
                  call.argumentsJson.length > maxChars
                    ? { _truncated: clip(call.argumentsJson) }
                    : z
                        .record(z.string(), z.json())
                        .parse(JSON.parse(call.argumentsJson)),
              })),
            ],
          }
        : {}),
    });
  }
  span.attributes = span.attributes.filter(
    (a) => a.key !== "gen_ai.input.messages",
  );
  span.attributes.push(
    {
      key: "gen_ai.input.messages",
      value: { stringValue: JSON.stringify(messages) },
    },
    {
      key: "gen_ai.tool.definitions",
      value: {
        stringValue: JSON.stringify(
          context.tools.map((tool) => ({
            name: tool.name,
            description:
              tool.description === undefined
                ? undefined
                : clip(tool.description),
            parameters: z
              .record(z.string(), z.json())
              .parse(JSON.parse(tool.jsonSchemaString)),
          })),
        ),
      },
    },
    {
      key: "antigravity.input_source",
      value: { stringValue: "cli_sqlite_request_snapshot" },
    },
    {
      key: "antigravity.input_scope",
      value: {
        stringValue:
          "native_text_system_history_and_tools_without_media_or_provider_envelope",
      },
    },
    { key: "antigravity.input_truncated", value: { boolValue: truncated } },
    {
      key: "antigravity.native.generator_index",
      value: { intValue: String(context.generatorIndex) },
    },
    {
      key: "antigravity.native.message_count",
      value: { intValue: String(context.messagePrompts.length) },
    },
  );
}
