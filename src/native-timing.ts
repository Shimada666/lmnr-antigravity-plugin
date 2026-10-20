import assert from "node:assert/strict";
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
    ChatModelMetadata: {
      fields: {
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
const metadata = z.object({
  stepIndices: z.array(z.number().int().nonnegative()).optional(),
  chatModel: z
    .object({
      timeToFirstToken: duration.optional(),
      streamingDuration: duration.optional(),
    })
    .optional(),
});
export type NativeTiming = {
  ttftSeconds: number;
  streamingSeconds?: number;
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
