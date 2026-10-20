import { z } from "zod";

const index = z.number().int().nonnegative();
export const toolCall = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.json()),
});
export type ToolCall = z.infer<typeof toolCall>;
const common = z.object({
  conversationId: z.uuid(),
  transcriptPath: z.string().min(1),
  workspacePaths: z.array(z.string()),
  artifactDirectoryPath: z.string(),
  modelName: z.string().min(1),
});
export const hookPayload = z.discriminatedUnion("event", [
  common.extend({
    event: z.literal("PreInvocation"),
    invocationNum: index,
    initialNumSteps: index,
  }),
  common.extend({
    event: z.literal("PostInvocation"),
    invocationNum: index,
    initialNumSteps: index,
  }),
  common.extend({ event: z.literal("PreToolUse"), stepIdx: index, toolCall }),
  common.extend({
    event: z.literal("PostToolUse"),
    stepIdx: index,
    toolCall,
    error: z.string().optional(),
  }),
  common.extend({
    event: z.literal("Stop"),
    executionNum: index,
    terminationReason: z.string(),
    fullyIdle: z.boolean(),
    error: z.string().optional(),
  }),
]);
export const ownerSchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^\d+$/),
  bootId: z.uuid(),
});
export type Owner = z.infer<typeof ownerSchema>;
export const eventRecord = z.object({
  journalRecovery: z
    .object({
      fragmentHash: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().positive(),
    })
    .optional(),
  owner: ownerSchema.nullable(),
  at: z.iso.datetime(),
  payload: hookPayload,
});
export type EventRecord = z.infer<typeof eventRecord>;
export type HookPayload = z.infer<typeof hookPayload>;
export type StopPayload = Extract<HookPayload, { event: "Stop" }>;

// Observed wire schema: agy 1.4.2 transcript_full.jsonl. Unsupported row kinds
// fail explicitly instead of quietly dropping part of the conversation.
export const transcriptEnvelope = z
  .object({
    step_index: index,
    source: z.string().min(1),
    type: z.string().min(1),
    created_at: z.iso.datetime(),
  })
  .passthrough();

export const transcriptRow = z
  .object({
    step_index: index,
    source: z.string().min(1),
    type: z.enum([
      "USER_INPUT",
      "PLANNER_RESPONSE",
      "GENERIC",
      "SYSTEM_MESSAGE",
      "CHECKPOINT",
      "ERROR_MESSAGE",
    ]),
    status: z.enum(["DONE", "RUNNING", "ERROR", "INVALID"]),
    error: z.string().optional(),
    created_at: z.iso.datetime(),
    content: z.string().optional(),
    input_tokens: index.optional(),
    output_tokens: index.optional(),
    cache_read_tokens: index.optional(),
    thinking_tokens: index.optional(),
    tool_calls: z.array(toolCall).optional(),
  })
  .superRefine((row, ctx) => {
    if (
      row.status !== "DONE" &&
      !["GENERIC", "PLANNER_RESPONSE"].includes(row.type)
    )
      ctx.addIssue({
        code: "custom",
        message: `Unsupported ${row.type} status ${row.status}`,
      });
    if (
      (row.status === "ERROR" ||
        row.status === "INVALID" ||
        row.type === "ERROR_MESSAGE") &&
      !row.error
    )
      ctx.addIssue({
        code: "custom",
        message: "Failed step must retain its error",
      });
  });
export type TranscriptRow = z.infer<typeof transcriptRow>;

const attribute = z.object({
  key: z.string(),
  value: z.union([
    z.object({ stringValue: z.string() }),
    z.object({ intValue: z.string() }),
    z.object({ boolValue: z.boolean() }),
  ]),
});
export const span = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  name: z.string(),
  kind: z.literal(1),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: z.array(attribute),
  events: z
    .array(
      z.object({
        name: z.literal("exception"),
        timeUnixNano: z.string(),
        attributes: z.array(attribute),
      }),
    )
    .optional(),
  status: z.object({
    code: z.union([z.literal(1), z.literal(2)]),
    message: z.string().optional(),
  }),
});
export type Span = z.infer<typeof span>;
export const exportRequest = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z.object({ attributes: z.array(attribute) }),
      scopeSpans: z.array(
        z.object({
          scope: z.object({ name: z.string(), version: z.string() }),
          spans: z.array(span),
        }),
      ),
    }),
  ),
});
export type ExportRequest = z.infer<typeof exportRequest>;
export const ledgerSchema = z
  .object({
    version: z.literal(3),
    importedThroughStep: z.number().int().min(-1),
  })
  .strict();
export const deliverySchema = z
  .object({
    state: z.enum([
      "ready",
      "sending",
      "accepted",
      "confirmed",
      "uncertain",
      "rejected",
    ]),
    attempts: z.number().int().nonnegative(),
    retryAt: z.number().nonnegative(),
    error: z.string().optional(),
  })
  .strict();
export type Delivery = z.infer<typeof deliverySchema>;
export const outboxSchema = z
  .object({ span: span, request: exportRequest })
  .strict();
