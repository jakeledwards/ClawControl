# Protocol v4 Support for ClawControl

**Date**: 2026-05-22
**Status**: Approved
**Owner**: ClawControl client

## Summary

Add OpenClaw Gateway WS protocol v4 support to the ClawControl client while preserving v3 fallback. Core changes are in the client handshake (negotiate v4) and the chat-delta event handler (parse the new `deltaText` + `replace` shape). Foundational v4 surface area is also picked up: `pluginSurfaceUrls` capture from `hello-ok`, `models.list` `view` parameter, and richer auth-error details. The negotiated protocol version is displayed in the settings modal so users can see whether v4 features are active.

## Background

OpenClaw bumped the Gateway WebSocket protocol to v4 in the v2026.5.x line. Current ClawControl pins `minProtocol: 3, maxProtocol: 3` (see `src/lib/openclaw/client.ts:461-462`) and parses chat-delta events using the v3 cumulative `payload.delta` / `payload.message.content` fields. v4 introduces:

- `chat` delta payloads carry `deltaText` (true delta, not cumulative) plus an optional `replace: true` flag for non-prefix replacements. The cumulative `message` snapshot remains as a final.
- `hello-ok` returns `protocol: 4` and may include `pluginSurfaceUrls` (a map of plugin-surface name → scoped hosted URL, e.g. for canvas).
- Auth failures now include `error.details.code`, `details.reason`, `details.canRetryWithDeviceToken`, and `details.recommendedNextStep` for better recovery UX.
- `models.list` accepts a `view` parameter (`default | configured | all`).

This change keeps v3 compatibility through protocol negotiation: clients advertise a range and the server picks the highest mutually supported version.

## Goals

- Negotiate v4 against OpenClaw servers ≥ v2026.5.x.
- Preserve v3 fallback against older servers without user-visible regressions.
- Correctly handle v4 `chat` delta events (`deltaText`, `replace`).
- Surface v4 auth-error details to the store so the UI can show recovery hints.
- Capture `pluginSurfaceUrls` from `hello-ok` for future plugin-surface consumers.
- Pass an optional `view` parameter to `models.list`.
- Display the negotiated protocol version in the settings modal.

## Non-goals (this iteration)

- New v4 session events (`session.tool`, `session.message`, `session.operation`).
- New v4 RPCs: `tasks.list`/`get`/`cancel`, `sessions.steer`, `sessions.compact`, `sessions.subscribe`/`unsubscribe`, `sessions.messages.subscribe`/`unsubscribe`.
- Talk/voice family (`talk.*`).
- QR setup-code operator-token handoff (`hello-ok.auth.deviceTokens`).
- Canvas plugin surface consumption (foundational `pluginSurfaceUrls` capture only).
- `device.token.rotate` / `device.token.revoke`.

## Architecture

Five touched files in `src/lib/openclaw/`, three touched outside (store + settings modal + cert-error modal). No new modules.

### 1. Handshake (`src/lib/openclaw/client.ts`)

**Connect frame**: bump `maxProtocol` from `3` to `4`. `minProtocol` stays `3` so v3 servers still accept us. The server picks the highest mutually supported version.

**hello-ok branch** (`handleMessage`): capture two new fields from `resFrame.payload` onto the `OpenClawClient` instance:
- `protocol` (number) → new public field `negotiatedProtocol`, default to `3` when missing so v4-only branches don't accidentally fire against v3 servers and so the UI can render "protocol v3" for older servers.
- `pluginSurfaceUrls` (Record<string,string>) → new public field, default `{}`.

Both fields are also exposed through the existing `connected` event payload (which already passes the full `hello-ok`), so the store can hydrate its own state from the event without reaching into the client instance.

### 2. Chat-delta v4 handler (`src/lib/openclaw/client.ts`)

In the `case 'chat':` `payload.state === 'delta'` branch, add a v4 detection path before the existing v3 logic:

```
if (typeof payload.deltaText === 'string') {
  // v4 path
  ensureStream(ss, 'chat', 'delta', payload.runId, sk)
  if (ss.source !== 'chat') return
  const text = stripSystemNotifications(stripAnsi(payload.deltaText))
  if (!text || isNoiseContent(text) || isHeartbeatContent(text)) return
  if (payload.replace === true) {
    ss.text = text
    emit('streamReplace', { text, sessionKey: sk })
  } else {
    ss.text += text
    emit('streamChunk', { text, sessionKey: sk })
  }
  return
}
// existing v3 path (unchanged)
```

A new `streamReplace` event is emitted only when v4 sends `replace: true`. The store listens for it and replaces the current streaming placeholder text instead of appending. MEDIA-line stripping that exists in the v3 branch is also applied to v4 `deltaText` to preserve current behavior.

The active-stream guard (`activeStreamKey` single-emit gate) still applies — both v3 and v4 paths route through `applyStreamText` for `streamChunk` emission, or directly emit `streamReplace` for the v4 replacement case (which intentionally bypasses the cumulative reconciliation since `replace` is authoritative).

**Final state** (`payload.state === 'final'`) is unchanged — both v3 and v4 emit a canonical `message` snapshot, which the existing code already handles.

### 3. Auth error details (`src/lib/openclaw/client.ts` + store)

In the hello-ok failure branch (`!resFrame.ok && !this.authenticated`), when `resFrame.error?.details` is present, extract:
- `code: string`
- `reason: string`
- `canRetryWithDeviceToken: boolean`
- `recommendedNextStep: string` (one of `retry_with_device_token`, `update_auth_configuration`, `update_auth_credentials`, `wait_then_retry`, `review_auth_configuration`)

Emit a new `authError` event with `{ code, reason, canRetryWithDeviceToken, recommendedNextStep, message }`. The existing `pairingRequired` and `deviceIdentityStale` paths fire first when matched, so this event is a catch-all for other auth failures.

**Store**: add a new `connectionErrorHint: string | null` field next to the existing `connectionError`. The store maps `recommendedNextStep` codes to human-readable hints. The `SettingsModal` connection section already renders `connectionError` inline; the hint renders directly under it. `CertErrorModal` is unchanged — it only opens for TLS/cert failures.

The client also handles retryable handshake responses: `error.code === 'UNAVAILABLE'` with `error.details.reason === 'startup-sidecars'` (server still booting) does NOT set `suppressReconnect`. Instead it emits a `serverStarting` event with `retryAfterMs` so the normal reconnect loop runs until the gateway is ready.

### 4. `models.list` view parameter (`src/lib/openclaw/client.ts`)

`OpenClawClient.listModels()` (defined at `client.ts:1304`) gets an optional `view?: 'default' | 'configured' | 'all'` parameter, defaulting to `undefined` (server picks). The only current call site is `src/lib/slash-command-executor.ts:100`; it can stay on the default behavior. v3 servers ignore unknown params, so passing `view` unconditionally is safe.

### 5. UI: protocol version display (`src/components/SettingsModal.tsx`)

Add a read-only row to the existing settings modal next to the server URL/version display:

```
OpenClaw v2026.5.20 (protocol v4)
```

Falls back gracefully:
- No server version: `OpenClaw (protocol v4)`
- No protocol negotiated (pre-connect): hide the row
- Both fields available: render as above

State source: extend the Zustand store with `protocolVersion: number | null` (set on the `connected` event) and read it in `SettingsModal`.

## Data flow: v4 chat-delta event

```
WS frame  → handleMessage()
          → handleNotification('chat', payload)
            payload.state === 'delta', payload.deltaText = "foo "

ensureStream(ss, 'chat', 'delta', runId, sk)
strip ansi/noise on payload.deltaText → "foo "

if payload.replace === true:
  ss.text = "foo "
  emit('streamReplace', { text: "foo ", sessionKey })
else:
  ss.text += "foo "   // append true delta
  emit('streamChunk', { text: "foo ", sessionKey })

Store listener:
  on 'streamChunk'   → append to streaming placeholder content
  on 'streamReplace' → swap streaming placeholder content
```

## Error handling

- **Unknown / missing `protocol` in hello-ok**: default to `3`. v4-only branches gate on `negotiatedProtocol >= 4`, so they stay dormant.
- **`deltaText` missing on a v3 server**: the v4 branch checks `typeof payload.deltaText === 'string'` and falls through to the existing v3 path.
- **`replace=true` without prior text**: behaves identically to `replace=false` (sets `ss.text` to the new text, emits `streamReplace` which the store handles equivalently for an empty placeholder).
- **`pluginSurfaceUrls` missing**: stored as empty object. The existing canvas extraction falls back from the deprecated `canvasHostUrl` to `pluginSurfaceUrls.canvas` when present, so v4 servers that drop the legacy field still light up the canvas panel.
- **`models.list` view ignored by v3 server**: server returns its default list, unchanged behavior.
- **Auth error without `details`**: existing pairing/stale-identity detection still runs; `authError` event simply doesn't fire.

## Testing

Manual verification matches the existing v3 protocol approach (no protocol-level test fixtures live in the repo):

1. Connect to a v2026.5.x OpenClaw server:
   - Settings modal shows `OpenClaw v2026.5.x (protocol v4)`.
   - Streaming chat exchange produces clean text with no duplicated content.
   - A run that triggers a v4 `replace: true` event (e.g., mid-stream non-prefix correction) swaps content without corruption.
2. Connect to an older v3 server (a v3.28 install):
   - Settings modal shows `OpenClaw v3.28.x (protocol v3)`.
   - Existing chat streaming behavior unchanged.
3. Trigger an auth failure (bad token, paired device removed):
   - `authError` event fires with `recommendedNextStep`.
   - SettingsModal renders the recovery hint directly under the existing `connectionError` row.
4. Connect to a v4 server while it is still finishing startup (`UNAVAILABLE` + `startup-sidecars`): client keeps reconnecting normally rather than treating the response as a terminal auth failure.
5. `npm run typecheck` and `npm run build` pass.

## Open questions

None — design approved by user 2026-05-22.

## Out-of-scope items worth tracking for future iterations

- Wire `session.tool` / `session.message` / `session.operation` events so externally-started runs (e.g., via CLI or another control UI) surface tool cards and transcript updates in the active session.
- Tasks ledger (`tasks.list`/`get`/`cancel`) — could replace or augment current subagent task tracking.
- `sessions.steer` for interrupt-and-steer instead of abort-and-restart.
- Talk/voice family — substantial scope, separate brainstorm.
- QR setup-code operator handoff — only needed if ClawControl ships the QR onboarding path.
