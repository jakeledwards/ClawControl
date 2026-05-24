# OpenClaw Protocol v4 Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenClaw Gateway WebSocket protocol v4 support to ClawControl while preserving v3 fallback.

**Architecture:** Bump the WS handshake to advertise `maxProtocol: 4` while keeping `minProtocol: 3`. Capture the negotiated protocol and `pluginSurfaceUrls` from `hello-ok`. Add a v4 branch to the chat-delta event handler that consumes the new `deltaText` + `replace` fields, emitting a new `streamReplace` event when needed. Surface v4 auth error details to the store/UI. Add an optional `view` parameter to `models.list`. Display the negotiated protocol version in the settings modal.

**Tech Stack:** TypeScript, Zustand store, React, WebSocket. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-22-protocol-v4-support-design.md](../specs/2026-05-22-protocol-v4-support-design.md)

**Files touched:**
- Modify: `src/lib/openclaw/client.ts` — handshake bump, hello-ok parsing, chat-delta v4 branch, auth error emission, models.list view param
- Modify: `src/store/index.ts` — new state fields, `connected` event handler, `streamReplace` listener, `authError` listener
- Modify: `src/components/SettingsModal.tsx` — protocol/version display
- Modify: `src/components/CertErrorModal.tsx` — recovery hint display

**Testing approach:** This codebase has no unit tests for the WS client (verified — see `npm run test` results, no `*.test.ts` files under `src/lib/openclaw/`). Verification is via `npm run typecheck`, `npm run lint`, `npm run build`, and the manual checks documented in the spec. The plan follows the existing pattern: write the code, typecheck, lint, build, then manual smoke test.

---

## Task 1: Bump handshake to protocol v4 + capture protocol & pluginSurfaceUrls

**Files:**
- Modify: `src/lib/openclaw/client.ts:60-101` (add private fields)
- Modify: `src/lib/openclaw/client.ts:456-481` (connect frame)
- Modify: `src/lib/openclaw/client.ts:544-561` (hello-ok handler)

- [ ] **Step 1: Add public fields for negotiated protocol and plugin surface URLs**

In `src/lib/openclaw/client.ts`, locate the `OpenClawClient` class field declarations near `public serverVersion: string | null = null` (around line 72) and add two new public fields directly after `serverVersion`:

```typescript
  /** Negotiated protocol version from hello-ok (3 = legacy, 4 = current). Defaults to 3 when missing. */
  public negotiatedProtocol: number = 3
  /** Plugin surface URLs map from hello-ok (e.g. { canvas: "https://..." }). */
  public pluginSurfaceUrls: Record<string, string> = {}
```

- [ ] **Step 2: Bump maxProtocol to 4 in performHandshake**

Find the connect frame in `performHandshake()` at `src/lib/openclaw/client.ts:456-478`. Replace the existing `params:` block with the v4-capable version:

```typescript
    const connectMsg: RequestFrame = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 4,
        role: 'operator',
        scopes,
        client: {
          id: OPENCLAW_CLIENT_ID,
          displayName: this.deviceName || APP_NAME,
          version: APP_VERSION,
          platform: getPlatform(),
          mode: OPENCLAW_CLIENT_MODE
        },
        caps: ['tool-events', 'thinking-events', 'plugin-approvals'],
        auth: this.token
          ? (this.authMode === 'password' ? { password: this.token } : { token: this.token })
          : undefined,
        device
      }
    }
```

Only `maxProtocol` changes from `3` to `4`.

- [ ] **Step 3: Capture negotiated protocol + pluginSurfaceUrls in hello-ok**

In `handleMessage()`, find the hello-ok success block at `src/lib/openclaw/client.ts:544-560`. Add the two new capture lines between the existing version capture and the `startHealthCheck()` call:

```typescript
        // Special case: Initial Connect Response
        if (!this.authenticated && resFrame.ok && resFrame.payload?.type === 'hello-ok') {
          this.authenticated = true
          // Capture server tick interval from hello-ok policy (if provided)
          const policyTick = resFrame.payload?.policy?.tickIntervalMs
          if (typeof policyTick === 'number' && policyTick > 0) {
            this.tickIntervalMs = policyTick
          }
          // Capture server version from hello-ok payload (v2026.3.11)
          const version = resFrame.payload?.runtimeVersion || resFrame.payload?.version
          if (typeof version === 'string') {
            this.serverVersion = version
          }
          // Capture negotiated protocol version (v2026.5.x added v4)
          const protocol = resFrame.payload?.protocol
          if (typeof protocol === 'number' && protocol >= 3) {
            this.negotiatedProtocol = protocol
          }
          // Capture plugin surface URLs (v4 pluginSurfaceUrls; v3 ignored)
          const surfaces = resFrame.payload?.pluginSurfaceUrls
          if (surfaces && typeof surfaces === 'object' && !Array.isArray(surfaces)) {
            const collected: Record<string, string> = {}
            for (const [k, v] of Object.entries(surfaces)) {
              if (typeof v === 'string' && v) collected[k] = v
            }
            this.pluginSurfaceUrls = collected
          }
          this.startHealthCheck()
          this.resetTickWatch() // Start watching for server ticks
          this.emit('connected', resFrame.payload)
          resolve?.()
          return
        }
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: no new errors. Pre-existing errors (if any) are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openclaw/client.ts
git commit -m "$(cat <<'EOF'
Negotiate OpenClaw protocol v4 in WS handshake

Bumps maxProtocol from 3 to 4 in the connect frame so newer servers can
negotiate v4. minProtocol stays at 3 so v3 servers still accept us. The
hello-ok handler now captures the negotiated protocol number and any
pluginSurfaceUrls map onto public client fields for downstream consumers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add v4 chat deltaText/replace handling

**Files:**
- Modify: `src/lib/openclaw/client.ts:822-846` (chat:delta branch)

- [ ] **Step 1: Locate the chat:delta branch**

Open `src/lib/openclaw/client.ts` and find the `case 'chat': { ... payload.state === 'delta'` branch around line 822. The current code looks like:

```typescript
      case 'chat': {
        const ss = this.getStream(sk)

        if (payload.state === 'delta') {
          this.ensureStream(ss, 'chat', 'cumulative', payload.runId, sk)
          if (ss.source !== 'chat') return // Another stream type already claimed this session

          let rawText = stripSystemNotifications(
            payload.message?.content !== undefined
              ? extractTextFromContent(payload.message.content)
              : (typeof payload.delta === 'string' ? stripAnsi(payload.delta) : '')
          )

          // Strip MEDIA: lines and trailing partial MEDIA tokens from streaming text
          if (rawText.includes('MEDIA')) {
            rawText = rawText
              .split('\n')
              .filter(l => !/\bMEDIA:\s*/i.test(l))
              .join('\n')
              .replace(/\s*\bMEDIA\s*$/, '')
              .trim()
          }

          if (rawText && !isNoiseContent(rawText) && !isHeartbeatContent(rawText)) {
            const nextText = this.mergeIncoming(ss, rawText, 'cumulative')
            this.applyStreamText(ss, nextText, sk)
          }
          return
        }
```

- [ ] **Step 2: Insert the v4 branch before the existing v3 logic**

Replace the entire `if (payload.state === 'delta') { ... return }` block with the version below, which checks for v4 `deltaText` first and falls back to the existing v3 path:

```typescript
        if (payload.state === 'delta') {
          // v4 path: payload.deltaText is a true delta with optional replace flag.
          if (typeof payload.deltaText === 'string') {
            this.ensureStream(ss, 'chat', 'delta', payload.runId, sk)
            if (ss.source !== 'chat') return

            let text = stripSystemNotifications(stripAnsi(payload.deltaText))
            // Strip MEDIA: lines / trailing partial MEDIA tokens, same as v3 path.
            if (text.includes('MEDIA')) {
              text = text
                .split('\n')
                .filter(l => !/\bMEDIA:\s*/i.test(l))
                .join('\n')
                .replace(/\s*\bMEDIA\s*$/, '')
            }
            if (!text || isNoiseContent(text) || isHeartbeatContent(text)) return

            if (payload.replace === true) {
              // Authoritative replacement — overwrite accumulated text and tell the store.
              ss.text = text
              ss.blockOffset = 0
              // Honor the single-stream-key guard used by applyStreamText.
              if (this.activeStreamKey === null) {
                this.activeStreamKey = sk
              }
              if (this.activeStreamKey === sk) {
                this.emit('streamReplace', { text, sessionKey: sk })
              }
              return
            }

            // Append true delta. Route through mergeIncoming('delta') so the
            // existing dedup, suffix-overlap, and runaway-text protections
            // also cover v4 deltas if the server replays or overlaps frames.
            const nextText = this.mergeIncoming(ss, text, 'delta')
            this.applyStreamText(ss, nextText, sk)
            return
          }

          // v3 path (cumulative payload.delta / payload.message.content) — unchanged.
          this.ensureStream(ss, 'chat', 'cumulative', payload.runId, sk)
          if (ss.source !== 'chat') return

          let rawText = stripSystemNotifications(
            payload.message?.content !== undefined
              ? extractTextFromContent(payload.message.content)
              : (typeof payload.delta === 'string' ? stripAnsi(payload.delta) : '')
          )

          // Strip MEDIA: lines and trailing partial MEDIA tokens from streaming text
          if (rawText.includes('MEDIA')) {
            rawText = rawText
              .split('\n')
              .filter(l => !/\bMEDIA:\s*/i.test(l))
              .join('\n')
              .replace(/\s*\bMEDIA\s*$/, '')
              .trim()
          }

          if (rawText && !isNoiseContent(rawText) && !isHeartbeatContent(rawText)) {
            const nextText = this.mergeIncoming(ss, rawText, 'cumulative')
            this.applyStreamText(ss, nextText, sk)
          }
          return
        }
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/openclaw/client.ts
git commit -m "$(cat <<'EOF'
Handle OpenClaw v4 chat deltaText events

v4 chat-delta payloads carry `deltaText` (true delta) plus optional
`replace: true` for non-prefix replacements. The handler now branches on
deltaText presence before falling through to the existing v3 cumulative
path. Replacements emit a new `streamReplace` event the store will use
to overwrite the streaming placeholder; ordinary deltas emit the
existing `streamChunk` via applyStreamText so the single-stream-key
guard and dedup logic remain shared.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Emit authError event with v4 details

**Files:**
- Modify: `src/lib/openclaw/client.ts:571-593` (hello-ok failure branch)

- [ ] **Step 1: Locate the failed-connect branch**

In `src/lib/openclaw/client.ts`, find the `else if (!resFrame.ok && !this.authenticated)` block around line 571. The current code looks like:

```typescript
        } else if (!resFrame.ok && !this.authenticated) {
          // Failed connect response — don't reconnect with same bad credentials
          this.suppressReconnect = true
          const errorCode = resFrame.error?.code
          const errorMsg = resFrame.error?.message || 'Handshake failed'
          if (errorCode === 'NOT_PAIRED') {
            this.emit('pairingRequired', {
              requestId: resFrame.error?.details?.requestId,
              deviceId: this.deviceIdentity?.id
            })
            reject?.(new Error('NOT_PAIRED'))
            return
          }
          // Stale device identity — keypair changed but server has old key.
          // Signal the store to clear the identity and retry.
          if (errorMsg.toLowerCase().includes('signature invalid') ||
            errorMsg.toLowerCase().includes('signature mismatch')) {
            this.emit('deviceIdentityStale')
            reject?.(new Error('DEVICE_IDENTITY_STALE'))
            return
          }
          reject?.(new Error(errorMsg))
        }
```

- [ ] **Step 2: Emit authError with v4 details before the final reject**

Insert a new block that extracts `error.details` (v4 contract) and emits an `authError` event before the final `reject?.(new Error(errorMsg))`. The existing `NOT_PAIRED` and signature paths still fire first. Replace the block with:

```typescript
        } else if (!resFrame.ok && !this.authenticated) {
          const errorCode = resFrame.error?.code
          const errorMsg = resFrame.error?.message || 'Handshake failed'
          const details = resFrame.error?.details
          // Retryable startup-sidecars error — server is still booting. The
          // protocol spec asks clients to keep reconnecting within their
          // budget instead of treating this as terminal auth failure.
          if (
            errorCode === 'UNAVAILABLE' &&
            details && typeof details === 'object' && details.reason === 'startup-sidecars'
          ) {
            const retryAfterMs = typeof details.retryAfterMs === 'number' ? details.retryAfterMs : undefined
            this.emit('serverStarting', { retryAfterMs, message: errorMsg })
            // Leave suppressReconnect false so attemptReconnect() runs normally.
            reject?.(new Error('SERVER_STARTING'))
            return
          }
          // Failed connect response — don't reconnect with same bad credentials
          this.suppressReconnect = true
          if (errorCode === 'NOT_PAIRED') {
            this.emit('pairingRequired', {
              requestId: details?.requestId,
              deviceId: this.deviceIdentity?.id
            })
            reject?.(new Error('NOT_PAIRED'))
            return
          }
          // Stale device identity — keypair changed but server has old key.
          // Signal the store to clear the identity and retry.
          if (errorMsg.toLowerCase().includes('signature invalid') ||
            errorMsg.toLowerCase().includes('signature mismatch')) {
            this.emit('deviceIdentityStale')
            reject?.(new Error('DEVICE_IDENTITY_STALE'))
            return
          }
          // v4 auth error details (error.details.{code,reason,canRetryWithDeviceToken,recommendedNextStep})
          if (details && typeof details === 'object') {
            this.emit('authError', {
              code: typeof details.code === 'string' ? details.code : errorCode,
              reason: typeof details.reason === 'string' ? details.reason : undefined,
              canRetryWithDeviceToken: details.canRetryWithDeviceToken === true,
              recommendedNextStep: typeof details.recommendedNextStep === 'string' ? details.recommendedNextStep : undefined,
              message: errorMsg
            })
          }
          reject?.(new Error(errorMsg))
        }
```

Note: the `pairingRequired` block now reads `details?.requestId` instead of `resFrame.error?.details?.requestId` because `details` is captured up front.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/openclaw/client.ts
git commit -m "$(cat <<'EOF'
Emit authError event with v4 error.details

v4 auth failures carry structured recovery hints in error.details:
code, reason, canRetryWithDeviceToken, and recommendedNextStep. The
handshake failure path now emits a new `authError` event with this
shape so the store/UI can show appropriate recovery guidance. The
existing NOT_PAIRED and stale-signature branches still fire first.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add view parameter to listModels

**Files:**
- Modify: `src/lib/openclaw/client.ts:1304-1317` (listModels method)

- [ ] **Step 1: Update listModels signature and request**

In `src/lib/openclaw/client.ts`, replace the existing `listModels()` method at lines 1304-1317 with this version that accepts an optional `view` parameter:

```typescript
  // Models
  async listModels(view?: 'default' | 'configured' | 'all'): Promise<Array<{ id: string; name?: string; provider?: string }>> {
    try {
      const params = view ? { view } : {}
      const result = await this._call<any>('models.list', params)
      const models = result?.models
      if (!Array.isArray(models)) return []
      return models.map((m: any) => ({
        id: m.id || m.name || String(m),
        name: m.name || m.id,
        provider: m.provider || m.providerId || undefined
      }))
    } catch {
      return []
    }
  }
```

The existing single call site (`src/lib/slash-command-executor.ts:100`, `await client.listModels()`) stays on the default behavior because TypeScript allows omitting the optional parameter.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/openclaw/client.ts
git commit -m "$(cat <<'EOF'
Add optional view parameter to models.list

v4 models.list accepts view: 'default' | 'configured' | 'all'. The
default ('default' or omitted) preserves the current server-picked
behavior; callers that want the picker shortlist can pass 'configured'.
v3 servers ignore unknown params so this is safe to pass unconditionally.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Store — add protocolVersion + gatewayServerVersion + recovery hint state

**Files:**
- Modify: `src/store/index.ts` (state interface near line 139, store init near line 644)

- [ ] **Step 1: Find the connection state declarations**

Open `src/store/index.ts` and locate the connection state in the store interface around line 130-141:

```typescript
  // Connection
  serverUrl: string
  setServerUrl: (url: string) => void
  authMode: 'token' | 'password'
  setAuthMode: (mode: 'token' | 'password') => void
  gatewayToken: string
  setGatewayToken: (token: string) => void
  connected: boolean
  connecting: boolean
  connectionError: string | null
  setConnectionError: (error: string | null) => void
  client: OpenClawClient | null
```

- [ ] **Step 2: Add three new state fields to the interface**

Insert after `connectionError: string | null` and its setter:

```typescript
  connectionError: string | null
  setConnectionError: (error: string | null) => void
  /** Negotiated protocol version from hello-ok. Null when not yet connected. */
  protocolVersion: number | null
  /** Gateway server version from hello-ok (e.g. "2026.5.20"). Null when not yet connected. */
  gatewayServerVersion: string | null
  /** Recovery hint from v4 auth errors (e.g. "retry_with_device_token"). Null when no hint. */
  connectionErrorHint: string | null
  client: OpenClawClient | null
```

- [ ] **Step 3: Initialize the new fields in the store init block**

Locate the `connectionError: null,` line at `src/store/index.ts:644` and the surrounding default values block. Add the three defaults immediately after:

```typescript
      connected: false,
      connecting: false,
      connectionError: null,
      setConnectionError: (error) => set({ connectionError: error }),
      protocolVersion: null,
      gatewayServerVersion: null,
      connectionErrorHint: null,
      client: null,
```

- [ ] **Step 4: Also reset these fields when switching profiles**

Locate the `switchProfile` reset block at `src/store/index.ts:584-609` (the `set({ ... })` after switching). Find the line `connectionError: null,` within it and add the three new resets directly below:

```typescript
          connectionError: null,
          protocolVersion: null,
          gatewayServerVersion: null,
          connectionErrorHint: null,
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/index.ts
git commit -m "$(cat <<'EOF'
Add protocol/version/hint fields to store

Three new fields:
- protocolVersion: number from hello-ok (3 or 4)
- gatewayServerVersion: server build version
- connectionErrorHint: v4 auth-error recovery step

All start null and are also reset on profile switch.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Store — populate protocol/version + handle streamReplace + handle authError

**Files:**
- Modify: `src/store/index.ts:2167-2234` (connected handler)
- Modify: `src/store/index.ts:2286-2390` (insert new handlers near streamChunk)

- [ ] **Step 1: Extend the connected handler to capture protocol + version**

Find the `client.on('connected', ...)` handler at `src/store/index.ts:2167`. Inside its body, find the `helloOk` object destructuring around line 2178 where `deviceToken` and `canvasHostUrl` are read. Add protocol and server-version capture there. Change the relevant block to:

```typescript
          client.on('connected', (payload: unknown) => {
            // Cancel any pending disconnect grace timer — we reconnected in time
            if (disconnectGraceTimer) {
              clearTimeout(disconnectGraceTimer)
              disconnectGraceTimer = null
            }

            set({
              connected: true,
              connecting: false,
              connectionError: null,
              connectionErrorHint: null,
              pairingStatus: 'none',
              pairingRequestId: null
            })

            // Parse hello-ok payload for connection-wide fields.
            if (payload && typeof payload === 'object') {
              const helloOk = payload as Record<string, any>

              // Device token (requires a parsed serverHost to persist).
              if (serverHost) {
                const deviceToken = helloOk.auth?.deviceToken
                if (typeof deviceToken === 'string' && deviceToken) {
                  saveDeviceToken(serverHost, deviceToken).catch(() => { })
                }
              }

              // Canvas host URL: prefer the deprecated canvasHostUrl when present
              // (v3), fall back to v4 pluginSurfaceUrls.canvas so v4 servers
              // that dropped the deprecated field still light up the canvas panel.
              const canvasHostUrl =
                (typeof helloOk.canvasHostUrl === 'string' && helloOk.canvasHostUrl) ||
                (helloOk.pluginSurfaceUrls && typeof helloOk.pluginSurfaceUrls.canvas === 'string'
                  ? helloOk.pluginSurfaceUrls.canvas
                  : '')
              if (canvasHostUrl) {
                const canvasScopedUrl = canvasHostUrl.replace(/\/?$/, '') + '/__openclaw__/canvas/'
                set({ canvasHostUrl, canvasScopedUrl })
              }

              // Capture negotiated protocol version (default 3 when absent — v3
              // servers omit this field) + gateway server version. Always run
              // regardless of serverHost so the version display populates even
              // if the URL parse failed earlier.
              const protocol = typeof helloOk.protocol === 'number' ? helloOk.protocol : 3
              const serverVersion =
                (typeof helloOk.runtimeVersion === 'string' && helloOk.runtimeVersion) ||
                (typeof helloOk.version === 'string' && helloOk.version) ||
                (typeof helloOk.server === 'object' && helloOk.server && typeof helloOk.server.version === 'string' ? helloOk.server.version : null) ||
                null
              set({ protocolVersion: protocol, gatewayServerVersion: serverVersion })
            }
```

(Rest of the handler — pending-message flush, session list reload — stays unchanged.)

- [ ] **Step 2: Add a streamReplace handler in the store**

Locate the `client.on('streamChunk', ...)` handler at `src/store/index.ts:2286`. Directly after its closing `})` (around line 2390, right before `client.on('streamEnd', ...)`), insert a new handler:

```typescript
          client.on('streamReplace', (payload: unknown) => {
            const { text, sessionKey } = (payload || {}) as { text?: string; sessionKey?: string }
            if (typeof text !== 'string') return

            const { currentSessionId, streamingDisabled } = get()
            const resolvedKey = sessionKey || currentSessionId
            if (resolvedKey) clearResponseWatchdog(resolvedKey)
            const isCurrentSession = !sessionKey || !currentSessionId || sessionKey === currentSessionId

            if (!isCurrentSession) {
              if (resolvedKey) {
                set((state) => ({
                  streamingSessions: { ...state.streamingSessions, [resolvedKey]: true },
                  sessionHadChunks: { ...state.sessionHadChunks, [resolvedKey]: true },
                }))
              }
              return
            }

            if (streamingDisabled) {
              if (resolvedKey) {
                set((state) => ({
                  streamingSessions: { ...state.streamingSessions, [resolvedKey]: true },
                }))
              }
              return
            }

            set((state) => {
              const perSession = resolvedKey ? {
                streamingSessions: { ...state.streamingSessions, [resolvedKey]: true },
                sessionHadChunks: { ...state.sessionHadChunks, [resolvedKey]: true },
              } : {}

              const messages = [...state.messages]
              const lastMessage = messages[messages.length - 1]
              const { text: cleanText } = stripBase64FromStreaming(text)

              if (lastMessage && lastMessage.role === 'assistant' && lastMessage.id.startsWith('streaming-')) {
                // Replace the current streaming placeholder content authoritatively.
                messages[messages.length - 1] = { ...lastMessage, content: cleanText }
                return { messages, ...perSession }
              }

              // Ghost-bubble guard: if the last message is a finalized assistant
              // message that already contains (or starts with) the incoming
              // replacement, this is a late-arriving event from a secondary
              // event source. Suppress it to avoid creating an extra bubble.
              if (lastMessage && lastMessage.role === 'assistant' && !lastMessage.id.startsWith('streaming-')) {
                const existing = lastMessage.content.trim()
                const incoming = cleanText.trim()
                if (existing && incoming && (existing.includes(incoming) || incoming.startsWith(existing.slice(0, 80)))) {
                  return { ...perSession }
                }
              }

              // No active placeholder — create one with the replacement text.
              const newMessage: Message = {
                id: `streaming-${Date.now()}`,
                role: 'assistant',
                content: cleanText,
                timestamp: new Date().toISOString()
              }
              return { messages: [...messages, newMessage], ...perSession }
            })
          })
```

- [ ] **Step 3: Add an authError handler**

Directly after the `client.on('streamReplace', ...)` block you just inserted, add an authError handler:

```typescript
          client.on('authError', (payload: unknown) => {
            const p = (payload || {}) as {
              code?: string
              reason?: string
              canRetryWithDeviceToken?: boolean
              recommendedNextStep?: string
              message?: string
            }
            const hintMap: Record<string, string> = {
              retry_with_device_token: 'Try reconnecting — the cached device token may resolve this.',
              update_auth_configuration: 'Check the auth configuration on the OpenClaw server.',
              update_auth_credentials: 'Update the gateway token or password in Settings.',
              wait_then_retry: 'The server is still starting. Retry in a few seconds.',
              review_auth_configuration: 'Review the OpenClaw auth configuration; the requested scope is not granted.',
            }
            const hint = p.recommendedNextStep ? (hintMap[p.recommendedNextStep] || p.recommendedNextStep) : null
            set({
              connectionError: p.message || 'Authentication failed',
              connectionErrorHint: hint,
            })
          })
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/index.ts
git commit -m "$(cat <<'EOF'
Wire v4 protocol/version + streamReplace + authError handlers

The connected handler now captures protocol + gatewayServerVersion from
hello-ok (server.version fallback included). A new streamReplace listener
overwrites the streaming placeholder content authoritatively when v4 sends
replace=true. A new authError listener maps v4 recommendedNextStep codes
to human-readable hints stored in connectionErrorHint for the UI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: SettingsModal — display protocol version + server build

**Files:**
- Modify: `src/components/SettingsModal.tsx:10-44` (destructure new store fields)
- Modify: `src/components/SettingsModal.tsx:714-728` (add display row inside the connected block)

- [ ] **Step 1: Pull the new fields from the store**

In `src/components/SettingsModal.tsx`, find the `useStore()` destructure at lines 10-44. Add `protocolVersion` and `gatewayServerVersion` to the destructured list. Replace the destructure block with:

```typescript
  const {
    serverUrl,
    setServerUrl,
    authMode,
    setAuthMode,
    gatewayToken,
    setGatewayToken,
    showSettings,
    setShowSettings,
    connect,
    disconnect,
    connected,
    connecting,
    notificationsEnabled,
    setNotificationsEnabled,
    streamingDisabled,
    setStreamingDisabled,
    nodeEnabled,
    setNodeEnabled,
    openServerSettings,
    theme,
    toggleTheme,
    pairingStatus,
    pairingRequestId,
    retryConnect,
    connectionError,
    deviceName,
    setDeviceName,
    serverProfiles,
    activeProfileId,
    addServerProfile,
    updateServerProfile,
    deleteServerProfile,
    switchProfile,
    protocolVersion,
    gatewayServerVersion
  } = useStore()
```

- [ ] **Step 2: Render the protocol/version row above the Server Settings button**

Locate the connected-only block at `src/components/SettingsModal.tsx:714-728`:

```typescript
          {connected && (
            <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
              <button
                className="btn btn-secondary server-settings-link"
                onClick={() => { setShowSettings(false); openServerSettings() }}
              >
                ...
                OpenClaw Server Settings
              </button>
              <span className="form-hint">Configure agent defaults, tools, memory, and channels</span>
            </div>
          )}
```

Replace it with the version that adds a connection-info row directly above the existing button:

```typescript
          {connected && (
            <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
              <div className="form-hint" style={{ marginBottom: '12px' }}>
                Connected to {gatewayServerVersion ? <>OpenClaw v{gatewayServerVersion}</> : 'OpenClaw'}
                {typeof protocolVersion === 'number' && <> (protocol v{protocolVersion})</>}
              </div>
              <button
                className="btn btn-secondary server-settings-link"
                onClick={() => { setShowSettings(false); openServerSettings() }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" style={{ marginRight: '8px' }}>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                OpenClaw Server Settings
              </button>
              <span className="form-hint">Configure agent defaults, tools, memory, and channels</span>
            </div>
          )}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no new errors.

- [ ] **Step 4: Lint**

```bash
npm run lint
```

Expected: no new lint errors. Pre-existing warnings (if any) unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "$(cat <<'EOF'
Show negotiated OpenClaw protocol version in Settings

When connected, the Settings modal now displays the gateway server
version and the negotiated WS protocol (v3 or v4) above the existing
Server Settings link, so users can tell at a glance which protocol the
client and server agreed on.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: SettingsModal — show auth recovery hint next to connectionError

**Files:**
- Modify: `src/components/SettingsModal.tsx:10-44` (already destructures `connectionError` from Task 7; add `connectionErrorHint`)
- Modify: `src/components/SettingsModal.tsx:523-524` (the `connectionError` display row)

The CertErrorModal only opens on the `certError` event; auth failures surface via `connectionError`, which is rendered inline in the SettingsModal connection section. The recovery hint belongs there.

- [ ] **Step 1: Add connectionErrorHint to the SettingsModal destructure**

In `src/components/SettingsModal.tsx`, locate the `useStore()` destructure (already updated in Task 7 to include `protocolVersion` and `gatewayServerVersion`). Add `connectionErrorHint` to that list. The trailing portion of the destructure should read:

```typescript
    protocolVersion,
    gatewayServerVersion,
    connectionErrorHint
  } = useStore()
```

- [ ] **Step 2: Render the hint directly under the connectionError row**

Find the existing `connectionError` display at `src/components/SettingsModal.tsx:523-524`:

```typescript
              {!error && !connected && connectionError && (
                <div className="form-error">{connectionError}{connectionError.toLowerCase().includes('origin not allowed') && originHelpBlock}</div>
              )}
```

Replace it with the version that renders the hint immediately after the error message:

```typescript
              {!error && !connected && connectionError && (
                <>
                  <div className="form-error">{connectionError}{connectionError.toLowerCase().includes('origin not allowed') && originHelpBlock}</div>
                  {connectionErrorHint && (
                    <div className="form-hint" style={{ marginTop: '4px' }}>{connectionErrorHint}</div>
                  )}
                </>
              )}
```

- [ ] **Step 3: Typecheck + lint**

```bash
npm run typecheck && npm run lint
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "$(cat <<'EOF'
Surface v4 auth-error recovery hint in SettingsModal

When the store carries a connectionErrorHint (mapped from a v4
recommendedNextStep), render it directly under the existing
connectionError row in the SettingsModal connection section, so users
see the recommended next action alongside the failure message. The
CertErrorModal is unchanged — it only opens for TLS/cert failures.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Full build verification + manual smoke checklist

**Files:** none

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: clean. If errors appear that reference any of the new fields (`protocolVersion`, `gatewayServerVersion`, `connectionErrorHint`, `streamReplace`, `authError`), fix the offending file before continuing.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: no new errors. Warnings are tolerated only if they already existed before this plan started.

- [ ] **Step 3: Run the test suite**

```bash
npm run test:run
```

Expected: same pass/fail count as before the plan started. No regressions.

- [ ] **Step 4: Run the production build**

```bash
npm run build
```

Expected: successful Electron + Vite build with no new warnings about the touched files.

- [ ] **Step 5: Manual smoke test against a v2026.5.x server**

Bring up a v2026.5.x OpenClaw gateway (`openclaw gateway --port 18789`). Then:

```bash
npm run dev
```

In the running ClawControl:
1. Connect to the v2026.5.x server.
2. Open Settings → verify the modal shows `Connected to OpenClaw v2026.5.x (protocol v4)`.
3. Send a chat message that produces a multi-token streaming response.
   - **Expected:** Text appears smoothly with no duplication. (`deltaText` path active.)
4. If the server returns a `replace=true` chat delta (rare; can be forced via a server-side test fixture if one exists), the streaming placeholder content swaps cleanly.

- [ ] **Step 6: Manual smoke test against a v3 server**

Bring up a v3 (e.g. v2026.3.x) gateway and reconnect ClawControl to it.
1. Settings shows `Connected to OpenClaw v2026.3.x (protocol v3)`.
2. Streaming chat still works exactly as before. (`payload.delta` path active.)

- [ ] **Step 7: Manual smoke test for auth error hint**

Disconnect, set an invalid gateway token, and reconnect from the Settings modal.
1. The Settings modal stays open and the connection-section error row shows the auth failure message.
2. If the server returned `error.details.recommendedNextStep`, a hint row appears directly under the error (e.g., "Update the gateway token or password in Settings.").
3. With a v3 server (no `error.details`), the error renders as before with no extra hint row.
4. With a v4 server still booting (returns `UNAVAILABLE` + `details.reason: "startup-sidecars"`), ClawControl keeps reconnecting instead of treating it as terminal. The connection error briefly shows but resolves once the server is ready.

- [ ] **Step 8: Final commit if any cleanup edits were needed during smoke testing**

If smoke testing exposed an issue and you made a fix, commit it. Otherwise no commit is needed here.

```bash
git status
# If clean: nothing to do.
# If dirty: review changes, then:
# git add <file>
# git commit -m "fix: <smoke-test fix>"
```

---

## Self-Review

**Spec coverage:**
- ✅ Goal 1: Negotiate v4 → Task 1
- ✅ Goal 2: Preserve v3 fallback → Task 1 (minProtocol stays 3) + Task 2 (v3 branch retained) + Task 6 (protocolVersion defaults to 3 when hello-ok omits it)
- ✅ Goal 3: Handle v4 chat deltaText/replace → Task 2 (client routes deltas through mergeIncoming('delta')) + Task 6 (store streamReplace with finalized-message guard)
- ✅ Goal 4: Surface v4 auth-error details → Task 3 (client emits authError, also handles retryable UNAVAILABLE+startup-sidecars) + Task 6 (store authError handler) + Task 8 (SettingsModal hint next to connectionError, NOT CertErrorModal)
- ✅ Goal 5: Capture pluginSurfaceUrls → Task 1 (capture) + Task 6 (canvas fallback to pluginSurfaceUrls.canvas so v4-only servers still light up the canvas panel)
- ✅ Goal 6: models.list view → Task 4
- ✅ Goal 7: Display negotiated protocol version → Task 5 (store) + Task 7 (UI)

**Placeholder scan:** No "TBD", "TODO", or "fill in details" patterns. Every code step has the actual code.

**Type consistency:**
- `negotiatedProtocol: number = 3` (client) / `protocolVersion: number | null` (store) — distinct names by design; store can be null pre-connect, client always has a value.
- `streamReplace` event payload: `{ text: string; sessionKey: string }` — emitted by client (Task 2), consumed by store (Task 6). Matches.
- `authError` event payload: `{ code, reason, canRetryWithDeviceToken, recommendedNextStep, message }` — emitted in Task 3, consumed in Task 6. Matches.
- `gatewayServerVersion` store field — pulled from `helloOk.runtimeVersion || helloOk.version || helloOk.server?.version` in Task 6. The fallback chain matches what the client already does at `client.ts:552`.
- `connectionErrorHint` — read in Task 8, written in Task 6. Matches.
