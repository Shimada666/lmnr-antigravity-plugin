import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { atomicJson } from "./storage.js";
import { dirname, join, resolve } from "node:path";
import protobuf from "protobufjs/light.js";
import { z } from "zod";

// Projection of the CLI 1.4.2 embedded exa.cortex_pb descriptors. Field numbers
// and wire types come from those descriptors, not from inferred byte offsets.
// Unrelated prompt/credential fields are skipped by the protobuf decoder.
const generator = protobuf.Root.fromJSON({
  nested: {
    Duration: {
      fields: {
        seconds: { type: "int64", id: 1 },
        nanos: { type: "int32", id: 2 },
      },
    },
    ChatToolCall: {
      fields: {
        id: { type: "string", id: 1 },
        name: { type: "string", id: 2 },
        argumentsJson: { type: "string", id: 3 },
      },
    },
    ChatMessagePrompt: {
      fields: {
        source: { type: "int32", id: 2 },
        prompt: { type: "string", id: 3 },
        toolCalls: { rule: "repeated", type: "ChatToolCall", id: 6 },
        toolCallId: { type: "string", id: 7 },
      },
    },
    ChatToolDefinition: {
      fields: {
        name: { type: "string", id: 1 },
        description: { type: "string", id: 2 },
        jsonSchemaString: { type: "string", id: 3 },
      },
    },
    ChatModelMetadata: {
      fields: {
        systemPrompt: { type: "string", id: 1 },
        messagePrompts: { rule: "repeated", type: "ChatMessagePrompt", id: 2 },
        modelCost: { type: "float", id: 5 },
        tools: { rule: "repeated", type: "ChatToolDefinition", id: 8 },
        responseModel: { type: "string", id: 19 },
        responseModelFull: { type: "string", id: 22 },
        timeToFirstToken: { type: "Duration", id: 11 },
        streamingDuration: { type: "Duration", id: 12 },
      },
    },
    CortexStepGeneratorMetadata: {
      fields: {
        chatModel: { type: "ChatModelMetadata", id: 1 },
        stepIndices: { rule: "repeated", type: "uint32", id: 2 },
      },
    },
  },
}).lookupType("CortexStepGeneratorMetadata");

const duration = z
  .object({
    // Zero components are omitted by proto3 serialization.
    seconds: z.coerce.number().int().nonnegative().safe().default(0),
    nanos: z.number().int().min(0).max(999_999_999).default(0),
  })
  .transform((value) => value.seconds + value.nanos / 1_000_000_000);
const nativeMessage = z.object({
  source: z
    .union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ])
    .default(0),
  prompt: z.string().optional(),
  toolCalls: z
    .array(
      z.object({ id: z.string(), name: z.string(), argumentsJson: z.string() }),
    )
    .optional(),
  toolCallId: z.string().optional(),
});
export const contextSchema = z.object({
  generatorIndex: z.number().int().nonnegative(),
  stepIndices: z.array(z.number().int().nonnegative()),
  systemPrompt: z.string().optional(),
  messagePrompts: z.array(nativeMessage),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      jsonSchemaString: z.string(),
    }),
  ),
});
export type NativeContext = z.infer<typeof contextSchema>;
const metadata = z.object({
  stepIndices: z.array(z.number().int().nonnegative()).optional(),
  chatModel: z
    .object({
      systemPrompt: z.string().optional(),
      messagePrompts: z.array(nativeMessage).optional(),
      tools: contextSchema.shape.tools.optional(),
      modelCost: z.number().finite().nonnegative().optional(),
      responseModel: z.string().optional(),
      responseModelFull: z.string().optional(),
      timeToFirstToken: duration.optional(),
      streamingDuration: duration.optional(),
    })
    .optional(),
});
export type NativeTiming = {
  ttftSeconds: number;
  streamingSeconds?: number;
  nativeModelCost?: number;
  responseModel?: string;
};

export async function readNativeTimings(
  transcriptPath: string,
  conversationId: string,
  steps: number[],
): Promise<Map<number, NativeTiming | null>> {
  const result = new Map<number, NativeTiming | null>();
  if (steps.length === 0) return result;
  const cliRoot = resolve(dirname(transcriptPath), "../../../..");
  assert.equal(
    transcriptPath,
    join(
      cliRoot,
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    ),
    "Native timing requires the CLI's original transcript path",
  );
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(
    join(cliRoot, "conversations", `${conversationId}.db`),
    { readOnly: true },
  );
  const pending = new Set(steps);
  try {
    // New calls are at the end. Avoid decoding old prompts on every worker pass.
    for (const row of db
      .prepare("SELECT data FROM gen_metadata ORDER BY idx DESC")
      .iterate()) {
      assert(row.data instanceof Uint8Array, "Invalid generator metadata blob");
      const value = metadata.parse(
        generator.toObject(generator.decode(row.data), { longs: String }),
      );
      if (!value.stepIndices) continue;
      for (const step of value.stepIndices) {
        if (!pending.has(step)) continue;
        if (value.chatModel?.timeToFirstToken !== undefined) {
          result.set(step, {
            ttftSeconds: value.chatModel.timeToFirstToken,
            streamingSeconds: value.chatModel.streamingDuration,
            nativeModelCost: value.chatModel.modelCost,
            responseModel:
              value.chatModel.responseModelFull ||
              value.chatModel.responseModel,
          });
        } else {
          // A persisted generator can explicitly have no model timing (for
          // example an interrupted or injected generation). Do not invent it.
          result.set(step, null);
        }
        pending.delete(step);
      }
      if (pending.size === 0) break;
    }
  } finally {
    db.close();
  }
  return result;
}

/** The CLI erases older prompt fields. Snapshot the latest request before that happens. */
export async function captureNativeContext(
  transcriptPath: string,
  conversationId: string,
  directory: string,
): Promise<void> {
  const cliRoot = resolve(dirname(transcriptPath), "../../../..");
  assert.equal(
    transcriptPath,
    join(
      cliRoot,
      "brain",
      conversationId,
      ".system_generated/logs/transcript_full.jsonl",
    ),
  );
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(
    join(cliRoot, "conversations", `${conversationId}.db`),
    { readOnly: true },
  );
  try {
    for (const row of db
      .prepare("SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 4")
      .iterate()) {
      assert(typeof row.idx === "number" && row.data instanceof Uint8Array);
      const value = metadata.parse(
        generator.toObject(generator.decode(row.data), { longs: String }),
      );
      const chat = value.chatModel;
      if (!chat?.messagePrompts?.length || !value.stepIndices?.length) continue;
      const contextPath = join(directory, "native-context", `${row.idx}.json`);
      await mkdir(dirname(contextPath), { recursive: true, mode: 0o700 });
      if (!existsSync(contextPath))
        await atomicJson(
          contextPath,
          contextSchema.parse({
            generatorIndex: row.idx,
            stepIndices: value.stepIndices,
            systemPrompt: chat.systemPrompt,
            messagePrompts: chat.messagePrompts,
            tools: chat.tools ?? [],
          }),
        );
      for (const step of value.stepIndices) {
        const indexPath = join(
          directory,
          "native-context",
          `step-${step}.json`,
        );
        if (!existsSync(indexPath))
          await atomicJson(indexPath, { generatorIndex: row.idx });
      }
    }
  } finally {
    db.close();
  }
}

export async function readNativeContexts(
  directory: string,
  steps: number[],
): Promise<Map<number, NativeContext>> {
  const result = new Map<number, NativeContext>();
  if (!steps.length || !existsSync(join(directory, "native-context")))
    return result;
  for (const step of steps) {
    const indexPath = join(directory, "native-context", `step-${step}.json`);
    if (!existsSync(indexPath)) continue;
    const index = z
      .object({ generatorIndex: z.number().int().nonnegative() })
      .parse(JSON.parse(await readFile(indexPath, "utf8")));
    const context = contextSchema.parse(
      JSON.parse(
        await readFile(
          join(directory, "native-context", `${index.generatorIndex}.json`),
          "utf8",
        ),
      ),
    );
    result.set(step, context);
  }
  return result;
}
