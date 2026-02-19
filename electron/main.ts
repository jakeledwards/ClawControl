import { app, BrowserWindow, ipcMain, shell, Menu, safeStorage, Notification } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import crypto from 'crypto'

let mainWindow: BrowserWindow | null = null
const trustedHosts = new Set<string>()

type NetFetchOptions = { method?: string; headers?: Record<string, string>; body?: string }

interface NetFetchRule {
  host: string
  allowsPath: (pathname: string) => boolean
  methods: Set<string>
  allowBody: boolean
  allowedHeaders: Set<string>
}

const MAX_FETCH_BODY_BYTES = 128 * 1024
const MAX_FETCH_RESPONSE_BYTES = 2 * 1024 * 1024

const NET_FETCH_RULES: NetFetchRule[] = [
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

function resolveNetFetchRule(parsed: URL): NetFetchRule | null {
  return NET_FETCH_RULES.find((rule) => rule.host === parsed.hostname && rule.allowsPath(parsed.pathname)) || null
}

function sanitizeNetFetchHeaders(headers: NetFetchOptions['headers'], allowed: Set<string>): Record<string, string> | undefined {
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

function sanitizeNetFetchBody(body: unknown, allowBody: boolean, method: string): string | undefined {
  if (body === undefined) return undefined
  if (typeof body !== 'string') throw new Error('Invalid request body')
  if (!allowBody || method !== 'POST') throw new Error('Request body is not allowed')
  if (Buffer.byteLength(body, 'utf8') > MAX_FETCH_BODY_BYTES) {
    throw new Error('Request body too large')
  }
  return body
}

function normalizeNetFetchRequest(url: string, options?: NetFetchOptions): { url: string; options: NetFetchOptions } {
  if (typeof url !== 'string') throw new Error('Invalid URL')
  if (url.length > 2048) throw new Error('URL too long')

  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed')
  if (parsed.username || parsed.password) throw new Error('Credentials in URL are not allowed')
  if (parsed.port && parsed.port !== '443') throw new Error('Custom ports are not allowed')

  const rule = resolveNetFetchRule(parsed)
  if (!rule) throw new Error('URL is not allowed')

  const method = (options?.method || 'GET').toUpperCase()
  if (!rule.methods.has(method)) {
    throw new Error(`Method not allowed: ${method}`)
  }

  const headers = sanitizeNetFetchHeaders(options?.headers, rule.allowedHeaders)
  const body = sanitizeNetFetchBody(options?.body, rule.allowBody, method)

  return {
    url: parsed.toString(),
    options: { method, headers, body },
  }
}

// Path to persist trusted hosts
function getTrustedHostsPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'trusted-hosts.json')
}

// Load trusted hosts from disk
function loadTrustedHosts(): void {
  try {
    const filePath = getTrustedHostsPath()
    if (existsSync(filePath)) {
      const data = readFileSync(filePath, 'utf-8')
      const hosts: string[] = JSON.parse(data)
      hosts.forEach(host => trustedHosts.add(host))
    }
  } catch {
    // Ignore errors loading trusted hosts
  }
}

// Save trusted hosts to disk
function saveTrustedHosts(): void {
  try {
    const filePath = getTrustedHostsPath()
    const dir = join(filePath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const hosts = Array.from(trustedHosts)
    writeFileSync(filePath, JSON.stringify(hosts, null, 2))
  } catch {
    // Ignore errors saving trusted hosts
  }
}

function createWindow() {
  // Remove the default menu bar (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    },
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? true : true,
    backgroundColor: '#0d1117'
  })

  // Allow DevTools shortcuts only in development
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        mainWindow?.webContents.toggleDevTools()
      }
    })
  }

  // Enable context menu for copy/paste
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    ])
    menu.popup()
  })

  // Open external links in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the dev server or the app itself
    const appOrigin = process.env.VITE_DEV_SERVER_URL
      ? new URL(process.env.VITE_DEV_SERVER_URL).origin
      : 'file://'
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
      if (url.startsWith('http:') || url.startsWith('https:')) {
        shell.openExternal(url)
      }
    }
  })

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}


// Handle certificate errors - trust hosts that user has explicitly accepted
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  try {
    const parsedUrl = new URL(url)
    if (trustedHosts.has(parsedUrl.hostname)) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    // Ignore URL parsing errors
  }
  callback(false)
})

app.whenReady().then(() => {
  // Set app identity for Windows notifications (otherwise shows "electron.app.Electron")
  if (process.platform === 'win32') {
    app.setAppUserModelId('ClawControl')
  }
  loadTrustedHosts()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Notification handler
ipcMain.handle('notification:show', (_event, title: string, body: string) => {
  new Notification({ title, body }).show()
})

// IPC handlers for OpenClaw communication
ipcMain.handle('openclaw:connect', async (_event, url: string) => {
  // Connection will be handled in renderer process via WebSocket
  return { success: true, url }
})

ipcMain.handle('openclaw:getConfig', async () => {
  return {
    defaultUrl: '',
    theme: 'dark'
  }
})

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  // Validate URL to only allow http/https protocols
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Invalid protocol')
    }
    await shell.openExternal(url)
  } catch {
    throw new Error('Invalid URL')
  }
})

// --- Secure token storage ---

function getTokenPath(): string {
  return join(app.getPath('userData'), 'auth-token.enc')
}

function saveToken(token: string): void {
  const filePath = getTokenPath()
  if (!token) {
    // Delete the file when token is cleared
    try { unlinkSync(filePath) } catch { /* file may not exist */ }
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token)
    writeFileSync(filePath, encrypted)
  } else {
    // Fallback: base64 (better than plaintext in localStorage)
    writeFileSync(filePath, Buffer.from(token, 'utf-8').toString('base64'), 'utf-8')
  }
}

function loadToken(): string {
  const filePath = getTokenPath()
  if (!existsSync(filePath)) return ''
  try {
    const raw = readFileSync(filePath)
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(raw)
    }
    // Fallback: base64
    return Buffer.from(raw.toString('utf-8'), 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

ipcMain.handle('auth:saveToken', async (_event, token: string) => {
  if (typeof token !== 'string') throw new Error('Invalid token')
  saveToken(token)
  return { saved: true }
})

ipcMain.handle('auth:getToken', async () => {
  return loadToken()
})

ipcMain.handle('auth:isEncryptionAvailable', async () => {
  return safeStorage.isEncryptionAvailable()
})

// Open a subagent popout window
ipcMain.handle('subagent:openPopout', async (_event, params: {
  sessionKey: string
  serverUrl: string
  authToken: string
  authMode: string
  label: string
}) => {
  const hash = `#subagent?sessionKey=${encodeURIComponent(params.sessionKey)}&serverUrl=${encodeURIComponent(params.serverUrl)}&authToken=${encodeURIComponent(params.authToken)}&authMode=${encodeURIComponent(params.authMode)}`

  const popout = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 500,
    minHeight: 400,
    title: `Subagent: ${params.label}`,
    icon: join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    },
    backgroundColor: '#0d1117'
  })

  // Remove menu bar from popout
  popout.setMenuBarVisibility(false)

  // Open external links in the user's default browser
  popout.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  popout.webContents.on('will-navigate', (event, url) => {
    const appOrigin = process.env.VITE_DEV_SERVER_URL
      ? new URL(process.env.VITE_DEV_SERVER_URL).origin
      : 'file://'
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
      if (url.startsWith('http:') || url.startsWith('https:')) {
        shell.openExternal(url)
      }
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    popout.loadURL(`${process.env.VITE_DEV_SERVER_URL}${hash}`)
  } else {
    popout.loadFile(join(__dirname, '../dist/index.html'), { hash: hash.slice(1) })
  }
})

// Open a tool call popout window
ipcMain.handle('toolcall:openPopout', async (_event, params: {
  toolCallId: string
  name: string
}) => {
  const hash = `#toolcall?id=${encodeURIComponent(params.toolCallId)}`

  const popout = new BrowserWindow({
    width: 700,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    title: `Tool: ${params.name}`,
    icon: join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    },
    backgroundColor: '#0d1117'
  })

  popout.setMenuBarVisibility(false)

  popout.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    popout.loadURL(`${process.env.VITE_DEV_SERVER_URL}${hash}`)
  } else {
    popout.loadFile(join(__dirname, '../dist/index.html'), { hash: hash.slice(1) })
  }
})

// Proxy fetch for CORS-restricted URLs (limited to known ClawHub/Convex endpoints).
ipcMain.handle('net:fetchUrl', async (_event, url: string, options?: NetFetchOptions) => {
  const normalized = normalizeNetFetchRequest(url, options)
  const { net } = await import('electron')

  return new Promise<string>((resolve, reject) => {
    const request = net.request({
      url: normalized.url,
      method: normalized.options.method || 'GET',
    })

    if (normalized.options.headers) {
      for (const [key, value] of Object.entries(normalized.options.headers)) {
        request.setHeader(key, value)
      }
    }

    let responseText = ''
    let responseSize = 0
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        const text = chunk.toString()
        responseSize += Buffer.byteLength(text, 'utf8')
        if (responseSize > MAX_FETCH_RESPONSE_BYTES) {
          request.destroy(new Error('Response too large'))
          return
        }
        responseText += text
      })
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(responseText)
        } else {
          reject(new Error(`HTTP ${response.statusCode}`))
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)

    if (normalized.options.body) {
      request.write(normalized.options.body)
    }
    request.end()
  })
})

// --- Ed25519 crypto (Node.js, since Chromium Web Crypto lacks Ed25519) ---

ipcMain.handle('crypto:generateEd25519', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')

  // Export raw 32-byte public key
  const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' })
  // SPKI wrapping for Ed25519 adds a 12-byte header; raw key is the last 32 bytes
  const rawBytes = publicKeyRaw.subarray(publicKeyRaw.length - 32)
  const publicKeyBase64url = rawBytes.toString('base64url')

  // Device ID = SHA-256(raw public key) as hex
  const id = crypto.createHash('sha256').update(rawBytes).digest('hex')

  // Export private key as JWK for storage
  const privateKeyJwk = privateKey.export({ format: 'jwk' })

  return { id, publicKeyBase64url, privateKeyJwk }
})

ipcMain.handle('crypto:signEd25519', async (_event, privateKeyJwk: JsonWebKey, payload: string) => {
  const privateKey = crypto.createPrivateKey({ key: privateKeyJwk as crypto.JsonWebKey, format: 'jwk' })
  const signature = crypto.sign(null, Buffer.from(payload), privateKey)
  return signature.toString('base64url')
})

// Trust a hostname for certificate errors (persisted across app restarts)
ipcMain.handle('cert:trustHost', async (_event, hostname: string) => {
  // Validate hostname format
  if (!hostname || typeof hostname !== 'string' || hostname.length > 253) {
    throw new Error('Invalid hostname')
  }
  // Basic hostname validation (alphanumeric, dots, hyphens)
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/
  if (!hostnameRegex.test(hostname)) {
    throw new Error('Invalid hostname format')
  }
  trustedHosts.add(hostname)
  saveTrustedHosts()
  return { trusted: true, hostname }
})
