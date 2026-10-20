import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  EventRecord,
  ExportRequest,
  Span,
  StopPayload,
  TranscriptRow,
  ToolCall,
} from "./schema.js";

function id(seed: string, length: number): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}
function nano(timestamp: string): string {
  return (BigInt(Date.parse(timestamp)) * 1_000_000n).toString();
}
function attributes(
  values: Record<string, string | number | boolean>,
): Span["attributes"] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { intValue: String(value) },
  }));
}
function text(value: string, limit: number): string {
  return value.length > limit
    ? value.slice(0, limit) + "\n[truncated by lmnr-antigravity]"
    : value;
}
function json(value: unknown, limit: number): string {
  const encoded = JSON.stringify(value);
  assert(encoded !== undefined);
  // Keep the JSON valid after limiting large tool payloads.
  return encoded.length > limit
    ? JSON.stringify(text(encoded, limit))
    : encoded;
}

function invocationForStep(step: number, events: EventRecord[]) {
  // Resuming a conversation can insert SYSTEM_MESSAGE after initialNumSteps.
  const pre = events.findLast(
    (e) =>
      e.payload.event === "PreInvocation" && e.payload.initialNumSteps <= step,
  );
  assert(
    pre?.payload.event === "PreInvocation",
    `Missing PreInvocation for step ${step}`,
  );
  const payload = pre.payload;
  const post = events.find(
    (e) =>
      e.payload.event === "PostInvocation" &&
      e.payload.initialNumSteps === payload.initialNumSteps &&
      e.payload.invocationNum === payload.invocationNum &&
      e.at >= pre.at,
  );
  assert(post, `Missing PostInvocation for step ${step}`);
  return { pre: { at: pre.at, payload }, post };
}

/** One trace per explicit user turn; model/tool spans are siblings below it. */
export function buildExport(
  rows: TranscriptRow[],
  events: EventRecord[],
  stop: StopPayload,
  throughStep: number,
  maxChars: number,
): { request: ExportRequest; throughStep: number } | null {
  const firstInvocation = events.find(
    (e) => e.payload.event === "PreInvocation",
  );
  assert(
    firstInvocation?.payload.event === "PreInvocation",
    "No recorded PreInvocation; refusing to export unobserved history",
  );
  const firstStep = firstInvocation.payload.initialNumSteps;
  const observedUser = rows.findLast(
    (r) =>
      r.type === "USER_INPUT" &&
      r.source === "USER_EXPLICIT" &&
      r.step_index < firstStep,
  );
  assert(
    observedUser,
    "No explicit user turn before first observed invocation",
  );
  const starts = rows.filter(
    (r) =>
      r.type === "USER_INPUT" &&
      r.source === "USER_EXPLICIT" &&
      r.step_index >= observedUser.step_index &&
      r.step_index > throughStep,
  );
  if (starts.length === 0) return null;
  const spans: Span[] = [];
  let exportedThrough = throughStep;
  for (const [turnIndex, user] of starts.entries()) {
    const next = starts[turnIndex + 1];
    const turnRows = rows.filter(
      (r) =>
        r.step_index >= user.step_index &&
        (next === undefined || r.step_index < next.step_index),
    );
    const last = turnRows.at(-1);
    assert(
      last && last.step_index > user.step_index,
      "Transcript has no model output yet; retry this Stop after it flushes",
    );
    const models = turnRows.filter((r) => r.type === "PLANNER_RESPONSE");
    assert(models.length > 0, "Turn has no model response");
    const traceId = id(
      `antigravity:${stop.conversationId}:${user.step_index}`,
      32,
    );
    const rootId = id(`${traceId}:root`, 16);
    const lastModel = models.at(-1)!;
    const { post: lastPost } = invocationForStep(lastModel.step_index, events);
    const finish = events.find(
      (e) =>
        e.payload.event === "Stop" &&
        e.payload.fullyIdle &&
        e.at >= lastPost.at,
    );
    assert(finish?.payload.event === "Stop", "Missing Stop event for turn");
    const session = {
      "lmnr.association.properties.session_id": stop.conversationId,
    };
    const makeSpan = (
      name: string,
      key: string,
      start: string,
      end: string,
      attrs: Record<string, string | number | boolean>,
      error?: string,
    ): Span => {
      assert(Date.parse(end) >= Date.parse(start), `Negative duration: ${key}`);
      return {
        traceId,
        spanId: id(`${traceId}:${key}`, 16),
        parentSpanId: rootId,
        name,
        kind: 1,
        startTimeUnixNano: nano(start),
        endTimeUnixNano: nano(end),
        attributes: attributes({ ...session, ...attrs }),
        status: error
          ? { code: 2, message: text(error, maxChars) }
          : { code: 1 },
      };
    };
    const prompt = user.content;
    assert(prompt !== undefined, "User content missing");
    const inputMessages: { role: string; content: string }[] = [
      { role: "user", content: text(prompt, maxChars) },
    ];
    const coveredTools = new Set<number>();
    for (const model of models) {
      const { pre, post } = invocationForStep(model.step_index, events);
      for (const system of turnRows.filter(
        (r) =>
          r.type === "SYSTEM_MESSAGE" &&
          r.step_index >= pre.payload.initialNumSteps &&
          r.step_index < model.step_index,
      )) {
        assert(
          system.source === "SYSTEM" && system.content !== undefined,
          "Invalid SYSTEM_MESSAGE",
        );
        inputMessages.push({
          role: "system",
          content: text(system.content, maxChars),
        });
      }
      const following: number =
        models.find((m) => m.step_index > model.step_index)?.step_index ??
        last.step_index + 1;
      const tools: EventRecord[] = events.filter(
        (e) =>
          e.payload.event === "PreToolUse" &&
          e.payload.stepIdx > model.step_index &&
          e.payload.stepIdx < following,
      );
      assert(
        tools.length === (model.tool_calls?.length ?? 0),
        `Tool-call/hook mismatch at step ${model.step_index}`,
      );
      // In agy 1.4.2 PostInvocation follows tool execution. End the model span
      // at the first tool hook, not after all tools have run.
      const modelEnd = tools[0]?.at ?? post.at;
      const parts: (
        | { type: "text"; content: string }
        | {
            type: "tool_call";
            id: string;
            name: string;
            arguments: ToolCall["args"];
          }
      )[] = [];
      if (model.content !== undefined)
        parts.push({ type: "text", content: text(model.content, maxChars) });
      for (const tool of tools) {
        assert(tool.payload.event === "PreToolUse");
        const call = tool.payload.toolCall;
        parts.push({
          type: "tool_call",
          id: `step-${tool.payload.stepIdx}`,
          name: call.name,
          arguments:
            JSON.stringify(call.args).length > maxChars
              ? { _truncated: text(JSON.stringify(call.args), maxChars) }
              : call.args,
        });
      }
      const attrs: Record<string, string | number | boolean> = {
        "lmnr.span.type": "LLM",
        "gen_ai.request.model": pre.payload.modelName,
        "gen_ai.response.model": pre.payload.modelName,
        "gen_ai.input.messages": JSON.stringify(inputMessages),
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", parts },
        ]),
        "antigravity.step_index": model.step_index,
        "antigravity.timing_source": "hook_wall_clock",
      };
      for (const [field, target] of [
        ["output_tokens", "output_tokens"],
        ["cache_read_tokens", "cache_read_input_tokens"],
        ["thinking_tokens", "reasoning_tokens"],
      ] as const) {
        if (model[field] !== undefined)
          attrs[`gen_ai.usage.${target}`] = model[field];
      }
      if (model.input_tokens !== undefined) {
        assert(
          model.cache_read_tokens !== undefined,
          "Cannot normalize input tokens without the cache counter",
        );
        // agy 1.4.2 reports uncached input separately; Laminar/OTel input
        // includes cached input. Preserve both source counters explicitly.
        attrs["antigravity.usage.uncached_input_tokens"] = model.input_tokens;
        attrs["antigravity.usage.cache_read_tokens"] = model.cache_read_tokens;
        attrs["gen_ai.usage.input_tokens"] =
          model.input_tokens + model.cache_read_tokens;
      }
      spans.push(
        makeSpan(
          `LLM ${pre.payload.invocationNum + 1}`,
          `llm:${model.step_index}`,
          pre.at,
          modelEnd,
          attrs,
        ),
      );
      if (model.content !== undefined)
        inputMessages.push({
          role: "assistant",
          content: text(model.content, maxChars),
        });
      for (const tool of tools) {
        assert(tool.payload.event === "PreToolUse");
        const p = tool.payload;
        const end = events.find(
          (e) =>
            e.payload.event === "PostToolUse" &&
            e.payload.stepIdx === p.stepIdx &&
            e.at >= tool.at,
        );
        assert(
          end?.payload.event === "PostToolUse",
          `Missing PostToolUse for step ${p.stepIdx}`,
        );
        assert.deepEqual(end.payload.toolCall, p.toolCall);
        const result = turnRows.find((r) => r.step_index === p.stepIdx);
        assert(
          result?.type === "GENERIC" && result.content !== undefined,
          `Unsupported tool result at step ${p.stepIdx}`,
        );
        coveredTools.add(p.stepIdx);
        spans.push(
          makeSpan(
            p.toolCall.name,
            `tool:${p.stepIdx}`,
            tool.at,
            end.at,
            {
              "lmnr.span.type": "TOOL",
              "lmnr.span.input": json(p.toolCall.args, maxChars),
              "lmnr.span.output": json(result.content, maxChars),
              "antigravity.step_index": p.stepIdx,
            },
            end.payload.error,
          ),
        );
        inputMessages.push({
          role: "tool",
          content: text(result.content, maxChars),
        });
      }
    }
    for (const row of turnRows) {
      assert(
        row.type !== "GENERIC" || coveredTools.has(row.step_index),
        `Unmapped GENERIC step ${row.step_index}`,
      );
      assert(
        row.type !== "USER_INPUT" || row.step_index === user.step_index,
        `Unsupported injected input at step ${row.step_index}`,
      );
    }
    const root = makeSpan(
      `Antigravity - Turn at step ${user.step_index} (${stop.conversationId.slice(0, 8)})`,
      "root",
      user.created_at,
      finish.at,
      {
        "lmnr.span.type": "DEFAULT",
        "lmnr.span.input": json(
          { role: "user", content: text(prompt, maxChars) },
          maxChars,
        ),
        "lmnr.span.output": json(
          {
            role: "assistant",
            content: text(lastModel.content ?? "", maxChars),
          },
          maxChars,
        ),
        "lmnr.association.properties.metadata.source": "antigravity",
        "antigravity.termination_reason": finish.payload.terminationReason,
        "antigravity.user_step": user.step_index,
        "antigravity.input_scope": "visible_transcript_not_full_model_request",
      },
      finish.payload.error,
    );
    delete root.parentSpanId;
    spans.unshift(root);
    exportedThrough = last.step_index;
  }
  return {
    throughStep: exportedThrough,
    request: {
      resourceSpans: [
        {
          resource: {
            attributes: attributes({
              "service.name": "antigravity",
              "telemetry.sdk.name": "lmnr-antigravity-plugin",
            }),
          },
          scopeSpans: [
            { scope: { name: "lmnr.antigravity", version: "0.1.0" }, spans },
          ],
        },
      ],
    },
  };
}
