import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { deliverySchema, outboxSchema, type Delivery } from "./schema.js";
import { atomicJson, type Config } from "./storage.js";

const uuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const responseSchema = z
  .object({
    partialSuccess: z
      .object({
        rejectedSpans: z
          .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
          .optional(),
        errorMessage: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export async function deliver(
  path: string,
  receiptPath: string,
  config: Config,
): Promise<void> {
  const item = outboxSchema.parse(JSON.parse(await readFile(path, "utf8")));
  let receipt = deliverySchema.parse(
    JSON.parse(await readFile(receiptPath, "utf8")),
  );
  if (
    ["confirmed", "rejected"].includes(receipt.state) ||
    receipt.retryAt > Date.now()
  )
    return;
  const save = async (next: Delivery) => {
    await atomicJson(receiptPath, next);
    receipt = next;
  };
  const base = config.baseUrl.replace(/\/$/, "");
  if (["sending", "accepted", "uncertain"].includes(receipt.state)) {
    // An interrupted send is ambiguous. Lack of query visibility is NOT proof
    // of rejection: Laminar queues ingestion asynchronously.
    if (receipt.state === "sending")
      await save({
        ...receipt,
        state: "uncertain",
        error: "Worker exited before acknowledgement was saved",
      });
    const query = `SELECT count() AS copies FROM spans WHERE span_id = '${uuid("0000000000000000" + item.span.spanId)}' AND trace_id = '${uuid(item.span.traceId)}'`;
    const response = await fetch(`${base}/v1/sql/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.projectApiKey}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(config.queryTimeoutMs),
      redirect: "error",
    });
    assert(
      response.ok,
      `Laminar reconciliation failed: HTTP ${response.status}`,
    );
    const result = z
      .object({
        data: z
          .array(
            z.object({
              copies: z.union([
                z.number().int().nonnegative(),
                z.string().regex(/^\d+$/),
              ]),
            }),
          )
          .length(1),
      })
      .parse(await response.json());
    const copies = Number(result.data[0]!.copies);
    assert(copies <= 1, `Duplicate stored span detected: ${item.span.spanId}`);
    if (copies === 1)
      await save({
        ...receipt,
        state: "confirmed",
        retryAt: 0,
        error: undefined,
      });
    else await save({ ...receipt, retryAt: Date.now() + 10_000 });
    return;
  }
  assert.equal(deliverySchema.parse(receipt).state, "ready");
  await save({ state: "sending", attempts: receipt.attempts + 1, retryAt: 0 });
  try {
    const response = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.projectApiKey}`,
      },
      body: JSON.stringify(item.request),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
    if (response.status === 429) {
      await save({
        ...receipt,
        state: "ready",
        error: "HTTP 429: rejected before ingestion",
        retryAt:
          Date.now() +
          Math.min(60_000, 1000 * 2 ** Math.min(receipt.attempts, 6)),
      });
    } else if ([400, 401, 403, 404, 405, 413, 415].includes(response.status)) {
      await save({
        ...receipt,
        state: "rejected",
        error: `HTTP ${response.status}: request rejected`,
        retryAt: 0,
      });
    }
    assert(response.ok, `Laminar OTLP export failed: HTTP ${response.status}`);
    const body = await response.text();
    const result = responseSchema.parse(body === "" ? {} : JSON.parse(body));
    assert(
      Number(result.partialSuccess?.rejectedSpans ?? 0) === 0,
      "Laminar partial rejection; delivery requires reconciliation",
    );
    await save({ ...receipt, state: "accepted", error: undefined, retryAt: 0 });
  } catch (error) {
    // Persist the delivery consequence, then propagate the original stack.
    if (receipt.state === "sending") {
      const notConnected = z
        .object({
          cause: z.object({
            code: z.enum(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]),
          }),
        })
        .safeParse(error).success;
      await save({
        ...receipt,
        state: notConnected ? "ready" : "uncertain",
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        retryAt:
          Date.now() +
          Math.min(60_000, 1000 * 2 ** Math.min(receipt.attempts, 6)),
      });
    }
    throw error;
  }
}
