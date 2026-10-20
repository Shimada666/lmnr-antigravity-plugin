import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  EventRecord,
  ExportRequest,
  Span,
  Owner,
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

type Part =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: ToolCall["args"];
    };
type Message = {
  role: string;
  content?: string;
  parts?: Part[];
  tool_call_id?: string;
};

/** Immutable completed child spans; root is emitted only with an observed end. */
export function buildSpans(
  rows: TranscriptRow[],
  events: EventRecord[],
  importedThroughStep: number,
  maxChars: number,
  observedAt: string,
  alive: (owner: Owner) => boolean,
  partialTranscript: boolean,
): Span[] {
  const first = events.find(
    (e) =>
      e.payload.event === "PreInvocation" &&
      e.payload.initialNumSteps > importedThroughStep,
  );
  if (!first) return [];
  assert(first.payload.event === "PreInvocation");
  const firstStep = first.payload.initialNumSteps;
  const firstUser = rows.findLast(
    (r) =>
      r.type === "USER_INPUT" &&
      r.source === "USER_EXPLICIT" &&
      r.step_index < firstStep,
  );
  assert(firstUser, "No user turn before observed invocation");
  const starts = rows.filter(
    (r) =>
      r.type === "USER_INPUT" &&
      r.source === "USER_EXPLICIT" &&
      r.step_index >= firstUser.step_index &&
      r.step_index > importedThroughStep,
  );
  const spans: Span[] = [];
  for (const [turnIndex, user] of starts.entries()) {
    const next = starts[turnIndex + 1];
    const turnRows = rows.filter(
      (r) =>
        r.step_index >= user.step_index &&
        (next === undefined || r.step_index < next.step_index),
    );
    const invocations = events.filter(
      (e) =>
        e.payload.event === "PreInvocation" &&
        e.payload.initialNumSteps > user.step_index &&
        (next === undefined || e.payload.initialNumSteps <= next.step_index),
    );
    const lastInvocation = invocations.at(-1);
    if (!lastInvocation) continue;
    const nextInvocation =
      next === undefined
        ? undefined
        : events.find(
            (e) =>
              e.payload.event === "PreInvocation" &&
              e.payload.initialNumSteps > next.step_index,
          );
    const turnEvents = events.filter(
      (e) =>
        e.at >= invocations[0]!.at &&
        (nextInvocation === undefined || e.at < nextInvocation.at),
    );
    const lastActivity = turnEvents.findLast(
      (e) => e.payload.event !== "Stop",
    )!;
    const stop = turnEvents.find(
      (e) =>
        e.payload.event === "Stop" &&
        e.payload.fullyIdle &&
        e.at >= lastActivity.at,
    );
    const dead = lastInvocation.owner !== null && !alive(lastInvocation.owner);
    const finishAt =
      stop?.at ?? nextInvocation?.at ?? (dead ? observedAt : undefined);
    const reason =
      stop?.payload.event === "Stop"
        ? stop.payload.terminationReason
        : nextInvocation
          ? "SUPERSEDED_WITHOUT_STOP"
          : dead
            ? "OWNER_EXITED_WITHOUT_STOP"
            : undefined;
    const normal =
      stop?.payload.event === "Stop" &&
      !stop.payload.error &&
      ["NO_TOOL_CALL", "TERMINAL_STEP_TYPE", "INJECTED_RESPONSE"].includes(
        stop.payload.terminationReason,
      );
    const terminalError =
      finishAt === undefined || normal
        ? undefined
        : (stop?.payload.event === "Stop" && stop.payload.error) || reason;
    const traceId = id(
      `antigravity:${first.payload.conversationId}:${user.step_index}`,
      32,
    );
    const rootId = id(`${traceId}:root`, 16);
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
        attributes: attributes({
          "lmnr.association.properties.session_id":
            first.payload.conversationId,
          ...attrs,
        }),
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
    assert(user.content !== undefined, "Missing user content");
    const messages: Message[] = [
      { role: "user", content: text(user.content, maxChars) },
    ];
    const models = turnRows.filter((r) => r.type === "PLANNER_RESPONSE");
    const seenInvocations = new Set<string>();
    const seenTools = new Set<number>();
    let priorModel = user.step_index;
    for (const model of models) {
      for (const system of turnRows.filter(
        (r) =>
          ["SYSTEM_MESSAGE", "CHECKPOINT", "ERROR_MESSAGE"].includes(r.type) &&
          r.step_index > priorModel &&
          r.step_index < model.step_index,
      )) {
        assert(
          system.source === "SYSTEM" &&
            (system.content !== undefined || system.error !== undefined),
          "Invalid system message",
        );
        messages.push({
          role: "system",
          content: text(system.content ?? system.error!, maxChars),
        });
      }
      priorModel = model.step_index;
      const pre = invocations.findLast(
        (e) =>
          e.payload.event === "PreInvocation" &&
          e.payload.initialNumSteps <= model.step_index,
      );
      if (!pre) {
        assert(!finishAt, `Missing PreInvocation at step ${model.step_index}`);
        break;
      }
      assert(pre.payload.event === "PreInvocation");
      const prePayload = pre.payload;
      const invocationKey = `${pre.at}:${prePayload.initialNumSteps}`;
      if (seenInvocations.has(invocationKey)) {
        assert(
          !finishAt,
          `Multiple model responses mapped to one invocation at step ${model.step_index}`,
        );
        break;
      }
      seenInvocations.add(invocationKey);
      const post = turnEvents.find(
        (e) =>
          e.payload.event === "PostInvocation" &&
          e.payload.initialNumSteps === prePayload.initialNumSteps &&
          e.payload.invocationNum === prePayload.invocationNum &&
          e.at >= pre.at,
      );
      if (normal)
        assert(post, `Missing PostInvocation at step ${model.step_index}`);
      const following =
        models.find((r) => r.step_index > model.step_index)?.step_index ??
        next?.step_index ??
        Infinity;
      const results = turnRows.filter(
        (r) =>
          r.type === "GENERIC" &&
          r.step_index > model.step_index &&
          r.step_index < following,
      );
      const calls = model.tool_calls ?? [];
      assert(
        results.length <= calls.length,
        `Too many tool results at step ${model.step_index}`,
      );
      if (normal)
        assert(
          results.length === calls.length,
          `Tool-call/result mismatch at step ${model.step_index}`,
        );
      const toolHooks = turnEvents.filter(
        (e) =>
          e.payload.event === "PreToolUse" &&
          e.payload.stepIdx > model.step_index &&
          e.payload.stepIdx < following,
      );
      const modelEnd = toolHooks[0]?.at ?? post?.at ?? finishAt;
      const modelComplete =
        model.status === "DONE" &&
        (toolHooks.length > 0 || post !== undefined || finishAt !== undefined);
      const parts: Part[] = [];
      if (model.content !== undefined)
        parts.push({ type: "text", content: text(model.content, maxChars) });
      calls.forEach((call, i) =>
        parts.push({
          type: "tool_call",
          id: `call-${model.step_index}-${i}`,
          name: call.name,
          arguments:
            JSON.stringify(call.args).length > maxChars
              ? { _truncated: text(JSON.stringify(call.args), maxChars) }
              : call.args,
        }),
      );
      if (modelEnd && (modelComplete || finishAt)) {
        const attrs: Record<string, string | number | boolean> = {
          "lmnr.span.type": "LLM",
          "gen_ai.request.model": prePayload.modelName,
          "gen_ai.response.model": prePayload.modelName,
          "gen_ai.input.messages": JSON.stringify(messages),
          "gen_ai.output.messages": JSON.stringify([
            {
              role: "assistant",
              parts:
                model.thinking === undefined
                  ? parts
                  : [
                      {
                        type: "thinking",
                        content: text(model.thinking, maxChars),
                      },
                      ...parts,
                    ],
            },
          ]),
          "antigravity.step_index": model.step_index,
          "antigravity.user_step": user.step_index,
          "antigravity.user_turn_first_call": model === models[0],
          "antigravity.thinking_source": "cli_visible_transcript",
          "antigravity.incomplete": !modelComplete,
          "antigravity.timing_source":
            toolHooks.length > 0 || post
              ? "hook_wall_clock"
              : "recovery_observation",
        };
        if (modelComplete) {
          for (const [field, target] of [
            ["output_tokens", "output_tokens"],
            ["cache_read_tokens", "cache_read_input_tokens"],
            ["thinking_tokens", "reasoning_tokens"],
          ] as const)
            if (model[field] !== undefined)
              attrs[`gen_ai.usage.${target}`] = model[field];
          if (model.input_tokens !== undefined) {
            assert(
              model.cache_read_tokens !== undefined,
              "Cannot normalize input tokens without cache counter",
            );
            attrs["antigravity.usage.uncached_input_tokens"] =
              model.input_tokens;
            attrs["antigravity.usage.cache_read_tokens"] =
              model.cache_read_tokens;
            attrs["gen_ai.usage.input_tokens"] =
              model.input_tokens + model.cache_read_tokens;
          }
        }
        spans.push(
          makeSpan(
            `LLM ${prePayload.invocationNum + 1}`,
            `llm:${model.step_index}`,
            pre.at,
            modelEnd,
            attrs,
            modelComplete
              ? undefined
              : model.error || terminalError || "Incomplete model response",
          ),
        );
      }
      messages.push({ role: "assistant", parts });
      for (const [i, result] of results.entries()) {
        const call = calls[i]!;
        const preTool = toolHooks.find(
          (e) =>
            e.payload.event === "PreToolUse" &&
            e.payload.stepIdx === result.step_index,
        );
        const postTool = turnEvents.find(
          (e) =>
            e.payload.event === "PostToolUse" &&
            e.payload.stepIdx === result.step_index,
        );
        if (preTool) {
          assert(preTool.payload.event === "PreToolUse");
          assert.deepEqual(preTool.payload.toolCall, call);
        }
        if (postTool) {
          assert(preTool && postTool.payload.event === "PostToolUse");
          assert.deepEqual(postTool.payload.toolCall, call);
          assert(postTool.at >= preTool.at);
        }
        const failedBeforeHook =
          !preTool && ["ERROR", "INVALID"].includes(result.status);
        if (!preTool && !failedBeforeHook) {
          assert(!finishAt, `Missing PreToolUse for step ${result.step_index}`);
          continue;
        }
        if (!postTool && !failedBeforeHook && !result.error && !finishAt)
          continue;
        if (normal && preTool && !result.error)
          assert(postTool, `Missing PostToolUse for step ${result.step_index}`);
        assert(
          result.content !== undefined || result.error !== undefined,
          `Missing tool content at step ${result.step_index}`,
        );
        const content = result.content ?? result.error!;
        const hookError =
          postTool?.payload.event === "PostToolUse"
            ? postTool.payload.error
            : undefined;
        const incomplete =
          preTool !== undefined && postTool === undefined && !result.error;
        spans.push(
          makeSpan(
            call.name,
            `tool:${result.step_index}`,
            !postTool && result.error
              ? result.created_at
              : (preTool?.at ?? result.created_at),
            postTool?.at ??
              (result.error
                ? result.created_at
                : preTool
                  ? finishAt!
                  : result.created_at),
            {
              "lmnr.span.type": "TOOL",
              "lmnr.span.input": json(call.args, maxChars),
              "lmnr.span.output": json(content, maxChars),
              "antigravity.step_index": result.step_index,
              "antigravity.transcript_status": result.status,
              "antigravity.incomplete": incomplete,
              "antigravity.tool_scope":
                result.status === "RUNNING"
                  ? "background_dispatch"
                  : "tool_execution",
              "antigravity.timing_source": postTool
                ? "hook_wall_clock"
                : preTool
                  ? "recovery_observation"
                  : "transcript_timestamp_only",
            },
            hookError ||
              result.error ||
              (incomplete ? terminalError || "Interrupted tool" : undefined),
          ),
        );
        seenTools.add(result.step_index);
        messages.push({
          role: "tool",
          tool_call_id: `call-${model.step_index}-${i}`,
          content: text(content, maxChars),
        });
      }
    }
    if (finishAt) {
      for (const pre of invocations) {
        assert(pre.payload.event === "PreInvocation");
        if (seenInvocations.has(`${pre.at}:${pre.payload.initialNumSteps}`))
          continue;
        assert(
          terminalError,
          `Invocation has no model response at step ${pre.payload.initialNumSteps}`,
        );
        spans.push(
          makeSpan(
            `LLM ${pre.payload.invocationNum + 1}`,
            `incomplete:${pre.payload.initialNumSteps}`,
            pre.at,
            finishAt,
            {
              "lmnr.span.type": "LLM",
              "gen_ai.request.model": pre.payload.modelName,
              "antigravity.initial_num_steps": pre.payload.initialNumSteps,
              "antigravity.incomplete": true,
              "antigravity.timing_source": "recovery_observation",
            },
            terminalError,
          ),
        );
      }
      for (const e of turnEvents) {
        if (
          e.payload.event !== "PreToolUse" ||
          seenTools.has(e.payload.stepIdx)
        )
          continue;
        assert(
          terminalError,
          `Unmatched tool start at step ${e.payload.stepIdx}`,
        );
        const p = e.payload;
        spans.push(
          makeSpan(
            p.toolCall.name,
            `tool:${p.stepIdx}`,
            e.at,
            finishAt,
            {
              "lmnr.span.type": "TOOL",
              "lmnr.span.input": json(p.toolCall.args, maxChars),
              "antigravity.step_index": p.stepIdx,
              "antigravity.incomplete": true,
              "antigravity.timing_source": "recovery_observation",
            },
            terminalError,
          ),
        );
      }
      for (const r of turnRows)
        assert(
          r.type !== "USER_INPUT" || r.step_index === user.step_index,
          `Unsupported injected input at step ${r.step_index}`,
        );
      const root = makeSpan(
        `Antigravity - Turn at step ${user.step_index} (${first.payload.conversationId.slice(0, 8)})`,
        "root",
        user.created_at,
        finishAt,
        {
          "lmnr.span.type": "DEFAULT",
          "lmnr.span.input": json(
            { role: "user", content: text(user.content, maxChars) },
            maxChars,
          ),
          "lmnr.span.output": json(
            {
              role: "assistant",
              content: text(models.at(-1)?.content ?? "", maxChars),
            },
            maxChars,
          ),
          "lmnr.association.properties.metadata.source": "antigravity",
          "antigravity.termination_reason": reason!,
          "antigravity.user_step": user.step_index,
          "antigravity.input_scope":
            "visible_transcript_not_full_model_request",
          "antigravity.recovered": stop === undefined,
          "antigravity.partial_transcript": partialTranscript,
          "antigravity.last_observed_at": lastActivity.at,
          "antigravity.timing_source": stop
            ? "hook_wall_clock"
            : "recovery_observation",
        },
        terminalError,
      );
      delete root.parentSpanId;
      spans.push(root);
    }
  }
  return spans;
}

export function pack(spans: Span[]): ExportRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            "service.name": "antigravity",
            "telemetry.sdk.name": "lmnr-antigravity-plugin",
          }),
        },
        scopeSpans: [
          { scope: { name: "lmnr.antigravity", version: "0.3.1" }, spans },
        ],
      },
    ],
  };
}
