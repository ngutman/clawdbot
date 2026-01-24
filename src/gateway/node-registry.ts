import { createHash, randomUUID } from "node:crypto";

import type { GatewayWsClient } from "./server/ws-types.js";

export type NodeSession = {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
};

type PendingInvoke = {
  nodeId: string;
  command: string;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingInvokeTransfer = {
  nodeId: string;
  totalBytes: number;
  chunkBytes: number;
  chunkCount: number;
  nextIndex: number;
  bytesReceived: number;
  sha256: string;
  hash: ReturnType<typeof createHash>;
  chunks: Buffer[];
};

type InvokeTransferFailureReason =
  | "unknown-invoke-id"
  | "payload-too-large"
  | "chunk-out-of-order"
  | "chunk-bytes-mismatch"
  | "hash-mismatch";

type InvokeTransferResult =
  | { ok: true }
  | { ok: false; reason: InvokeTransferFailureReason; message: string };

export type NodeInvokeResult = {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
};

export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();
  private invokeTransfers = new Map<string, PendingInvokeTransfer>();
  private inflightBytes = 0;

  register(client: GatewayWsClient, opts: { remoteIp?: string | undefined }) {
    const connect = client.connect;
    const nodeId = connect.device?.id ?? connect.client.id;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const commands = Array.isArray((connect as { commands?: string[] }).commands)
      ? ((connect as { commands?: string[] }).commands ?? [])
      : [];
    const permissions =
      typeof (connect as { permissions?: Record<string, boolean> }).permissions === "object"
        ? ((connect as { permissions?: Record<string, boolean> }).permissions ?? undefined)
        : undefined;
    const pathEnv =
      typeof (connect as { pathEnv?: string }).pathEnv === "string"
        ? (connect as { pathEnv?: string }).pathEnv
        : undefined;
    const session: NodeSession = {
      nodeId,
      connId: client.connId,
      client,
      displayName: connect.client.displayName,
      platform: connect.client.platform,
      version: connect.client.version,
      coreVersion: (connect as { coreVersion?: string }).coreVersion,
      uiVersion: (connect as { uiVersion?: string }).uiVersion,
      deviceFamily: connect.client.deviceFamily,
      modelIdentifier: connect.client.modelIdentifier,
      remoteIp: opts.remoteIp,
      caps,
      commands,
      permissions,
      pathEnv,
      connectedAtMs: Date.now(),
    };
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    return session;
  }

  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) return null;
    this.nodesByConn.delete(connId);
    this.nodesById.delete(nodeId);
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`node disconnected (${pending.command})`));
      this.pendingInvokes.delete(id);
    }
    for (const [id, transfer] of this.invokeTransfers.entries()) {
      if (transfer.nodeId !== nodeId) continue;
      this.clearInvokeTransfer(id);
    }
    return nodeId;
  }

  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
  }

  async invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult> {
    const node = this.nodesById.get(params.nodeId);
    if (!node) {
      return {
        ok: false,
        error: { code: "NOT_CONNECTED", message: "node not connected" },
      };
    }
    const requestId = randomUUID();
    const payload = {
      id: requestId,
      nodeId: params.nodeId,
      command: params.command,
      paramsJSON:
        "params" in params && params.params !== undefined ? JSON.stringify(params.params) : null,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    };
    const ok = this.sendEventToSession(node, "node.invoke.request", payload);
    if (!ok) {
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
      };
    }
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<NodeInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        this.clearInvokeTransfer(requestId);
        resolve({
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        nodeId: params.nodeId,
        command: params.command,
        resolve,
        reject,
        timer,
      });
    });
  }

  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) return false;
    if (pending.nodeId !== params.nodeId) return false;
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(params.id);
    this.clearInvokeTransfer(params.id);
    pending.resolve({
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
      error: params.error ?? null,
    });
    return true;
  }

  startInvokeResultTransfer(params: {
    id: string;
    nodeId: string;
    totalBytes: number;
    chunkBytes: number;
    chunkCount: number;
    sha256: string;
    maxInvokeResultBytes: number;
    maxInflightBytes: number;
  }): InvokeTransferResult {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending || pending.nodeId !== params.nodeId) {
      return { ok: false, reason: "unknown-invoke-id", message: "unknown invoke id" };
    }
    if (this.invokeTransfers.has(params.id)) {
      this.resolveInvokeError(params.id, params.nodeId, {
        code: "INVALID_REQUEST",
        message: "chunk out of order",
      });
      return {
        ok: false,
        reason: "chunk-out-of-order",
        message: "chunk out of order",
      };
    }
    if (params.totalBytes > params.maxInvokeResultBytes) {
      this.resolveInvokeError(params.id, params.nodeId, {
        code: "INVALID_REQUEST",
        message: "payload too large",
      });
      return { ok: false, reason: "payload-too-large", message: "payload too large" };
    }
    if (this.inflightBytes + params.totalBytes > params.maxInflightBytes) {
      this.resolveInvokeError(params.id, params.nodeId, {
        code: "INVALID_REQUEST",
        message: "payload too large",
      });
      return { ok: false, reason: "payload-too-large", message: "payload too large" };
    }
    this.inflightBytes += params.totalBytes;
    this.invokeTransfers.set(params.id, {
      nodeId: params.nodeId,
      totalBytes: params.totalBytes,
      chunkBytes: params.chunkBytes,
      chunkCount: params.chunkCount,
      nextIndex: 0,
      bytesReceived: 0,
      sha256: params.sha256.toLowerCase(),
      hash: createHash("sha256"),
      chunks: [],
    });
    return { ok: true };
  }

  handleInvokeResultChunk(params: {
    id: string;
    nodeId: string;
    index: number;
    data: string;
    bytes: number;
  }): InvokeTransferResult {
    const transfer = this.invokeTransfers.get(params.id);
    if (!transfer || transfer.nodeId !== params.nodeId) {
      const pending = this.pendingInvokes.get(params.id);
      if (pending && pending.nodeId === params.nodeId) {
        this.resolveInvokeError(params.id, params.nodeId, {
          code: "INVALID_REQUEST",
          message: "unknown invoke id",
        });
      }
      return { ok: false, reason: "unknown-invoke-id", message: "unknown invoke id" };
    }
    if (params.index !== transfer.nextIndex || params.index >= transfer.chunkCount) {
      this.resolveInvokeError(params.id, params.nodeId, {
        code: "INVALID_REQUEST",
        message: "chunk out of order",
      });
      return { ok: false, reason: "chunk-out-of-order", message: "chunk out of order" };
    }
    const decoded = Buffer.from(params.data, "base64");
    if (decoded.length !== params.bytes) {
      this.resolveInvokeError(params.id, params.nodeId, {
        code: "INVALID_REQUEST",
        message: "chunk bytes mismatch",
      });
      return { ok: false, reason: "chunk-bytes-mismatch", message: "chunk bytes mismatch" };
    }
    const nextBytes = transfer.bytesReceived + decoded.length;
    if (nextBytes > transfer.totalBytes) {
      this.resolveInvokeError(params.id, params.nodeId, {
        code: "INVALID_REQUEST",
        message: "chunk bytes mismatch",
      });
      return { ok: false, reason: "chunk-bytes-mismatch", message: "chunk bytes mismatch" };
    }
    transfer.bytesReceived = nextBytes;
    transfer.nextIndex += 1;
    transfer.hash.update(decoded);
    transfer.chunks.push(decoded);

    if (transfer.nextIndex === transfer.chunkCount) {
      if (transfer.bytesReceived !== transfer.totalBytes) {
        this.resolveInvokeError(params.id, params.nodeId, {
          code: "INVALID_REQUEST",
          message: "chunk bytes mismatch",
        });
        return { ok: false, reason: "chunk-bytes-mismatch", message: "chunk bytes mismatch" };
      }
      const digest = transfer.hash.digest("hex").toLowerCase();
      if (digest !== transfer.sha256) {
        this.resolveInvokeError(params.id, params.nodeId, {
          code: "INVALID_REQUEST",
          message: "hash mismatch",
        });
        return { ok: false, reason: "hash-mismatch", message: "hash mismatch" };
      }
      const payloadJSON = Buffer.concat(transfer.chunks, transfer.totalBytes).toString("utf8");
      this.handleInvokeResult({
        id: params.id,
        nodeId: params.nodeId,
        ok: true,
        payloadJSON,
      });
    }

    return { ok: true };
  }

  abortInvokeResultTransfer(params: {
    id: string;
    nodeId: string;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending || pending.nodeId !== params.nodeId) {
      const transfer = this.invokeTransfers.get(params.id);
      if (transfer && transfer.nodeId === params.nodeId) {
        this.clearInvokeTransfer(params.id);
      }
      return false;
    }
    this.handleInvokeResult({
      id: params.id,
      nodeId: params.nodeId,
      ok: false,
      error: params.error ?? { code: "UNAVAILABLE", message: "node invoke aborted" },
    });
    return true;
  }

  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) return false;
    return this.sendEventToSession(node, event, payload);
  }

  private sendEventInternal(node: NodeSession, event: string, payload: unknown): boolean {
    try {
      node.client.socket.send(
        JSON.stringify({
          type: "event",
          event,
          payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private sendEventToSession(node: NodeSession, event: string, payload: unknown): boolean {
    return this.sendEventInternal(node, event, payload);
  }

  private resolveInvokeError(
    id: string,
    nodeId: string,
    error: { code?: string; message?: string },
  ) {
    this.handleInvokeResult({
      id,
      nodeId,
      ok: false,
      error,
    });
  }

  private clearInvokeTransfer(id: string) {
    const transfer = this.invokeTransfers.get(id);
    if (!transfer) return;
    this.invokeTransfers.delete(id);
    this.inflightBytes = Math.max(0, this.inflightBytes - transfer.totalBytes);
  }
}
