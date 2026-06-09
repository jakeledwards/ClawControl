// NodeClient — lightweight WebSocket client for the "node" role.
// Opens a parallel connection to the OpenClaw server so the AI agent can
// invoke commands on this device (clipboard, notifications, device info).

import type { DeviceIdentity, DeviceConnectField } from '../device-identity'
import { signChallenge } from '../device-identity'
import { APP_NAME, APP_VERSION, OPENCLAW_CLIENT_ID, OPENCLAW_CLIENT_MODE, OPENCLAW_NODE_ROLE } from '../appMeta'
import { getPlatform } from '../platform'
import type { InvokeRequest } from './types'
import { dispatch } from './invoke-dispatcher'
import { getCapNames, getCommands, getPermissions } from './capability-registry'

type EventHandler = (...args: unknown[]) => void

export class NodeClient {
  private ws: WebSocket | null = null
  private wsFactory: ((url: string) => any) | null
  private url: string
  private token: string
  private authMode: 'token' | 'password'
  private deviceIdentity: DeviceIdentity | null
  private deviceName: string | null
  private permissions: Record<string, boolean>
  private requestId = 0
  private authenticated = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 20
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private eventHandlers = new Map<string, Set<EventHandler>>()
  private disposed = false

  constructor(
    url: string,
    token: string,
    authMode: 'token' | 'password',
    wsFactory?: ((url: string) => any) | null,
    deviceIdentity?: DeviceIdentity | null,
    deviceName?: string,
    permissions?: Record<string, boolean>
  ) {
    this.url = url
    this.token = token
    this.authMode = authMode
    this.wsFactory = wsFactory || null
    this.deviceIdentity = deviceIdentity || null
    this.deviceName = deviceName || null
    this.permissions = permissions || {}
  }

  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler)
  }

  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler)
  }

  private emit(event: string, ...args: unknown[]): void {
    this.eventHandlers.get(event)?.forEach(handler => {
      try { handler(...args) } catch { /* ignore */ }
    })
  }

  connect(): Promise<void> {
    this.reconnectAttempts = 0
    this.disposed = false
    return this.doConnect()
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error('Disposed')); return }

      let settled = false
      const settle = (fn: typeof resolve | typeof reject, value?: any) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        fn(value)
      }

      const timeout = setTimeout(() => {
        settle(reject, new Error('Node connection timed out'))
        this.ws?.close()
      }, 15_000)

      try {
        this.ws = this.wsFactory ? this.wsFactory(this.url) : new WebSocket(this.url)

        this.ws!.onopen = () => {
          this.reconnectAttempts = 0
        }

        this.ws!.onerror = () => {
          settle(reject, new Error('Node WebSocket error'))
        }

        this.ws!.onclose = () => {
          this.authenticated = false
          this.emit('disconnected')
          settle(reject, new Error('Node WebSocket closed'))
          this.attemptReconnect()
        }

        this.ws!.onmessage = (event: MessageEvent) => {
          const data = typeof event.data === 'string' ? event.data : null
          if (!data) return
          this.handleMessage(data, () => settle(resolve), (err) => settle(reject, err))
        }
      } catch (err) {
        settle(reject, err)
      }
    })
  }

  disconnect(): void {
    this.disposed = true
    this.maxReconnectAttempts = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
    }
    this.ws = null
    this.authenticated = false
  }

  private attemptReconnect(): void {
    if (this.disposed || this.reconnectAttempts >= this.maxReconnectAttempts) return
    this.reconnectAttempts++
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
    const jitter = base * 0.25 * (Math.random() * 2 - 1)
    const delay = Math.round(base + jitter)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect().catch(() => { })
    }, delay)
  }

  private async performHandshake(nonce?: string): Promise<void> {
    const id = (++this.requestId).toString()
    const scopes: string[] = []

    let device: DeviceConnectField | undefined
    if (this.deviceIdentity && nonce) {
      try {
        device = await signChallenge(this.deviceIdentity, nonce, this.token, scopes, {
          clientId: OPENCLAW_CLIENT_ID,
          clientMode: OPENCLAW_CLIENT_MODE,
          role: OPENCLAW_NODE_ROLE
        })
      } catch {
        // signing failed — connect without device identity
      }
    }

    const connectMsg = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 4,
        role: OPENCLAW_NODE_ROLE,
        scopes,
        client: {
          id: OPENCLAW_CLIENT_ID,
          displayName: this.deviceName || APP_NAME,
          version: APP_VERSION,
          platform: getPlatform(),
          mode: OPENCLAW_CLIENT_MODE
        },
        caps: getCapNames(this.permissions),
        commands: getCommands(this.permissions),
        permissions: getPermissions(this.permissions),
        auth: this.token
          ? (this.authMode === 'password' ? { password: this.token } : { token: this.token })
          : undefined,
        device
      }
    }

    this.ws?.send(JSON.stringify(connectMsg))
  }

  private handleMessage(data: string, resolve?: () => void, reject?: (err: Error) => void): void {
    try {
      const msg = JSON.parse(data)

      // Handle connect.challenge event
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        this.performHandshake(msg.payload?.nonce).catch(err => reject?.(err))
        return
      }

      // Handle node.invoke.request event
      if (msg.type === 'event' && msg.event === 'node.invoke.request') {
        this.handleInvoke(msg.payload)
        return
      }

      // Handle responses to our outgoing req frames (invoke results, etc.)
      // Handle hello-ok response
      if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        this.authenticated = true
        this.emit('connected', msg.payload)
        resolve?.()
        // Drain any pending work queued while this node was disconnected (v2026.3.11)
        this.drainPendingWork()
        return
      }

      // Handle failed auth
      if (msg.type === 'res' && !msg.ok && !this.authenticated) {
        const errorCode = msg.error?.code
        const errorMsg = msg.error?.message || 'Node handshake failed'
        const details = msg.error?.details
        const detailCode = typeof details?.code === 'string' ? details.code : undefined
        const detailReason = typeof details?.reason === 'string' ? details.reason : undefined

        // v3 NOT_PAIRED + v4 structured codes that all map to "user must pair".
        if (
          errorCode === 'NOT_PAIRED' ||
          detailCode === 'PAIRING_REQUIRED' ||
          detailCode === 'DEVICE_IDENTITY_REQUIRED' ||
          detailCode === 'CONTROL_UI_DEVICE_IDENTITY_REQUIRED'
        ) {
          // Suppress reconnect — pairing must happen first
          this.maxReconnectAttempts = 0
          this.emit('pairingRequired', {
            requestId: details?.requestId,
            deviceId: this.deviceIdentity?.id,
            reason: detailReason
          })
          reject?.(new Error('NOT_PAIRED'))
          return
        }

        reject?.(new Error(errorMsg))
        return
      }
    } catch {
      // parse error
    }
  }

  private sendInvokeResult(invokeId: string, raw: Record<string, unknown>, result: import('./types').InvokeResult): void {
    const reqId = (++this.requestId).toString()
    const params: Record<string, unknown> = {
      id: invokeId,
      nodeId: raw.nodeId,
      ok: result.ok,
    }
    if (result.ok) {
      if (result.payload !== undefined) params.payload = result.payload
    } else {
      if (result.error) params.error = result.error
    }
    const reqFrame = {
      type: 'req',
      id: reqId,
      method: 'node.invoke.result',
      params
    }
    try {
      this.ws?.send(JSON.stringify(reqFrame))
    } catch {
      // socket dead
    }
  }

  private async handleInvoke(payload: unknown): Promise<void> {
    const req = payload as InvokeRequest
    if (!req?.command) return

    const invokeId = req.id || ''
    const raw = payload as Record<string, unknown>
    // Defense-in-depth: reject commands not in the user's permissions
    if (!this.permissions[req.command]) {
      this.sendInvokeResult(invokeId, raw, {
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: `Command "${req.command}" is not permitted` }
      })
      return
    }

    const result = await dispatch({ ...req, id: invokeId })
    this.sendInvokeResult(invokeId, raw, result)
    this.emit('invoke', { command: req.command, result })
  }

  isConnected(): boolean {
    return this.authenticated && !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Drain pending work queued by the server while this node was disconnected (v2026.3.11).
   * Calls node.pending.pull to fetch any queued invoke requests and processes them.
   */
  private async drainPendingWork(): Promise<void> {
    if (!this.ws || !this.authenticated) return
    try {
      const reqId = (++this.requestId).toString()
      const pullFrame = { type: 'req', id: reqId, method: 'node.pending.pull', params: {} }
      this.ws.send(JSON.stringify(pullFrame))
      // Response handling is done via the normal message handler —
      // the server will send invoke requests as events in response.
    } catch {
      // Best-effort — pending work drain is non-critical
    }
  }
}
