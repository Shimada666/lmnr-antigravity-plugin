import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import protobuf from "protobufjs/light.js";
import { z } from "zod";
import { atomicJson, stateRoot } from "./storage.js";

const descriptor = protobuf.Root.fromJSON({
  nested: {
    Field: {
      fields: {
        name: { type: "string", id: 1 },
        number: { type: "int32", id: 3 },
        label: { type: "int32", id: 4 },
        type: { type: "int32", id: 5 },
        typeName: { type: "string", id: 6 },
      },
    },
    Descriptor: {
      fields: {
        name: { type: "string", id: 1 },
        field: { rule: "repeated", type: "Field", id: 2 },
      },
    },
  },
}).lookupType("Descriptor");
const field = z.object({
  name: z.string(),
  number: z.number(),
  label: z.number(),
  type: z.number(),
  typeName: z.string().optional(),
});
const schema = z.object({ name: z.string(), field: z.array(field) });
// Public projections of descriptors embedded in the actual CLI binary.
const expected: Record<string, [number, string, number, number, string?][]> = {
  CortexStepGeneratorMetadata: [
    [1, "chat_model", 11, 1, ".exa.cortex_pb.ChatModelMetadata"],
    [2, "step_indices", 13, 3],
  ],
  ChatModelMetadata: [
    [1, "system_prompt", 9, 1],
    [2, "message_prompts", 11, 3, ".exa.chat_pb.ChatMessagePrompt"],
    [5, "model_cost", 2, 1],
    [8, "tools", 11, 3, ".exa.chat_pb.ChatToolDefinition"],
    [11, "time_to_first_token", 11, 1, ".google.protobuf.Duration"],
    [12, "streaming_duration", 11, 1, ".google.protobuf.Duration"],
    [19, "response_model", 9, 1],
    [22, "response_model_full", 9, 1],
  ],
  ChatMessagePrompt: [
    [2, "source", 14, 1, ".exa.codeium_common_pb.ChatMessageSource"],
    [3, "prompt", 9, 1],
    [6, "tool_calls", 11, 3, ".exa.codeium_common_pb.ChatToolCall"],
    [7, "tool_call_id", 9, 1],
  ],
  ChatToolCall: [
    [1, "id", 9, 1],
    [2, "name", 9, 1],
    [3, "arguments_json", 9, 1],
  ],
  ChatToolDefinition: [
    [1, "name", 9, 1],
    [2, "description", 9, 1],
    [3, "json_schema_string", 9, 1],
  ],
};

export async function verifyNativeSchema(binaryPath?: string) {
  const executable =
    binaryPath ??
    process.env.LMNR_ANTIGRAVITY_BINARY ??
    process.env
      .PATH!.split(delimiter)
      .map((p) => join(p, "agy"))
      .find(existsSync);
  assert(executable, "Antigravity executable not found");
  const info = await stat(executable, { bigint: true });
  const identity = [info.dev, info.ino, info.size, info.mtimeNs].join(":");
  const projectionHash = createHash("sha256")
    .update(JSON.stringify(expected))
    .digest("hex");
  const cachePath = join(
    stateRoot,
    `compatibility-${createHash("sha256")
      .update(identity + projectionHash)
      .digest("hex")}.json`,
  );
  if (existsSync(cachePath)) {
    const cached = z
      .object({
        identity: z.string(),
        projectionHash: z.string(),
        binarySha256: z.string(),
        checkedAt: z.string(),
        executable: z.string(),
      })
      .parse(JSON.parse(await readFile(cachePath, "utf8")));
    if (
      cached.identity === identity &&
      cached.projectionHash === projectionHash
    )
      return cached;
  }
  const binary = await readFile(executable);
  for (const [name, fields] of Object.entries(expected)) {
    const needle = Buffer.concat([
      Buffer.from([10, Buffer.byteLength(name)]),
      Buffer.from(name),
    ]);
    const at = binary.indexOf(needle);
    assert(at >= 0, `Missing native descriptor: ${name}`);
    const candidates: z.infer<typeof schema>[] = [];
    for (let start = Math.max(0, at - 6); start < at; start++) {
      if (binary[start] !== 34) continue;
      let size = 0,
        shift = 0,
        end = start + 1;
      for (; end < at; end++) {
        const byte = binary[end]!;
        size += (byte & 127) * 2 ** shift;
        shift += 7;
        if (byte < 128) {
          end++;
          break;
        }
      }
      if (end !== at || size < needle.length || at + size > binary.length)
        continue;
      candidates.push(
        schema.parse(
          descriptor.toObject(
            descriptor.decode(binary.subarray(at, at + size)),
          ),
        ),
      );
    }
    assert.equal(candidates.length, 1, `Ambiguous native descriptor: ${name}`);
    const actual = candidates[0]!;
    assert.equal(actual.name, name);
    for (const [number, fieldName, type, label, typeName] of fields) {
      assert.deepEqual(
        actual.field.find((f) => f.number === number),
        {
          name: fieldName,
          number,
          label,
          type,
          ...(typeName ? { typeName } : {}),
        },
        `Unsupported native field: ${name}.${fieldName}`,
      );
    }
  }
  const result = {
    executable,
    identity,
    projectionHash,
    binarySha256: createHash("sha256").update(binary).digest("hex"),
    checkedAt: new Date().toISOString(),
  };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await atomicJson(cachePath, result);
  return result;
}
