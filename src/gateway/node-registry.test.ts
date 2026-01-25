import { describe, expect, test, vi } from "vitest";

import { NodeRegistry } from "./node-registry.js";

function buildNodeClient() {
  const send = vi.fn();
  const client = {
    socket: { send },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "node-1",
        version: "1.0.0",
        platform: "node",
        mode: "node",
      },
    },
    connId: "conn-1",
  };
  return { client: client as any, send };
}

describe("NodeRegistry chunked invoke results", () => {
  test("assembles chunked payloads and resolves invoke", async () => {
    const registry = new NodeRegistry();
    const { client, send } = buildNodeClient();
    registry.register(client, { remoteIp: "127.0.0.1" });

    const invokePromise = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { cmd: "echo ok" },
      timeoutMs: 5000,
      idempotencyKey: "idem-1",
    });

    const sent = send.mock.calls[0]?.[0] as string;
    const payload = JSON.parse(sent) as { payload?: { id?: string } };
    const invokeId = payload.payload?.id ?? "";

    const payloadJSON = JSON.stringify({ ok: true, value: "hello" });
    const payloadBytes = Buffer.from(payloadJSON, "utf8");
    const chunkBytes = 4;
    const chunkCount = Math.ceil(payloadBytes.length / chunkBytes);

    const start = registry.startInvokeResultTransfer({
      id: invokeId,
      nodeId: "node-1",
      totalBytes: payloadBytes.length,
      chunkCount,
      maxInvokeResultBytes: 1024 * 1024,
    });
    expect(start.ok).toBe(true);

    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = payloadBytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
      const res = registry.handleInvokeResultChunk({
        id: invokeId,
        nodeId: "node-1",
        index,
        data: chunk.toString("base64"),
        bytes: chunk.length,
      });
      expect(res.ok).toBe(true);
    }

    const result = await invokePromise;
    expect(result.ok).toBe(true);
    expect(result.payloadJSON).toBe(payloadJSON);
  });

  test("fails on out-of-order chunks", async () => {
    const registry = new NodeRegistry();
    const { client, send } = buildNodeClient();
    registry.register(client, { remoteIp: "127.0.0.1" });

    const invokePromise = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { cmd: "echo ok" },
      timeoutMs: 5000,
      idempotencyKey: "idem-2",
    });

    const sent = send.mock.calls[0]?.[0] as string;
    const payload = JSON.parse(sent) as { payload?: { id?: string } };
    const invokeId = payload.payload?.id ?? "";

    const payloadJSON = JSON.stringify({ ok: true });
    const payloadBytes = Buffer.from(payloadJSON, "utf8");
    const chunkBytes = 4;
    const chunkCount = Math.ceil(payloadBytes.length / chunkBytes);

    const start = registry.startInvokeResultTransfer({
      id: invokeId,
      nodeId: "node-1",
      totalBytes: payloadBytes.length,
      chunkCount,
      maxInvokeResultBytes: 1024 * 1024,
    });
    expect(start.ok).toBe(true);

    const firstChunk = payloadBytes.subarray(chunkBytes, chunkBytes * 2);
    const res = registry.handleInvokeResultChunk({
      id: invokeId,
      nodeId: "node-1",
      index: 1,
      data: firstChunk.toString("base64"),
      bytes: firstChunk.length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("chunk-out-of-order");

    const result = await invokePromise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_REQUEST");
  });
});
