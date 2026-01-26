import crypto from "node:crypto";
import net from "node:net";

export type ExecHostRequest = {
  command: string[];
  rawCommand?: string | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approvalDecision?: "allow-once" | "allow-always" | null;
};

export type ExecHostRunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
};

export type ExecHostError = {
  code: string;
  message: string;
  reason?: string;
};

export type ExecHostPendingPayload = {
  reason?: string;
  timeoutMs?: number;
};

export type ExecHostResponse =
  | { ok: true; payload: ExecHostRunResult }
  | { ok: false; error: ExecHostError }
  | { ok: false; pending: true; payload?: ExecHostPendingPayload };

export async function requestExecHostViaSocket(params: {
  socketPath: string;
  token: string;
  request: ExecHostRequest;
  timeoutMs?: number;
  onPending?: (payload?: ExecHostPendingPayload) => void;
}): Promise<ExecHostResponse | null> {
  const { socketPath, token, request, onPending } = params;
  if (!socketPath || !token) return null;
  const baseTimeoutMs = params.timeoutMs ?? 20_000;
  // Extended timeout when approval is pending (5 minutes)
  const pendingTimeoutMs = 5 * 60 * 1000;
  return await new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    let buffer = "";
    let pendingReceived = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: ExecHostResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const requestJson = JSON.stringify(request);
    const nonce = crypto.randomBytes(16).toString("hex");
    const ts = Date.now();
    const hmac = crypto
      .createHmac("sha256", token)
      .update(`${nonce}:${ts}:${requestJson}`)
      .digest("hex");
    const payload = JSON.stringify({
      type: "exec",
      id: crypto.randomUUID(),
      nonce,
      ts,
      hmac,
      requestJson,
    });

    timer = setTimeout(() => {
      if (pendingReceived) {
        // Approval was pending but timed out - return pending response
        finish({ ok: false, pending: true, payload: { reason: "approval-timeout" } });
      } else {
        finish(null);
      }
    }, baseTimeoutMs);

    client.on("error", () => finish(null));
    client.connect(socketPath, () => {
      client.write(`${payload}\n`);
    });
    client.on("data", (data) => {
      buffer += data.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            type?: string;
            ok?: boolean;
            payload?: unknown;
            error?: unknown;
            pending?: boolean;
          };
          if (msg?.type === "exec-pending") {
            // Approval dialog is being shown on the node
            pendingReceived = true;
            const pendingPayload = msg.payload as ExecHostPendingPayload | undefined;
            // Extend timeout to allow user time to approve
            clearTimeout(timer);
            const extendedTimeout = pendingPayload?.timeoutMs ?? pendingTimeoutMs;
            timer = setTimeout(() => {
              finish({ ok: false, pending: true, payload: { reason: "approval-timeout" } });
            }, extendedTimeout);
            // Notify caller that approval is pending
            if (onPending) {
              onPending(pendingPayload);
            }
            continue;
          }
          if (msg?.type === "exec-res") {
            clearTimeout(timer);
            if (msg.ok === true && msg.payload) {
              finish({ ok: true, payload: msg.payload as ExecHostRunResult });
              return;
            }
            if (msg.ok === false && msg.error) {
              finish({ ok: false, error: msg.error as ExecHostError });
              return;
            }
            finish(null);
            return;
          }
        } catch {
          // ignore
        }
      }
    });
  });
}
