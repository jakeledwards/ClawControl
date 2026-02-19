import { contextBridge, ipcRenderer } from 'electron'

type FetchOptions = { method?: string; headers?: Record<string, string>; body?: string }

interface FetchRule {
  host: string
  allowsPath: (pathname: string) => boolean
  methods: Set<string>
  allowBody: boolean
  allowedHeaders: Set<string>
}

const MAX_FETCH_BODY_BYTES = 128 * 1024

const FETCH_RULES: FetchRule[] = [
  {
    host: 'clawhub.ai',
    allowsPath: (pathname) => pathname.startsWith('/api/v1/'),
    methods: new Set(['GET']),
    allowBody: false,
    allowedHeaders: new Set(['accept']),
  },
  {
    host: 'wry-manatee-359.convex.cloud',
    allowsPath: (pathname) => pathname === '/api/query' || pathname === '/api/action',
    methods: new Set(['POST']),
    allowBody: true,
    allowedHeaders: new Set(['content-type', 'convex-client', 'accept']),
  },
]

function resolveFetchRule(parsed: URL): FetchRule | null {
  return FETCH_RULES.find((rule) => rule.host === parsed.hostname && rule.allowsPath(parsed.pathname)) || null
}

function sanitizeFetchHeaders(headers: FetchOptions['headers'], allowed: Set<string>): Record<string, string> | undefined {
  if (!headers) return undefined
  const sanitized: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (typeof rawKey !== 'string' || typeof rawValue !== 'string') {
      throw new Error('Invalid headers')
    }
    const key = rawKey.trim().toLowerCase()
    if (!key || !allowed.has(key)) {
      throw new Error(`Header not allowed: ${rawKey}`)
    }
    if (rawValue.length > 8192) {
      throw new Error('Header value too long')
    }
    sanitized[key] = rawValue
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function sanitizeFetchBody(body: unknown, allowBody: boolean, method: string): string | undefined {
  if (body === undefined) return undefined
  if (typeof body !== 'string') throw new Error('Invalid request body')
  if (!allowBody || method !== 'POST') throw new Error('Request body is not allowed')
  if (Buffer.byteLength(body, 'utf8') > MAX_FETCH_BODY_BYTES) {
    throw new Error('Request body too large')
  }
  return body
}

function normalizeFetchRequest(url: string, options?: FetchOptions): { url: string; options: FetchOptions } {
  if (typeof url !== 'string') throw new Error('Invalid URL')
  if (url.length > 2048) throw new Error('URL too long')

  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed')
  if (parsed.username || parsed.password) throw new Error('Credentials in URL are not allowed')
  if (parsed.port && parsed.port !== '443') throw new Error('Custom ports are not allowed')

  const rule = resolveFetchRule(parsed)
  if (!rule) throw new Error('URL is not allowed')

  const method = (options?.method || 'GET').toUpperCase()
  if (!rule.methods.has(method)) {
    throw new Error(`Method not allowed: ${method}`)
  }

  const headers = sanitizeFetchHeaders(options?.headers, rule.allowedHeaders)
  const body = sanitizeFetchBody(options?.body, rule.allowBody, method)

  return {
    url: parsed.toString(),
    options: { method, headers, body },
  }
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  connect: (url: string) => ipcRenderer.invoke('openclaw:connect', url),
  getConfig: () => ipcRenderer.invoke('openclaw:getConfig'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  trustHost: (hostname: string) => ipcRenderer.invoke('cert:trustHost', hostname),
  saveToken: (token: string) => ipcRenderer.invoke('auth:saveToken', token),
  getToken: () => ipcRenderer.invoke('auth:getToken'),
  isEncryptionAvailable: () => ipcRenderer.invoke('auth:isEncryptionAvailable'),
  showNotification: (title: string, body: string) => ipcRenderer.invoke('notification:show', title, body),
  openSubagentPopout: (params: { sessionKey: string; serverUrl: string; authToken: string; authMode: string; label: string }) =>
    ipcRenderer.invoke('subagent:openPopout', params),
  openToolCallPopout: (params: { toolCallId: string; name: string }) =>
    ipcRenderer.invoke('toolcall:openPopout', params),
  fetchUrl: (url: string, options?: FetchOptions) => {
    const normalized = normalizeFetchRequest(url, options)
    return ipcRenderer.invoke('net:fetchUrl', normalized.url, normalized.options)
  },
  generateEd25519KeyPair: () => ipcRenderer.invoke('crypto:generateEd25519'),
  signEd25519: (privateKeyJwk: JsonWebKey, payload: string) => ipcRenderer.invoke('crypto:signEd25519', privateKeyJwk, payload),
  platform: process.platform
})

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI: {
      connect: (url: string) => Promise<{ success: boolean; url: string }>
      getConfig: () => Promise<{ defaultUrl: string; theme: string }>
      openExternal: (url: string) => Promise<void>
      trustHost: (hostname: string) => Promise<{ trusted: boolean; hostname: string }>
      saveToken: (token: string) => Promise<{ saved: boolean }>
      getToken: () => Promise<string>
      isEncryptionAvailable: () => Promise<boolean>
      showNotification: (title: string, body: string) => Promise<void>
      openSubagentPopout: (params: { sessionKey: string; serverUrl: string; authToken: string; authMode: string; label: string }) => Promise<void>
      openToolCallPopout: (params: { toolCallId: string; name: string }) => Promise<void>
      fetchUrl: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<string>
      generateEd25519KeyPair: () => Promise<{ id: string; publicKeyBase64url: string; privateKeyJwk: JsonWebKey }>
      signEd25519: (privateKeyJwk: JsonWebKey, payload: string) => Promise<string>
      platform: NodeJS.Platform
    }
  }
}
