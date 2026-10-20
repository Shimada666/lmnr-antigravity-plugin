import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { z } from "zod";

export const cursorSchema = z.object({
  offset: z.number().int().nonnegative(),
  anchor: z.string(),
});
export type Cursor = z.infer<typeof cursorSchema>;

/** Commit only newline-terminated bytes, so split UTF-8 and torn rows are reread. */
export async function readAppended(path: string, previous?: Cursor) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const offset = previous?.offset ?? 0;
    assert(stat.size >= offset, `Append-only source shrank: ${path}`);
    const anchorSize = Math.min(offset, 256);
    const anchor = Buffer.alloc(anchorSize);
    if (anchorSize) {
      const read = await file.read(anchor, 0, anchorSize, offset - anchorSize);
      assert.equal(
        read.bytesRead,
        anchorSize,
        "Source changed during cursor validation",
      );
    }
    const hash = (data: Buffer) =>
      createHash("sha256").update(data).digest("hex");
    if (previous)
      assert.equal(
        hash(anchor),
        previous.anchor,
        `Committed source bytes changed: ${path}`,
      );
    const data = Buffer.alloc(stat.size - offset);
    let read = 0;
    while (read < data.length) {
      const part = await file.read(
        data,
        read,
        data.length - read,
        offset + read,
      );
      assert(part.bytesRead > 0, "Source shrank during incremental read");
      read += part.bytesRead;
    }
    const complete = data.lastIndexOf(10) + 1;
    const newOffset = offset + complete;
    const tail = Buffer.concat([anchor, data.subarray(0, complete)]).subarray(
      -256,
    );
    return {
      cursor: { offset: newOffset, anchor: hash(tail) },
      lines: data
        .subarray(0, complete)
        .toString("utf8")
        .split("\n")
        .filter(Boolean),
      partial: complete < data.length,
      bytesRead: data.length + anchor.length,
    };
  } finally {
    await file.close();
  }
}
