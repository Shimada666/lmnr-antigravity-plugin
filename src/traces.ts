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
  const terminal = events.find(
    (e) =>
      e.payload.event === "Stop" &&
      e.payload.fullyIdle &&
      e.at >= pre.at &&
      ["ERROR", "USER_CANCELED"].includes(e.payload.terminationReason),
  );
  assert(post || terminal, `Missing PostInvocation for step ${step}`);
  return {
    pre: { at: pre.at, payload },
    post: (post ?? terminal)!,
    interrupted: post === undefined,
  };
}

/** One trace per explicit user turn; model/tool spans are siblings below it. */
export function buildExport(
  rows: TranscriptRow[],
  events: EventRecord[],
  stop: StopPayload,
  throughStep: number,
  maxChars: number,
): { request: ExportRequest; throughStep: number } | null {
  const starts = rows.filter(
    (r) =>
      r.type === "USER_INPUT" &&
      r.source === "USER_EXPLICIT" &&
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
    if (!last) break;
    const models = turnRows.filter((r) => r.type === "PLANNER_RESPONSE");

    const traceId = id(
      `antigravity:${stop.conversationId}:${user.step_index}`,
      32,
    );
    const rootId = id(`${traceId}:root`, 16);
    const lastModel = models.at(-1);
    const turnInvocations = events.filter(
      (e) =>
        e.payload.event === "PreInvocation" &&
        e.payload.initialNumSteps > user.step_index &&
        (next === undefined || e.payload.initialNumSteps <= next.step_index),
    );
    const lastInvocation = turnInvocations.at(-1);
    // A new queued user input can already be in the transcript during replay.
    if (!lastInvocation) break;
    const { post: lastPost } = lastModel
      ? invocationForStep(lastModel.step_index, events)
      : { post: lastInvocation };
    const finish = events.find(
      (e) =>
        e.payload.event === "Stop" &&
        e.payload.fullyIdle &&
        e.at >= lastPost.at &&
        e.at >= lastInvocation.at,
    );
    assert(finish?.payload.event === "Stop", "Missing Stop event for turn");
    const terminalError =
      finish.payload.error ||
      ([
        "ERROR",
        "USER_CANCELED",
        "MAX_INVOCATIONS",
        "MAX_FORCED_INVOCATIONS",
        "MAX_TOKEN_BUDGET_EXCEEDED",
      ].includes(finish.payload.terminationReason)
        ? finish.payload.terminationReason
        : undefined);
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
        events: error
          ? [
              {
                name: "exception",
                timeUnixNano: nano(end),
                attributes: attributes({
                  "exception.message": text(error, maxChars),
                }),
              },
            ]
          : [],
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
    const coveredInvocations = new Set<string>();
    for (const model of models) {
      const { pre, post, interrupted } = invocationForStep(
        model.step_index,
        events,
      );
      const invocationKey = `${pre.at}:${pre.payload.initialNumSteps}`;
      assert(
        !coveredInvocations.has(invocationKey),
        `Multiple model responses mapped to one invocation at step ${model.step_index}`,
      );
      coveredInvocations.add(invocationKey);
      for (const system of turnRows.filter(
        (r) =>
          ["SYSTEM_MESSAGE", "CHECKPOINT", "ERROR_MESSAGE"].includes(r.type) &&
          r.step_index >
            (models[models.indexOf(model) - 1]?.step_index ??
              user.step_index) &&
          r.step_index < model.step_index,
      )) {
        assert(
          system.source === "SYSTEM" &&
            (system.content !== undefined || system.error !== undefined),
          "Invalid SYSTEM_MESSAGE",
        );
        inputMessages.push({
          role: "system",
          content: text(system.content ?? system.error!, maxChars),
        });
      }
      const following: number =
        models.find((m) => m.step_index > model.step_index)?.step_index ??
        last.step_index + 1;
      const results = turnRows.filter(
        (r) =>
          r.type === "GENERIC" &&
          r.step_index > model.step_index &&
          r.step_index < following,
      );
      const calls = model.tool_calls ?? [];
      assert(
        results.length === calls.length,
        `Tool-call/result mismatch at step ${model.step_index}`,
      );
      const tools = results.map((result, i) => {
        const call = calls[i]!;
        const preTool = events.find(
          (e) =>
            e.payload.event === "PreToolUse" &&
            e.payload.stepIdx === result.step_index,
        );
        const postTool = events.find(
          (e) =>
            e.payload.event === "PostToolUse" &&
            e.payload.stepIdx === result.step_index,
        );
        if (preTool) {
          assert(preTool.payload.event === "PreToolUse");
          assert.deepEqual(preTool.payload.toolCall, call);
          if (postTool) {
            assert(postTool.payload.event === "PostToolUse");
            assert.deepEqual(postTool.payload.toolCall, call);
            assert(postTool.at >= preTool.at, "Tool hook order is invalid");
          } else
            assert(
              interrupted,
              `Missing PostToolUse for step ${result.step_index}`,
            );
        } else {
          assert(
            !postTool,
            `PostToolUse without PreToolUse at step ${result.step_index}`,
          );
          assert(
            ["ERROR", "INVALID"].includes(result.status),
            `Missing PreToolUse for step ${result.step_index}`,
          );
        }
        return { result, call, preTool, postTool };
      });
      // A rejected call can fail before hooks run; preserve its transcript error
      // and mark timestamp-only timing rather than inventing an execution time.
      const modelEnd =
        tools.flatMap((t) => (t.preTool ? [t.preTool.at] : [])).sort()[0] ??
        post.at;
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
        const call = tool.call;
        parts.push({
          type: "tool_call",
          id: `step-${tool.result.step_index}`,
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
          interrupted
            ? "Invocation interrupted before PostInvocation"
            : undefined,
        ),
      );
      if (model.content !== undefined)
        inputMessages.push({
          role: "assistant",
          content: text(model.content, maxChars),
        });
      for (const tool of tools) {
        const { result, call, preTool, postTool } = tool;
        assert(
          result.content !== undefined || result.error !== undefined,
          `Tool result missing at step ${result.step_index}`,
        );
        const content = result.content ?? result.error!;
        coveredTools.add(result.step_index);
        const hookError =
          postTool?.payload.event === "PostToolUse"
            ? postTool.payload.error
            : undefined;
        spans.push(
          makeSpan(
            call.name,
            `tool:${result.step_index}`,
            preTool?.at ?? result.created_at,
            postTool?.at ?? (preTool ? post.at : result.created_at),
            {
              "lmnr.span.type": "TOOL",
              "lmnr.span.input": json(call.args, maxChars),
              "lmnr.span.output": json(content, maxChars),
              "antigravity.step_index": result.step_index,
              "antigravity.transcript_status": result.status,
              "antigravity.tool_scope":
                result.status === "RUNNING"
                  ? "background_dispatch"
                  : "tool_execution",
              "antigravity.timing_source": preTool
                ? "hook_wall_clock"
                : "transcript_timestamp_only",
            },
            hookError ||
              result.error ||
              (preTool && !postTool
                ? "Tool interrupted before PostToolUse"
                : undefined),
          ),
        );
        inputMessages.push({ role: "tool", content: text(content, maxChars) });
      }
    }
    for (const invocation of turnInvocations) {
      assert(invocation.payload.event === "PreInvocation");
      const initial = invocation.payload.initialNumSteps;
      const later = turnInvocations.find(
        (e) =>
          e.payload.event === "PreInvocation" &&
          e.payload.initialNumSteps > initial,
      );
      const upper =
        later?.payload.event === "PreInvocation"
          ? later.payload.initialNumSteps
          : Infinity;
      if (models.some((m) => m.step_index >= initial && m.step_index < upper))
        continue;
      assert(
        terminalError,
        `Invocation has no model response at step ${initial}`,
      );
      spans.push(
        makeSpan(
          `LLM ${invocation.payload.invocationNum + 1}`,
          `incomplete:${initial}`,
          invocation.at,
          finish.at,
          {
            "lmnr.span.type": "LLM",
            "gen_ai.request.model": invocation.payload.modelName,
            "antigravity.initial_num_steps": initial,
            "antigravity.incomplete": true,
            "antigravity.timing_source": "hook_wall_clock",
          },
          terminalError,
        ),
      );
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
            content: text(lastModel?.content ?? "", maxChars),
          },
          maxChars,
        ),
        "lmnr.association.properties.metadata.source": "antigravity",
        "antigravity.termination_reason": finish.payload.terminationReason,
        "antigravity.user_step": user.step_index,
        "antigravity.input_scope": "visible_transcript_not_full_model_request",
      },
      terminalError,
    );
    delete root.parentSpanId;
    spans.unshift(root);
    exportedThrough = last.step_index;
  }
  if (spans.length === 0) return null;
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
            { scope: { name: "lmnr.antigravity", version: "0.2.0" }, spans },
          ],
        },
      ],
    },
  };
}
