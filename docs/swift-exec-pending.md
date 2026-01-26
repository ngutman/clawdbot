# Swift App: exec-pending Protocol

## Overview

When the macOS Clawdbot companion app shows an approval dialog for a command, it should send an intermediate `exec-pending` message to notify the gateway that the command is waiting for user approval. This prevents timeout errors while the user is deciding whether to approve the command.

## Protocol

### Message Format

When showing the approval dialog, send this JSON message over the Unix socket:

```json
{
  "type": "exec-pending",
  "payload": {
    "reason": "awaiting-approval",
    "timeoutMs": 300000
  }
}
```

### Fields

- `type`: Must be `"exec-pending"`
- `payload.reason`: Optional. Reason for pending state (e.g., `"awaiting-approval"`)
- `payload.timeoutMs`: Optional. Suggested extended timeout in milliseconds (default: 5 minutes)

### Timing

1. Receive `exec` request from gateway
2. Determine that command requires user approval
3. **Immediately** send `exec-pending` message
4. Show approval dialog to user
5. Wait for user decision
6. Send `exec-res` with result (success or denial)

### Example Flow

```
Gateway → App:  { "type": "exec", "id": "...", ... }
App → Gateway:  { "type": "exec-pending", "payload": { "reason": "awaiting-approval" } }
[User sees approval dialog]
[User clicks Approve]
App → Gateway:  { "type": "exec-res", "ok": true, "payload": { ... } }
```

### Benefits

1. Gateway knows the command is pending approval (not stuck/timed out)
2. Gateway extends its timeout to 5 minutes
3. CLI receives `AWAITING_NODE_APPROVAL` status instead of generic timeout error
4. Better user experience with clear feedback

## TypeScript Side (Already Implemented)

The TypeScript side is ready to handle `exec-pending` messages:

- `src/infra/exec-host.ts`: Handles `exec-pending` messages, extends timeout, calls `onPending` callback
- `src/node-host/runner.ts`: Relays pending status to gateway via `exec.pending` event
- `src/gateway/node-registry.ts`: Extends invoke timeout when pending, returns `AWAITING_NODE_APPROVAL` error code
- `src/gateway/server-node-events.ts`: Handles `exec.pending` events for logging

## Error Codes

When approval times out or is pending, the error will have:
- `code`: `"AWAITING_NODE_APPROVAL"`
- `message`: `"Command is waiting for user approval on the node"`

This replaces the generic `"gateway timeout after Xms"` error.
