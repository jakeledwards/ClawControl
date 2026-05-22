import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { OpenClawClient, Message, Session, Agent, Skill, CronJob, Hook, HooksConfig, AgentFile, CreateAgentParams, buildIdentityContent, stripBase64FromStreaming, generateUUID } from '../lib/openclaw'
import { NodeClient } from '../lib/node'
import { getDefaultPermissions } from '../lib/node/command-catalog'
import { getCommands } from '../lib/node/capability-registry'
import type { Node, ExecApprovalsResponse, DevicePairListResponse, ExecApprovalDecision } from '../lib/openclaw'
import type { ClawHubSkill, ClawHubSort } from '../lib/clawhub'
import { listClawHubSkills, searchClawHub, getClawHubSkill, getClawHubSkillVersion, getClawHubSkillConvex } from '../lib/clawhub'
import * as Platform from '../lib/platform'
import { getOrCreateDeviceIdentity, clearDeviceIdentity, getDeviceToken, saveDeviceToken, clearDeviceToken } from '../lib/device-identity'
import type { DeviceIdentity } from '../lib/device-identity'
import { parseSlashCommand } from '../lib/slash-commands'
import { executeSlashCommand, type SlashCommandResult } from '../lib/slash-command-executor'
import { PinnedMessages } from '../lib/pinned-messages'
import { showToast } from '../components/ToastContainer'

/** Matches internal system sessions like agent:main:main, agent:clarissa:cron, etc. */
/** Matches internal system sessions: agent:X:main, agent:X:cron, agent:X:cron:*, agent:X:subagent:* */
const SYSTEM_SESSION_RE = /^agent:[^:]+:(main|cron)(:|$)/

export interface ServerProfile {
  id: string
  name: string
  serverUrl: string
  authMode: 'token' | 'password'
  deviceName: string
  nodeEnabled?: boolean
  nodePermissions?: Record<string, boolean>
}

interface PerProfileState {
  pinnedSessionKeys: string[]
  collapsedSessionGroups: string[]
}

function profileStorageKey(profileId: string): string {
  return `clawcontrol-profile-${profileId}`
}

function loadProfileState(profileId: string): PerProfileState {
  try {
    const raw = localStorage.getItem(profileStorageKey(profileId))
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { pinnedSessionKeys: [], collapsedSessionGroups: [] }
}

function saveProfileState(profileId: string, state: PerProfileState): void {
  try {
    localStorage.setItem(profileStorageKey(profileId), JSON.stringify(state))
  } catch { /* storage full */ }
}

function deleteProfileState(profileId: string): void {
  try {
    localStorage.removeItem(profileStorageKey(profileId))
  } catch { /* ignore */ }
}

export interface ToolCall {
  toolCallId: string
  name: string
  phase: 'start' | 'result'
  result?: string
  args?: Record<string, unknown>
  startedAt: number
  afterMessageId?: string
}

export interface SubagentInfo {
  sessionKey: string
  parentSessionId?: string
  label: string
  status: 'running' | 'completed'
  detectedAt: number
  afterMessageId?: string
}

export interface ExecApprovalRequest {
  id: string
  command?: string
  args?: string[]
  cwd?: string
  agent?: string
  sessionKey?: string
  /** Distinguishes plugin-triggered approvals from exec approvals (v2026.3.28) */
  source?: 'exec' | 'plugin'
  /** The hook that triggered the approval request (v2026.3.28 plugin approvals) */
  hookId?: string
  /** The tool name that triggered the approval (v2026.3.28 plugin approvals) */
  toolName?: string
  receivedAt: number
  raw: unknown
}

interface AgentDetail {
  agent: Agent
  workspace: string
  files: AgentFile[]
  defaultModel?: string
  modelOptions?: string[]
}

/** Queued message to retry after transient reconnect. */
interface PendingMessage {
  content: string
  attachments: any[]
  sessionId: string
  agentId: string | null
  thinking: boolean
  queuedAt: number
}

interface AppState {
  // Theme
  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void
  toggleTheme: () => void

  // Server Profiles
  serverProfiles: ServerProfile[]
  activeProfileId: string | null
  addServerProfile: (profile: Omit<ServerProfile, 'id'>) => string
  updateServerProfile: (id: string, updates: Partial<Omit<ServerProfile, 'id'>>) => void
  deleteServerProfile: (id: string) => void
  switchProfile: (profileId: string) => Promise<void>
  getActiveProfile: () => ServerProfile | null

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
  /** Negotiated protocol version from hello-ok. Null when not yet connected. */
  protocolVersion: number | null
  /** Gateway server version from hello-ok (e.g. "2026.5.20"). Null when not yet connected. */
  gatewayServerVersion: string | null
  /** Recovery hint from v4 auth errors (e.g. "retry_with_device_token"). Null when no hint. */
  connectionErrorHint: string | null
  client: OpenClawClient | null
  deviceName: string
  setDeviceName: (name: string) => void
  /** Messages queued during transient disconnects, flushed on reconnect. */
  pendingMessages: PendingMessage[]

  // Device Identity & Pairing
  pairingStatus: 'none' | 'pending'
  pairingRequestId: string | null
  retryConnect: () => Promise<void>

  // Node Mode
  nodeEnabled: boolean
  setNodeEnabled: (enabled: boolean) => void
  nodeConnected: boolean
  nodePermissions: Record<string, boolean>
  setNodePermissions: (permissions: Record<string, boolean>) => void
  setNodePermission: (command: string, enabled: boolean) => void
  reconnectNode: () => Promise<void>

  // Settings Modal
  showSettings: boolean
  setShowSettings: (show: boolean) => void

  // Certificate Error Modal
  showCertError: boolean
  certErrorUrl: string | null
  showCertErrorModal: (httpsUrl: string) => void
  hideCertErrorModal: () => void

  // UI State
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  collapsedSessionGroups: string[]
  toggleSessionGroup: (label: string) => void
  rightPanelOpen: boolean
  setRightPanelOpen: (open: boolean) => void
  rightPanelWidth: number
  setRightPanelWidth: (width: number) => void
  rightPanelTab: 'skills' | 'crons' | 'hooks'
  setRightPanelTab: (tab: 'skills' | 'crons' | 'hooks') => void

  // Canvas
  canvasHostUrl: string | null
  canvasScopedUrl: string | null
  canvasVisible: boolean
  canvasWidth: number
  setCanvasVisible: (visible: boolean) => void
  setCanvasWidth: (width: number) => void
  toggleCanvas: () => void

  // Main View State
  mainView: 'chat' | 'skill-detail' | 'cron-detail' | 'create-cron' | 'agent-detail' | 'create-agent' | 'clawhub-skill-detail' | 'server-settings' | 'usage' | 'pixel-dashboard' | 'hook-detail' | 'nodes'
  setMainView: (view: 'chat' | 'skill-detail' | 'cron-detail' | 'create-cron' | 'agent-detail' | 'create-agent' | 'clawhub-skill-detail' | 'usage' | 'hook-detail' | 'nodes') => void
  selectedSkill: Skill | null
  selectedCronJob: CronJob | null
  selectedHook: Hook | null
  selectedAgentDetail: AgentDetail | null
  selectSkill: (skill: Skill) => Promise<void>
  selectCronJob: (cronJob: CronJob) => Promise<void>
  selectAgentForDetail: (agent: Agent) => Promise<void>
  openServerSettings: () => void
  openUsage: () => void
  openNodes: () => void
  openCreateCron: () => void
  openDashboard: () => void
  closeDetailView: () => void
  nodes: Node[]
  fetchNodes: () => Promise<void>
  execApprovals: ExecApprovalsResponse | null
  fetchExecApprovals: () => Promise<void>
  pendingExecApprovals: ExecApprovalRequest[]
  resolveExecApproval: (approvalId: string, decision: ExecApprovalDecision) => Promise<void>
  devicePairings: DevicePairListResponse | null
  fetchDevicePairings: () => Promise<void>
  toggleSkillEnabled: (skillId: string, enabled: boolean) => Promise<void>
  saveAgentFile: (agentId: string, fileName: string, content: string) => Promise<boolean>
  refreshAgentFiles: (agentId: string) => Promise<void>
  updateAgentModel: (agentId: string, model: string | null) => Promise<boolean>
  renameAgent: (agentId: string, newName: string) => Promise<boolean>

  // Chat
  messages: Message[]
  addMessage: (message: Message) => void
  clearMessages: () => void
  streamingSessions: Record<string, boolean>
  sessionHadChunks: Record<string, boolean>
  sessionToolCalls: Record<string, ToolCall[]>
  streamingThinking: Record<string, string>
  compactingSession: string | null
  // BTW side result (v2026.3.22) — ephemeral response from /btw command
  sideResult: { text: string; timestamp: number } | null
  dismissSideResult: () => void
  thinkingEnabled: boolean
  setThinkingEnabled: (enabled: boolean) => void
  fastModeEnabled: boolean
  setFastModeEnabled: (enabled: boolean) => void
  streamingDisabled: boolean
  setStreamingDisabled: (disabled: boolean) => void
  draftMessage: string
  setDraftMessage: (message: string) => void

  // Notifications & Unread
  notificationsEnabled: boolean
  setNotificationsEnabled: (enabled: boolean) => Promise<void>
  unreadCounts: Record<string, number>
  clearUnread: (sessionId: string) => void
  streamingSessionId: string | null

  // Sessions
  sessions: Session[]
  currentSessionId: string | null
  setCurrentSession: (sessionId: string) => void
  createNewSession: () => Promise<void>
  deleteSession: (sessionId: string) => void
  updateSessionLabel: (sessionId: string, label: string) => Promise<void>
  spawnSubagentSession: (agentId: string, prompt?: string) => Promise<void>

  // Pinned sessions (local-only)
  pinnedSessionKeys: string[]
  togglePinSession: (sessionKey: string) => void
  isSessionPinned: (sessionKey: string) => boolean

  // Agents
  agents: Agent[]
  currentAgentId: string | null
  setCurrentAgent: (agentId: string) => void
  showCreateAgent: () => void
  createAgent: (params: CreateAgentParams) => Promise<{ success: boolean; error?: string }>
  deleteAgent: (agentId: string) => Promise<{ success: boolean; error?: string }>

  // Skills, Crons & Hooks
  skills: Skill[]
  cronJobs: CronJob[]
  hooks: Hook[]
  hooksConfig: HooksConfig
  selectHook: (hook: Hook) => void
  toggleHookEnabled: (hookId: string, enabled: boolean) => Promise<void>
  toggleInternalHooksEnabled: (enabled: boolean) => Promise<void>

  // ClawHub
  clawHubSkills: ClawHubSkill[]
  clawHubLoading: boolean
  clawHubSearchQuery: string
  clawHubSort: ClawHubSort
  selectedClawHubSkill: ClawHubSkill | null
  skillsSubTab: 'installed' | 'available'
  installingHubSkill: string | null
  installHubSkillError: string | null
  setSkillsSubTab: (tab: 'installed' | 'available') => void
  fetchClawHubSkills: () => Promise<void>
  searchClawHubSkills: (query: string) => Promise<void>
  setClawHubSort: (sort: ClawHubSort) => void
  selectClawHubSkill: (skill: ClawHubSkill) => void
  installClawHubSkill: (slug: string) => Promise<void>
  fetchClawHubSkillDetail: (slug: string) => Promise<void>

  // Slash Commands & Pinned Messages (v2026.3.12)
  executeSlashCommand: (commandName: string, args: string) => Promise<SlashCommandResult | null>
  pinnedMessageIds: Set<string>
  togglePinMessage: (messageId: string) => void
  isMessagePinned: (messageId: string) => boolean
  getPinnedMessages: () => Message[]
  compactCurrentSession: () => Promise<void>
  patchCurrentSession: (patch: { thinkingLevel?: string | null; fastMode?: boolean | null; verboseLevel?: string | null; model?: string | null }) => Promise<void>

  // Subagents
  activeSubagents: SubagentInfo[]
  startSubagentPolling: () => void
  stopSubagentPolling: () => void
  openSubagentPopout: (sessionKey: string) => void
  openToolCallPopout: (toolCallId: string) => void

  // Actions
  initializeApp: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => void
  sendMessage: (content: string, attachments?: Array<{ type?: string; mimeType?: string; fileName?: string; content: string; previewUrl?: string }>) => Promise<void>
  abortChat: () => Promise<void>
  fetchSessions: () => Promise<void>
  fetchAgents: () => Promise<void>
  fetchSkills: () => Promise<void>
  fetchCronJobs: () => Promise<void>
  fetchHooks: () => Promise<void>
}

// Module-level polling state (not persisted)
let _subagentPollTimer: ReturnType<typeof setInterval> | null = null
let _baselineSessionKeys: Set<string> | null = null

// Dedup guard for streamChunk: prevents identical back-to-back deltas from
// being appended (caused by server sending the same text through multiple
// event paths in multi-agent setups).
let _lastChunkText = ''
let _lastChunkTime = 0
const CHUNK_DEDUP_WINDOW_MS = 80

/** Prefix length used to detect late-arriving duplicates of a finalized message. */
const GHOST_BUBBLE_PREFIX_LEN = 80

const AUTH_ERROR_HINT_MAP: Record<string, string> = {
  retry_with_device_token: 'Try reconnecting — the cached device token may resolve this.',
  update_auth_configuration: 'Check the auth configuration on the OpenClaw server.',
  update_auth_credentials: 'Update the gateway token or password in Settings.',
  wait_then_retry: 'The server is still starting. Retry in a few seconds.',
  review_auth_configuration: 'Review the OpenClaw auth configuration; the requested scope is not granted.',
}

// Monotonic counter for detecting stale async message loads after session switches.
let _sessionLoadVersion = 0

// Monotonic counter for detecting stale async connect() completions after profile switches.
let _connectGeneration = 0

// Per-session message cache so switching back to a session shows messages instantly
// while the async refresh loads fresh data from the server.
const _sessionMessagesCache = new Map<string, Message[]>()
const SESSION_CACHE_MAX = 20

/** Set a cache entry, evicting the oldest if over the cap. */
function _cacheSet(key: string, messages: Message[]) {
  // Delete first so re-insertion moves it to the end (most recent)
  _sessionMessagesCache.delete(key)
  _sessionMessagesCache.set(key, messages)
  if (_sessionMessagesCache.size > SESSION_CACHE_MAX) {
    // Map iterates in insertion order — first key is oldest
    const oldest = _sessionMessagesCache.keys().next().value
    if (oldest !== undefined) _sessionMessagesCache.delete(oldest)
  }
}

// Cache of ClawHub skill stats from list results (slug -> { downloads, stars })
const _clawHubStatsCache = new Map<string, { downloads: number; stars: number }>()

/**
 * If the last message is a streaming placeholder (id starts with "streaming-"),
 * finalize it with a stable ID so that subsequent tool calls / subagents can
 * reference it via `afterMessageId`, and new stream chunks will create a fresh
 * streaming message instead of appending to the finalized one.
 */
function finalizeStreamingMessage(messages: Message[]): { messages: Message[]; finalizedId: string | null } {
  if (messages.length === 0) return { messages, finalizedId: null }
  const last = messages[messages.length - 1]
  if (last.role !== 'assistant' || !last.id.startsWith('streaming-')) {
    // Only anchor to the last message if it's an assistant message.
    // Tool calls arriving before any assistant text should go to trailing
    // (rendered in their own bubble) rather than attaching to a user message.
    return { messages, finalizedId: last.role === 'assistant' ? last.id : null }
  }
  const stableId = `msg-finalized-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const updated = [...messages]
  updated[updated.length - 1] = { ...last, id: stableId }
  return { messages: updated, finalizedId: stableId }
}

function shouldNotify(
  notificationsEnabled: boolean,
  msgSessionId: string | null,
  currentSessionId: string | null
): boolean {
  if (!notificationsEnabled) return false
  if (Platform.isAppActive() && msgSessionId === currentSessionId) return false
  return true
}

/** Resolve agent display name from a session key like "agent:jerry:uuid" */
function resolveAgentName(sessionKey: string | null | undefined, agents: Agent[], currentAgentId: string | null): string {
  // Extract agentId from session key format "agent:{agentId}:{uuid}"
  if (sessionKey) {
    const parts = sessionKey.split(':')
    if (parts[0] === 'agent' && parts.length >= 3) {
      const agentId = parts[1]
      const agent = agents.find(a => a.id === agentId)
      if (agent) return agent.name
    }
  }
  // Fallback to current agent
  if (currentAgentId) {
    const agent = agents.find(a => a.id === currentAgentId)
    if (agent) return agent.name
  }
  return 'Agent'
}

/** Grace period (ms) before treating a WebSocket drop as a real disconnect. */
const DISCONNECT_GRACE_MS = 10_000
/** Timer handle for the disconnect grace period (module-level to survive re-renders). */
let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Response watchdog: detects when a message was sent but no streaming events
 * arrive, indicating a stale connection. Force-reconnects and retries.
 * Per-session to avoid concurrent send races overwriting each other.
 */
const RESPONSE_WATCHDOG_MS = 20_000

interface WatchdogEntry {
  timer: ReturnType<typeof setTimeout>
  content: string
  attachments: Array<{ type?: string; mimeType?: string; fileName?: string; content: string; previewUrl?: string }>
  sessionId: string
  retried: boolean
  /** Captured at send time so retry uses correct agent even if user switches */
  agentId?: string
  thinking?: boolean
  thinkingLevel?: string | null
}
const responseWatchdogs = new Map<string, WatchdogEntry>()

/**
 * Sync the node's enabled commands to the server config at
 * `gateway.nodes.allowCommands`. Merges with existing allowed commands
 * so other nodes' commands aren't clobbered. Silently no-ops on failure.
 */
async function syncNodePermissionsToServer(client: OpenClawClient, permissions: Record<string, boolean>, getConnected: () => boolean): Promise<void> {
  try {
    const enabledCommands = getCommands(permissions)
    if (enabledCommands.length === 0) return

    // Node client often connects before the operator client is ready.
    // Wait up to 5s for the operator connection to come online.
    if (!getConnected()) {
      await new Promise<void>((resolve) => {
        let elapsed = 0
        const interval = setInterval(() => {
          elapsed += 250
          if (getConnected() || elapsed >= 5000) {
            clearInterval(interval)
            resolve()
          }
        }, 250)
      })
      if (!getConnected()) return
    }

    const { config, hash } = await client.getServerConfig()
    const existing: string[] = config?.gateway?.nodes?.allowCommands ?? []

    // Merge: add enabled commands that aren't already in the list
    const merged = Array.from(new Set([...existing, ...enabledCommands]))

    // Skip patch if nothing changed
    if (merged.length === existing.length && merged.every(c => existing.includes(c))) return

    await client.patchServerConfig(
      { gateway: { nodes: { allowCommands: merged } } },
      hash
    )
  } catch (err) {
    // Non-fatal — user can still configure manually
    console.warn('[node] Failed to sync allowCommands to server config:', err)
  }
}

function clearResponseWatchdog(sessionId?: string): void {
  if (sessionId) {
    const entry = responseWatchdogs.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      responseWatchdogs.delete(sessionId)
    }
  } else {
    // Clear all watchdogs (e.g. on disconnect)
    for (const [, entry] of responseWatchdogs) {
      clearTimeout(entry.timer)
    }
    responseWatchdogs.clear()
  }
}


export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: 'dark',
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

      // Server Profiles
      serverProfiles: [],
      activeProfileId: null,
      addServerProfile: (profileData) => {
        const id = generateUUID()
        const profile: ServerProfile = { id, ...profileData }
        set((state) => ({
          serverProfiles: [...state.serverProfiles, profile]
        }))
        return id
      },
      updateServerProfile: (id, updates) => {
        set((state) => ({
          serverProfiles: state.serverProfiles.map(p =>
            p.id === id ? { ...p, ...updates } : p
          )
        }))
      },
      deleteServerProfile: (id) => {
        const { activeProfileId } = get()
        deleteProfileState(id)
        Platform.clearProfileToken(id).catch(() => { })
        set((state) => ({
          serverProfiles: state.serverProfiles.filter(p => p.id !== id),
          activeProfileId: activeProfileId === id ? null : activeProfileId
        }))
        if (activeProfileId === id) {
          get().disconnect()
          set({ serverUrl: '', gatewayToken: '', authMode: 'token', deviceName: '' })
        }
      },
      switchProfile: async (profileId: string) => {
        const { activeProfileId, client, serverProfiles } = get()
        const profile = serverProfiles.find(p => p.id === profileId)
        if (!profile) return

        // Save current profile's per-profile state
        if (activeProfileId) {
          const { pinnedSessionKeys, collapsedSessionGroups } = get()
          saveProfileState(activeProfileId, { pinnedSessionKeys, collapsedSessionGroups })
        }

        // Disconnect existing connection
        if (client) {
          client.disconnect()
          if ((globalThis as any).__clawdeskClient === client) {
            (globalThis as any).__clawdeskClient = null
          }
        }
        // Disconnect node client
        const existingNode = (globalThis as any).__clawdeskNodeClient as NodeClient | undefined
        if (existingNode) {
          existingNode.disconnect()
          ;(globalThis as any).__clawdeskNodeClient = null
        }

        // Clear in-memory caches
        _sessionMessagesCache.clear()
        _sessionLoadVersion++

        // Load new profile's per-profile state
        const profileState = loadProfileState(profileId)

        // Load token from secure storage
        const token = await Platform.getProfileToken(profileId)

        // Set all state at once
        set({
          activeProfileId: profileId,
          serverUrl: profile.serverUrl,
          authMode: profile.authMode,
          deviceName: profile.deviceName,
          gatewayToken: token || '',
          client: null,
          connected: false,
          connecting: false,
          connectionError: null,
          protocolVersion: null,
          gatewayServerVersion: null,
          connectionErrorHint: null,
          sessions: [],
          messages: [],
          currentSessionId: null,
          agents: [],
          currentAgentId: null,
          skills: [],
          cronJobs: [],
          hooks: [],
          hooksConfig: { enabled: false },
          activeSubagents: [],
          streamingSessions: {},
          sessionHadChunks: {},
          sessionToolCalls: {},
          streamingThinking: {},
          pendingMessages: [],
          pinnedSessionKeys: profileState.pinnedSessionKeys,
          collapsedSessionGroups: profileState.collapsedSessionGroups,
          mainView: 'chat',
          nodeEnabled: profile.nodeEnabled ?? false,
          nodeConnected: false,
          nodePermissions: { ...getDefaultPermissions(Platform.getPlatform()), ...profile.nodePermissions },
        })
      },
      getActiveProfile: () => {
        const { serverProfiles, activeProfileId } = get()
        return serverProfiles.find(p => p.id === activeProfileId) || null
      },

      // Connection
      serverUrl: '',
      setServerUrl: (url) => {
        set({ serverUrl: url })
        const { activeProfileId } = get()
        if (activeProfileId) {
          get().updateServerProfile(activeProfileId, { serverUrl: url })
        }
      },
      authMode: 'token',
      setAuthMode: (mode) => {
        set({ authMode: mode })
        const { activeProfileId } = get()
        if (activeProfileId) {
          get().updateServerProfile(activeProfileId, { authMode: mode })
        }
      },
      gatewayToken: '',
      setGatewayToken: (token) => {
        set({ gatewayToken: token })
        const { activeProfileId } = get()
        if (activeProfileId) {
          Platform.saveProfileToken(activeProfileId, token).catch(() => { })
        }
        Platform.saveToken(token).catch(() => { })
      },
      connected: false,
      connecting: false,
      connectionError: null,
      setConnectionError: (error) => set({ connectionError: error }),
      protocolVersion: null,
      gatewayServerVersion: null,
      connectionErrorHint: null,
      client: null,
      nodeEnabled: false,
      setNodeEnabled: (enabled) => {
        set({ nodeEnabled: enabled })
        const { activeProfileId } = get()
        if (activeProfileId) {
          get().updateServerProfile(activeProfileId, { nodeEnabled: enabled })
        }
        if (!enabled) {
          // Disconnect node client and stop foreground service immediately
          const existing = (globalThis as any).__clawdeskNodeClient as NodeClient | undefined
          if (existing) {
            existing.disconnect()
            ;(globalThis as any).__clawdeskNodeClient = null
            set({ nodeConnected: false })
          }
          Platform.stopForegroundService()
        }
      },
      nodeConnected: false,
      nodePermissions: getDefaultPermissions(Platform.getPlatform()),
      setNodePermissions: (permissions) => {
        set({ nodePermissions: permissions })
        const { activeProfileId } = get()
        if (activeProfileId) {
          get().updateServerProfile(activeProfileId, { nodePermissions: permissions })
        }
      },
      setNodePermission: (command, enabled) => {
        const perms = { ...get().nodePermissions, [command]: enabled }
        get().setNodePermissions(perms)
      },
      reconnectNode: async () => {
        // Disconnect existing node client
        const existing = (globalThis as any).__clawdeskNodeClient as NodeClient | undefined
        if (existing) {
          existing.disconnect()
          ;(globalThis as any).__clawdeskNodeClient = null
          set({ nodeConnected: false })
        }
        // Reconnect if node mode is enabled and main client is connected
        if (!get().nodeEnabled || !get().connected) return
        // Trigger a full reconnect which will pick up current permissions
        const { serverUrl, gatewayToken, authMode, deviceName, nodePermissions } = get()
        const deviceIdentity = await getOrCreateDeviceIdentity()
        const nodeWsFactory = Platform.createWebSocketFactory()
        let serverHost: string | null = null
        try { serverHost = new URL(serverUrl).host } catch { /* ignore */ }

        let nodeToken = gatewayToken
        if (serverHost) {
          try {
            const stored = await getDeviceToken(serverHost, 'node')
            if (stored) nodeToken = stored
          } catch { /* ignore */ }
        }

        const nodeClient = new NodeClient(
          serverUrl, nodeToken, authMode, nodeWsFactory,
          deviceIdentity, deviceName || undefined, nodePermissions
        )
        nodeClient.on('connected', () => {
          set({ nodeConnected: true })
          Platform.startForegroundService()
          const opClient = get().client
          if (opClient) syncNodePermissionsToServer(opClient, nodePermissions, () => get().connected)
        })
        nodeClient.on('disconnected', () => {
          set({ nodeConnected: false })
          Platform.stopForegroundService()
        })
        ;(globalThis as any).__clawdeskNodeClient = nodeClient
        try {
          await nodeClient.connect()
        } catch {
          // silently fail — node mode is best-effort
        }
      },
      deviceName: '',
      setDeviceName: (name) => {
        set({ deviceName: name })
        const { activeProfileId } = get()
        if (activeProfileId) {
          get().updateServerProfile(activeProfileId, { deviceName: name })
        }
      },
      pendingMessages: [],

      // Device Identity & Pairing
      pairingStatus: 'none',
      pairingRequestId: null,
      retryConnect: async () => {
        set({ pairingStatus: 'none', pairingRequestId: null })
        try {
          await get().connect()
        } catch {
          // connect() handles its own error state
        }
      },

      // Settings Modal
      showSettings: false,
      setShowSettings: (show) => set({ showSettings: show }),

      // Certificate Error Modal
      showCertError: false,
      certErrorUrl: null,
      showCertErrorModal: (httpsUrl) => set({ showCertError: true, certErrorUrl: httpsUrl }),
      hideCertErrorModal: () => set({ showCertError: false, certErrorUrl: null }),

      // UI State
      sidebarOpen: false,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      sidebarCollapsed: false,
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      collapsedSessionGroups: [],
      toggleSessionGroup: (label) => set((state) => {
        const groups = state.collapsedSessionGroups
        return {
          collapsedSessionGroups: groups.includes(label)
            ? groups.filter(g => g !== label)
            : [...groups, label]
        }
      }),
      rightPanelOpen: !Platform.isMobile(),
      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
      rightPanelWidth: 320,
      setRightPanelWidth: (width) => set({ rightPanelWidth: Math.max(240, Math.min(600, width)) }),
      rightPanelTab: 'skills',
      setRightPanelTab: (tab) => set({ rightPanelTab: tab }),

      // Canvas
      canvasHostUrl: null,
      canvasScopedUrl: null,
      canvasVisible: false,
      canvasWidth: 500,
      setCanvasVisible: (visible) => set({ canvasVisible: visible }),
      setCanvasWidth: (width) => set({ canvasWidth: Math.max(300, Math.min(window.innerWidth * 0.7, width)) }),
      toggleCanvas: () => set((state) => {
        if (state.canvasVisible) return { canvasVisible: false }
        // Build URL on first open if needed
        if (state.canvasHostUrl && !state.canvasScopedUrl) {
          const canvasScopedUrl = state.canvasHostUrl.replace(/\/?$/, '') + '/__openclaw__/canvas/'
          return { canvasVisible: true, canvasScopedUrl }
        }
        return { canvasVisible: true }
      }),

      // Main View State
      mainView: 'chat',
      setMainView: (view) => set({ mainView: view }),
      selectedSkill: null,
      selectedCronJob: null,
      selectedHook: null,
      selectedAgentDetail: null,
      selectSkill: async (skill) => {
        // All skill data comes from skills.status, no need for separate fetch
        set({ mainView: 'skill-detail', selectedSkill: skill, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null })
      },
      selectCronJob: async (cronJob) => {
        const { client } = get()
        set({ mainView: 'cron-detail', selectedCronJob: cronJob, selectedSkill: null, selectedHook: null, selectedAgentDetail: null })

        // Fetch full cron job details including content
        if (client) {
          const details = await client.getCronJobDetails(cronJob.id)
          if (details) {
            set({ selectedCronJob: details })
          }
        }
      },
      selectAgentForDetail: async (agent) => {
        const { client } = get()
        set({ mainView: 'agent-detail', selectedAgentDetail: { agent, workspace: '', files: [] }, selectedSkill: null, selectedCronJob: null, selectedHook: null })

        if (client) {
          // Fetch workspace files and server config (for default model) in parallel
          const [filesResult, serverConfig] = await Promise.all([
            client.getAgentFiles(agent.id),
            client.getServerConfig().catch(() => null)
          ])

          const rawModel = serverConfig?.config?.agents?.defaults?.model
          const defaultModel = rawModel || undefined

          // Build model options from server config fallbacks + primary
          const modelOptions: string[] = []
          if (typeof rawModel === 'object' && rawModel) {
            if (rawModel.primary) modelOptions.push(rawModel.primary)
            if (Array.isArray(rawModel.fallbacks)) {
              for (const f of rawModel.fallbacks) {
                if (typeof f === 'string' && !modelOptions.includes(f)) modelOptions.push(f)
              }
            }
          } else if (typeof rawModel === 'string') {
            modelOptions.push(rawModel)
          }

          if (filesResult) {
            // Fetch content for each file
            const filesWithContent: AgentFile[] = []
            for (const file of filesResult.files) {
              if (!file.missing) {
                const fileContent = await client.getAgentFile(agent.id, file.name)
                filesWithContent.push({
                  ...file,
                  content: fileContent?.content
                })
              } else {
                filesWithContent.push(file)
              }
            }
            set({
              selectedAgentDetail: {
                agent,
                workspace: filesResult.workspace,
                files: filesWithContent,
                defaultModel,
                modelOptions
              }
            })
          } else {
            set((state) => state.selectedAgentDetail ? {
              selectedAgentDetail: { ...state.selectedAgentDetail, defaultModel, modelOptions }
            } : state)
          }
        }
      },
      openServerSettings: () => set({ mainView: 'server-settings', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null, selectedClawHubSkill: null }),
      openUsage: () => set({ mainView: 'usage', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null, selectedClawHubSkill: null }),
      openNodes: () => set({ mainView: 'nodes', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null, selectedClawHubSkill: null }),
      openCreateCron: () => set({ mainView: 'create-cron', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null, selectedClawHubSkill: null }),
      openDashboard: () => set({ mainView: 'pixel-dashboard', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null, selectedClawHubSkill: null }),
      closeDetailView: () => set({ mainView: 'chat', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null, selectedClawHubSkill: null }),
      toggleSkillEnabled: async (skillId, enabled) => {
        const { client } = get()
        if (!client) return

        await client.toggleSkill(skillId, enabled)

        // Update local state
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === skillId ? { ...s, enabled } : s
          ),
          selectedSkill: state.selectedSkill?.id === skillId
            ? { ...state.selectedSkill, enabled }
            : state.selectedSkill
        }))
      },
      saveAgentFile: async (agentId, fileName, content) => {
        const { client } = get()
        if (!client) return false

        const success = await client.setAgentFile(agentId, fileName, content)
        if (success) {
          // Update local state
          set((state) => {
            if (!state.selectedAgentDetail) return state
            return {
              selectedAgentDetail: {
                ...state.selectedAgentDetail,
                files: state.selectedAgentDetail.files.map((f) =>
                  f.name === fileName ? { ...f, content, missing: false } : f
                )
              }
            }
          })

          // Refresh agents list to update identity
          await get().fetchAgents()
        }
        return success
      },
      refreshAgentFiles: async (agentId) => {
        const { client, selectedAgentDetail } = get()
        if (!client || !selectedAgentDetail) return

        const filesResult = await client.getAgentFiles(agentId)
        if (filesResult) {
          const filesWithContent: AgentFile[] = []
          for (const file of filesResult.files) {
            if (!file.missing) {
              const fileContent = await client.getAgentFile(agentId, file.name)
              filesWithContent.push({
                ...file,
                content: fileContent?.content
              })
            } else {
              filesWithContent.push(file)
            }
          }
          set({
            selectedAgentDetail: {
              ...selectedAgentDetail,
              workspace: filesResult.workspace,
              files: filesWithContent
            }
          })
        }
      },
      updateAgentModel: async (agentId, model) => {
        const { client } = get()
        if (!client) return false

        try {
          const { config, hash } = await client.getServerConfig()
          if (!config || !hash) return false

          const agentsSection = config.agents || {}
          const existingList: any[] = Array.isArray(agentsSection.list) ? agentsSection.list : []

          // For the "main" agent, update agents.defaults.model.primary
          if (agentId === 'main') {
            const currentModel = agentsSection.defaults?.model
            let patch: any
            if (typeof currentModel === 'object' && currentModel) {
              // Preserve fallbacks, update primary
              patch = { agents: { defaults: { model: { ...currentModel, primary: model || currentModel.primary } } } }
            } else {
              patch = { agents: { defaults: { model: { primary: model || '' } } } }
            }
            await client.patchServerConfig(patch, hash)
          } else {
            // For other agents, update agents.list[].model
            const updatedList = existingList.map((a: any) => {
              const id = a.id || a.name || ''
              if (id !== agentId) return a
              const updated = { ...a }
              if (model) {
                updated.model = model
              } else {
                delete updated.model
              }
              return updated
            })
            await client.patchServerConfig({ agents: { list: updatedList } }, hash)
          }

          // Wait for server restart and refresh
          await new Promise<void>((resolve) => {
            let resolved = false
            const fallback = setTimeout(() => {
              if (!resolved) { resolved = true; client.off('connected', onConnected); resolve() }
            }, 5000)
            const onConnected = () => {
              if (!resolved) { resolved = true; clearTimeout(fallback); client.off('connected', onConnected); resolve() }
            }
            client.on('connected', onConnected)
          })

          await get().fetchAgents()

          // Update the local agent detail
          set((state) => {
            if (!state.selectedAgentDetail || state.selectedAgentDetail.agent.id !== agentId) return state
            return {
              selectedAgentDetail: {
                ...state.selectedAgentDetail,
                agent: { ...state.selectedAgentDetail.agent, model: model || undefined }
              }
            }
          })

          return true
        } catch (err) {
          return false
        }
      },

      renameAgent: async (agentId, newName) => {
        const { client, selectedAgentDetail } = get()
        if (!client) return false

        try {
          // Read current IDENTITY.md
          const identityFile = selectedAgentDetail?.files.find(f => f.name === 'IDENTITY.md')
          let content = identityFile?.content || ''

          // Update or insert the Name line
          if (/^- \*\*Name:\*\*/m.test(content)) {
            content = content.replace(/^- \*\*Name:\*\*.*/m, `- **Name:** ${newName.trim()}`)
          } else {
            content = `- **Name:** ${newName.trim()}\n${content}`
          }

          const success = await client.setAgentFile(agentId, 'IDENTITY.md', content)
          if (!success) return false

          // For non-main agents, also update the config name so fetchAgents()
          // (which prefers config name over identity name) picks up the new name.
          if (agentId !== 'main') {
            try {
              const { config, hash } = await client.getServerConfig()
              if (config && hash) {
                const agentsSection = config.agents || {}
                const existingList: any[] = Array.isArray(agentsSection.list) ? agentsSection.list : []
                const updatedList = existingList.map((a: any) => {
                  const id = a.id || a.name || ''
                  if (id !== agentId) return a
                  return { ...a, name: newName.trim() }
                })
                await client.patchServerConfig({ agents: { list: updatedList } }, hash)

                // Wait for server restart
                await new Promise<void>((resolve) => {
                  let resolved = false
                  const onConnected = () => {
                    if (!resolved) { resolved = true; client.off('connected', onConnected); resolve() }
                  }
                  client.on('connected', onConnected)
                  setTimeout(onConnected, 5000)
                })
              }
            } catch {
              // Config patch failed — IDENTITY.md was still updated, continue
            }
          }

          // Update local state immediately
          set((state) => {
            if (!state.selectedAgentDetail || state.selectedAgentDetail.agent.id !== agentId) return state
            return {
              selectedAgentDetail: {
                ...state.selectedAgentDetail,
                agent: { ...state.selectedAgentDetail.agent, name: newName.trim() },
                files: state.selectedAgentDetail.files.map(f =>
                  f.name === 'IDENTITY.md' ? { ...f, content, missing: false } : f
                )
              }
            }
          })

          await get().fetchAgents()
          return true
        } catch (err) {
          return false
        }
      },

      // Chat
      messages: [],
      addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
      clearMessages: () => set({ messages: [] }),
      streamingSessions: {},
      sessionHadChunks: {},
      sessionToolCalls: {},
      streamingThinking: {},
      compactingSession: null,
      sideResult: null,
      dismissSideResult: () => set({ sideResult: null }),
      thinkingEnabled: false,
      setThinkingEnabled: (enabled) => set({ thinkingEnabled: enabled }),
      fastModeEnabled: false,
      setFastModeEnabled: (enabled) => set({ fastModeEnabled: enabled }),
      streamingDisabled: false,
      setStreamingDisabled: (disabled) => set({ streamingDisabled: disabled }),
      draftMessage: '',
      setDraftMessage: (message) => set({ draftMessage: message }),

      // Notifications & Unread
      notificationsEnabled: false,
      setNotificationsEnabled: async (enabled) => {
        if (enabled) {
          const granted = await Platform.requestNotificationPermission()
          if (!granted) return
        }
        set({ notificationsEnabled: enabled })
      },
      unreadCounts: {},
      clearUnread: (sessionId) => set((state) => {
        const { [sessionId]: _, ...rest } = state.unreadCounts
        return { unreadCounts: rest }
      }),
      streamingSessionId: null,

      // Slash Commands & Pinned Messages (v2026.3.12)
      executeSlashCommand: async (commandName, args) => {
        const { client, currentSessionId, sessions, agents, messages, currentAgentId } = get()
        if (!client || !currentSessionId) return null
        const result = await executeSlashCommand(client, currentSessionId, commandName, args, {
          sessions, agents, messages, currentAgentId
        })
        // Handle side-effect actions
        if (result.action === 'new-session') {
          await get().createNewSession()
        } else if (result.action === 'reset') {
          get().clearMessages()
          await get().fetchSessions()
        } else if (result.action === 'stop') {
          await get().abortChat()
        } else if (result.action === 'clear') {
          get().clearMessages()
        } else if (result.action === 'refresh') {
          await get().fetchSessions()
        }
        return result
      },
      pinnedMessageIds: new Set<string>(),
      togglePinMessage: (messageId) => {
        const { currentSessionId } = get()
        if (!currentSessionId) return
        const pinned = new PinnedMessages(currentSessionId)
        pinned.toggle(messageId)
        set({ pinnedMessageIds: new Set(pinned.ids) })
      },
      isMessagePinned: (messageId) => {
        return get().pinnedMessageIds.has(messageId)
      },
      getPinnedMessages: () => {
        const { messages, pinnedMessageIds } = get()
        return messages.filter(m => pinnedMessageIds.has(m.id))
      },
      compactCurrentSession: async () => {
        const { client, currentSessionId } = get()
        if (!client || !currentSessionId) return
        set({ compactingSession: currentSessionId })
        try {
          await client.call('sessions.compact', { key: currentSessionId })
        } finally {
          set({ compactingSession: null })
        }
        await get().fetchSessions()
      },
      patchCurrentSession: async (patch) => {
        const { client, currentSessionId } = get()
        if (!client || !currentSessionId) return
        await client.call('sessions.patch', { key: currentSessionId, ...patch })
        await get().fetchSessions()
      },

      // Subagents
      activeSubagents: [],
      startSubagentPolling: () => {
        const { client, sessions } = get()
        if (!client || _subagentPollTimer) return

        // Snapshot current session keys as baseline
        _baselineSessionKeys = new Set(sessions.map(s => s.key || s.id))

        _subagentPollTimer = setInterval(async () => {
          const { client: c, currentSessionId } = get()
          if (!c) return

          try {
            const allSessions = await c.listSessions()
            const newSubagents: SubagentInfo[] = []

            for (const s of allSessions) {
              const key = s.key || s.id
              if (_baselineSessionKeys?.has(key)) continue

              // Skip internal system sessions — they are not subagents
              if (SYSTEM_SESSION_RE.test(key)) continue

              // Only show subagents that belong to the current session
              if (!s.spawned && s.parentSessionId !== currentSessionId) continue
              const parentId = s.parentSessionId || currentSessionId || undefined

              // Skip if already tracked
              const { activeSubagents } = get()
              if (activeSubagents.some(a => a.sessionKey === key)) continue

              newSubagents.push({
                sessionKey: key,
                parentSessionId: parentId,
                label: s.title || key,
                status: 'running',
                detectedAt: Date.now()
              })
            }

            if (newSubagents.length > 0) {
              set((state) => {
                // Finalize current streaming message so subagent blocks render inline
                const { messages: finalizedMsgs, finalizedId } = finalizeStreamingMessage(state.messages)
                // Fall back to last message of any role so subagents anchor
                // inline rather than trailing at the bottom of chat.
                const anchorId = finalizedId || finalizedMsgs[finalizedMsgs.length - 1]?.id
                const tagged = newSubagents.map(sa => ({
                  ...sa,
                  afterMessageId: anchorId || undefined
                }))
                return {
                  messages: finalizedMsgs,
                  activeSubagents: [...state.activeSubagents, ...tagged]
                }
              })
            }
          } catch {
            // Polling failure — ignore
          }
        }, 1000)
      },
      stopSubagentPolling: () => {
        if (_subagentPollTimer) {
          clearInterval(_subagentPollTimer)
          _subagentPollTimer = null
        }
        _baselineSessionKeys = null

        // Mark all running subagents as completed
        set((state) => ({
          activeSubagents: state.activeSubagents.map(a =>
            a.status === 'running' ? { ...a, status: 'completed' as const } : a
          )
        }))
      },
      openSubagentPopout: (sessionKey: string) => {
        const { serverUrl, gatewayToken, authMode, activeSubagents } = get()
        const subagent = activeSubagents.find(a => a.sessionKey === sessionKey)
        Platform.openSubagentPopout({
          sessionKey,
          serverUrl,
          authToken: gatewayToken,
          authMode,
          label: subagent?.label || sessionKey
        })
      },
      openToolCallPopout: (toolCallId: string) => {
        // Find the tool call across all sessions
        const { sessionToolCalls } = get()
        let toolCall: ToolCall | undefined
        for (const tcs of Object.values(sessionToolCalls)) {
          toolCall = tcs.find(t => t.toolCallId === toolCallId)
          if (toolCall) break
        }
        if (!toolCall) return

        // Write tool call data to localStorage for the popout to read
        try {
          localStorage.setItem(`toolcall-${toolCallId}`, JSON.stringify(toolCall))
        } catch { /* storage full — ignore */ }

        Platform.openToolCallPopout({ toolCallId, name: toolCall.name })
      },

      // Sessions
      sessions: [],
      currentSessionId: null,

      // Pinned sessions (local-only)
      pinnedSessionKeys: [],
      isSessionPinned: (sessionKey) => get().pinnedSessionKeys.includes(sessionKey),
      togglePinSession: (sessionKey) => set((state) => ({
        pinnedSessionKeys: state.pinnedSessionKeys.includes(sessionKey)
          ? state.pinnedSessionKeys.filter(k => k !== sessionKey)
          : [sessionKey, ...state.pinnedSessionKeys]
      })),
      setCurrentSession: (sessionId) => {
        const { unreadCounts, client, currentSessionId: prevSessionId, messages: currentMessages, sessions } = get()
        const { [sessionId]: _, ...restCounts } = unreadCounts
        // Clear default session key when switching (parent set preserved for concurrent streams)
        client?.setPrimarySessionKey(null)

        // Cache outgoing session's messages (excluding streaming placeholders)
        if (prevSessionId && currentMessages.length > 0) {
          const nonStreaming = currentMessages.filter(m => !m.id.startsWith('streaming-'))
          if (nonStreaming.length > 0) {
            _cacheSet(prevSessionId, nonStreaming)
          }
        }

        const loadVersion = ++_sessionLoadVersion
        const cachedMessages = _sessionMessagesCache.get(sessionId) || []

        // Auto-switch agent to match the session's owner
        const session = sessions.find(s => (s.key || s.id) === sessionId)
        const agentUpdate = session?.agentId && session.agentId !== get().currentAgentId
          ? { currentAgentId: session.agentId } : {}

        // Load pinned messages for the new session
        const pinned = new PinnedMessages(sessionId)
        set({ currentSessionId: sessionId, messages: cachedMessages, activeSubagents: [], unreadCounts: restCounts, mainView: 'chat', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null, selectedClawHubSkill: null, pinnedMessageIds: new Set(pinned.ids), ...agentUpdate })
        // Load fresh messages from server. Guard against stale loads when the
        // user rapidly switches sessions.
        client?.getSessionMessages(sessionId).then((historyResult) => {
          if (_sessionLoadVersion !== loadVersion) return
          const { messages: loadedMessages, toolCalls: historyToolCalls } = historyResult
          _cacheSet(sessionId, loadedMessages)
          set((state) => {
            if (state.currentSessionId !== sessionId) return state
            // Preserve any streaming placeholder that arrived during the async load
            const streamingMsgs = state.messages.filter(m => m.id.startsWith('streaming-'))
            const mergedToolCalls = historyToolCalls.length > 0
              ? { ...state.sessionToolCalls, [sessionId]: historyToolCalls.map(tc => ({ ...tc, startedAt: 0 })) }
              : state.sessionToolCalls
            return {
              messages: streamingMsgs.length > 0 ? [...loadedMessages, ...streamingMsgs] : loadedMessages,
              sessionToolCalls: mergedToolCalls
            }
          })
        }).catch(() => { })
      },
      createNewSession: async () => {
        const { client, currentAgentId } = get()
        if (!client) return

        const session = await client.createSession(currentAgentId || undefined)
        const sessionId = session.key || session.id
        set((state) => ({
          sessions: [session, ...state.sessions.filter(s => (s.key || s.id) !== sessionId)],
          currentSessionId: sessionId,
          messages: [],
          activeSubagents: [],
          streamingSessionId: null
        }))
      },
      deleteSession: (sessionId) => {
        if (SYSTEM_SESSION_RE.test(sessionId)) return
        _sessionMessagesCache.delete(sessionId)
        const { client } = get()
        client?.deleteSession(sessionId)
        set((state) => {
          const { [sessionId]: _s, ...restStreaming } = state.streamingSessions
          const { [sessionId]: _h, ...restChunks } = state.sessionHadChunks
          const { [sessionId]: _t, ...restToolCalls } = state.sessionToolCalls
          return {
            sessions: state.sessions.filter((s) => (s.key || s.id) !== sessionId),
            currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
            pinnedSessionKeys: state.pinnedSessionKeys.filter(k => k !== sessionId),
            streamingSessions: restStreaming,
            sessionHadChunks: restChunks,
            sessionToolCalls: restToolCalls,
          }
        })
      },
      updateSessionLabel: async (sessionId, label) => {
        const { client } = get()
        if (!client) return

        await client.updateSession(sessionId, { label })
        set((state) => ({
          sessions: state.sessions.map((s) =>
            (s.key || s.id) === sessionId ? { ...s, title: label } : s
          )
        }))
      },
      spawnSubagentSession: async (agentId, prompt) => {
        const { client } = get()
        if (!client) return

        const session = await client.spawnSession(agentId, prompt)
        const sessionId = session.key || session.id
        set((state) => ({
          sessions: [session, ...state.sessions.filter(s => (s.key || s.id) !== sessionId)],
          currentSessionId: sessionId,
          messages: []
        }))

        // Load any existing messages for the spawned session
        const historyResult = await client.getSessionMessages(session.key || session.id)
        if (historyResult.messages.length > 0) {
          set((state) => ({
            messages: historyResult.messages,
            sessionToolCalls: historyResult.toolCalls.length > 0
              ? { ...state.sessionToolCalls, [sessionId]: historyResult.toolCalls.map(tc => ({ ...tc, startedAt: 0 })) }
              : state.sessionToolCalls
          }))
        }
      },

      // Agents
      agents: [],
      currentAgentId: null,
      setCurrentAgent: (agentId) => {
        const { currentAgentId: prevAgentId, sessions, currentSessionId: prevSessionId, messages: currentMessages } = get()
        if (agentId === prevAgentId) return

        // Cache outgoing session's messages
        if (prevSessionId && currentMessages.length > 0) {
          const nonStreaming = currentMessages.filter(m => !m.id.startsWith('streaming-'))
          if (nonStreaming.length > 0) {
            _cacheSet(prevSessionId, nonStreaming)
          }
        }

        // Find the most recent non-subagent, non-cron session for the new agent
        const agentSession = sessions.find(s => {
          const key = s.key || s.id
          return s.agentId === agentId && !s.spawned && !s.cron && !key.includes(':subagent:') && !key.includes(':cron:')
        })

        const newSessionId = agentSession ? (agentSession.key || agentSession.id) : null
        const cachedMessages = newSessionId ? (_sessionMessagesCache.get(newSessionId) || []) : []
        set({ currentAgentId: agentId, currentSessionId: newSessionId, messages: cachedMessages })

        // Load fresh messages for the existing session, if any
        if (newSessionId) {
          const { client } = get()
          client?.getSessionMessages(newSessionId).then((historyResult) => {
            if (get().currentSessionId === newSessionId) {
              const { messages: loadedMessages, toolCalls: historyToolCalls } = historyResult
              _cacheSet(newSessionId, loadedMessages)
              set((state) => ({
                messages: loadedMessages,
                sessionToolCalls: historyToolCalls.length > 0
                  ? { ...state.sessionToolCalls, [newSessionId]: historyToolCalls.map(tc => ({ ...tc, startedAt: 0 })) }
                  : state.sessionToolCalls
              }))
            }
          }).catch(() => { })
        }
      },
      showCreateAgent: () => set({ mainView: 'create-agent', selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null }),
      createAgent: async (params) => {
        const { client } = get()
        if (!client) return { success: false, error: 'Not connected' }

        try {
          // 1. Patch config to add the agent (this triggers a server restart)
          const result = await client.createAgent({
            name: params.name,
            workspace: params.workspace,
            model: params.model
          })

          if (!result?.ok) {
            return { success: false, error: 'Server returned an error' }
          }

          const agentId = result.agentId
          const needsIdentity = params.name || params.emoji || params.avatar

          // 2. config.patch triggers a server restart via SIGUSR1.
          //    Wait for the client to reconnect so the server knows about
          //    the new agent before we try to write files or fetch agents.
          await new Promise<void>((resolve) => {
            let resolved = false
            const onConnected = () => {
              if (resolved) return
              resolved = true
              client.off('connected', onConnected)
              resolve()
            }
            client.on('connected', onConnected)

            // Safety timeout: if no reconnect within 15s, continue anyway
            setTimeout(() => {
              if (!resolved) {
                resolved = true
                client.off('connected', onConnected)
                resolve()
              }
            }, 15000)
          })

          // 3. Now that the server has restarted with the new config,
          //    write IDENTITY.md with name/emoji/avatar
          if (needsIdentity) {
            const content = buildIdentityContent({
              name: params.name,
              emoji: params.emoji,
              avatar: params.avatar,
              agentId,
              avatarFileName: params.avatarFileName
            })
            try {
              await client.setAgentFile(agentId, 'IDENTITY.md', content)
            } catch (err) {
              // Failed to write IDENTITY.md
            }

            // Write avatar image as a separate file instead of embedding in IDENTITY.md
            if (params.avatar && params.avatarFileName && params.avatar.startsWith('data:')) {
              try {
                // Strip the data URI prefix (e.g. "data:image/png;base64,") to get raw base64
                const base64Content = params.avatar.replace(/^data:[^;]+;base64,/, '')
                const avatarPath = `avatars/${agentId}/${params.avatarFileName}`
                await client.setAgentFile(agentId, avatarPath, base64Content)
              } catch (err) {
                // Failed to write avatar file
              }
            }
          }

          // 4. Refresh agents list and navigate to detail view
          await get().fetchAgents()

          const newAgent = get().agents.find(a => a.id === agentId)
          if (newAgent) {
            set({ currentAgentId: agentId })
            await get().selectAgentForDetail(newAgent)
          } else {
            set({ mainView: 'chat' })
          }

          return { success: true }
        } catch (err: any) {
          return { success: false, error: err?.message || 'Failed to create agent' }
        }
      },

      deleteAgent: async (agentId) => {
        const { client } = get()
        if (!client) return { success: false, error: 'Not connected' }

        try {
          const result = await client.deleteAgent(agentId)
          if (!result?.ok) {
            return { success: false, error: 'Server returned an error' }
          }

          // Wait for reconnect after config.patch triggers server restart
          await new Promise<void>((resolve) => {
            let resolved = false
            const onConnected = () => {
              if (resolved) return
              resolved = true
              client.off('connected', onConnected)
              resolve()
            }
            client.on('connected', onConnected)

            setTimeout(() => {
              if (!resolved) {
                resolved = true
                client.off('connected', onConnected)
                resolve()
              }
            }, 15000)
          })

          // If deleted agent was selected, switch to 'main' or first available
          const { currentAgentId, mainView, selectedAgentDetail } = get()
          if (currentAgentId === agentId) {
            set({ currentAgentId: 'main' })
          }

          // If deleted agent was in detail view, close it
          if (mainView === 'agent-detail' && selectedAgentDetail?.agent.id === agentId) {
            set({ mainView: 'chat', selectedAgentDetail: null })
          }

          // Refresh agents list
          await get().fetchAgents()

          // Fallback: if 'main' doesn't exist, pick first available
          const { agents, currentAgentId: newAgentId } = get()
          if (newAgentId === agentId || !agents.some(a => a.id === newAgentId)) {
            set({ currentAgentId: agents[0]?.id || 'main' })
          }

          return { success: true }
        } catch (err: any) {
          return { success: false, error: err?.message || 'Failed to delete agent' }
        }
      },

      // Nodes
      nodes: [],
      fetchNodes: async () => {
        const { client } = get()
        if (!client) return
        try {
          const nodes = await client.listNodes()
          set({ nodes })
        } catch (err) {
          console.warn('[store] Failed to fetch nodes:', err)
        }
      },
      execApprovals: null,
      fetchExecApprovals: async () => {
        const { client } = get()
        if (!client) return
        try {
          const execApprovals = await client.getExecApprovals()
          set({ execApprovals })
        } catch (err) {
          console.warn('[store] Failed to fetch exec approvals:', err)
        }
      },
      pendingExecApprovals: [],
      resolveExecApproval: async (approvalId: string, decision: ExecApprovalDecision) => {
        const { client } = get()
        if (!client) return
        try {
          await client.resolveExecApproval(approvalId, decision)
        } catch (err) {
          console.warn('[store] Failed to resolve exec approval:', err)
        }
        // Remove from pending regardless — avoid stale banners
        set((state) => ({
          pendingExecApprovals: state.pendingExecApprovals.filter((a) => a.id !== approvalId)
        }))
      },
      devicePairings: null,
      fetchDevicePairings: async () => {
        const { client } = get()
        if (!client) return
        try {
          const devicePairings = await client.listDevicePairings()
          set({ devicePairings })
        } catch (err) {
          console.warn('[store] Failed to fetch device pairings:', err)
        }
      },

      // Skills, Crons & Hooks
      skills: [],
      cronJobs: [],
      hooks: [],
      hooksConfig: {},
      selectHook: (hook) => {
        set({ mainView: 'hook-detail', selectedHook: hook, selectedSkill: null, selectedCronJob: null, selectedAgentDetail: null, selectedClawHubSkill: null })
      },
      toggleHookEnabled: async (hookId, enabled) => {
        const { client } = get()
        if (!client) return

        // Optimistic update
        set((state) => ({
          hooks: state.hooks.map(h => h.id === hookId ? { ...h, enabled } : h),
          selectedHook: state.selectedHook?.id === hookId ? { ...state.selectedHook, enabled } : state.selectedHook
        }))

        try {
          await client.toggleHookEnabled(hookId, enabled)
          // config.patch triggers server restart — refetch after reconnect
          await new Promise<void>((resolve) => {
            let resolved = false
            const fallback = setTimeout(() => { if (!resolved) { resolved = true; client.off('connected', onConnected); resolve() } }, 5000)
            const onConnected = () => { if (!resolved) { resolved = true; clearTimeout(fallback); client.off('connected', onConnected); resolve() } }
            client.on('connected', onConnected)
          })
          await get().fetchHooks()
        } catch {
          // Revert optimistic update
          set((state) => ({
            hooks: state.hooks.map(h => h.id === hookId ? { ...h, enabled: !enabled } : h),
            selectedHook: state.selectedHook?.id === hookId ? { ...state.selectedHook, enabled: !enabled } : state.selectedHook
          }))
        }
      },
      toggleInternalHooksEnabled: async (enabled) => {
        const { client } = get()
        if (!client) return

        set((state) => ({
          hooksConfig: { ...state.hooksConfig, internal: { ...state.hooksConfig.internal, enabled } }
        }))

        try {
          await client.toggleInternalHooksEnabled(enabled)
          await new Promise<void>((resolve) => {
            let resolved = false
            const fallback = setTimeout(() => { if (!resolved) { resolved = true; client.off('connected', onConnected); resolve() } }, 5000)
            const onConnected = () => { if (!resolved) { resolved = true; clearTimeout(fallback); client.off('connected', onConnected); resolve() } }
            client.on('connected', onConnected)
          })
          await get().fetchHooks()
        } catch {
          set((state) => ({
            hooksConfig: { ...state.hooksConfig, internal: { ...state.hooksConfig.internal, enabled: !enabled } }
          }))
        }
      },

      // ClawHub
      clawHubSkills: [],
      clawHubLoading: false,
      clawHubSearchQuery: '',
      clawHubSort: 'downloads',
      selectedClawHubSkill: null,
      skillsSubTab: 'installed',
      installingHubSkill: null,
      installHubSkillError: null,
      setSkillsSubTab: (tab) => {
        set({ skillsSubTab: tab })
        if (tab === 'available' && get().clawHubSkills.length === 0 && !get().clawHubLoading) {
          get().fetchClawHubSkills()
        }
      },
      fetchClawHubSkills: async () => {
        set({ clawHubLoading: true })
        try {
          const skills = await listClawHubSkills(get().clawHubSort)
          // Cache stats for enriching search results later
          for (const s of skills) {
            _clawHubStatsCache.set(s.slug, { downloads: s.downloads, stars: s.stars })
          }
          set({ clawHubSkills: skills })
        } catch {
          // fetch failed
        }
        set({ clawHubLoading: false })
      },
      searchClawHubSkills: async (query) => {
        set({ clawHubSearchQuery: query, clawHubLoading: true })
        try {
          let skills = query.trim()
            ? await searchClawHub(query)
            : await listClawHubSkills(get().clawHubSort)
          // Enrich search results with cached stats (search endpoint doesn't return stats)
          skills = skills.map(s => {
            const cached = _clawHubStatsCache.get(s.slug)
            if (cached && s.downloads === 0 && s.stars === 0) {
              return { ...s, downloads: cached.downloads, stars: cached.stars }
            }
            // Cache stats from list results
            if (s.downloads > 0 || s.stars > 0) {
              _clawHubStatsCache.set(s.slug, { downloads: s.downloads, stars: s.stars })
            }
            return s
          })
          set({ clawHubSkills: skills })
        } catch {
          // search failed
        }
        set({ clawHubLoading: false })
      },
      setClawHubSort: (sort) => {
        set({ clawHubSort: sort })
        get().fetchClawHubSkills()
      },
      selectClawHubSkill: (skill) => {
        set({ mainView: 'clawhub-skill-detail', selectedClawHubSkill: skill, selectedSkill: null, selectedCronJob: null, selectedHook: null, selectedAgentDetail: null })
      },
      installClawHubSkill: async (slug) => {
        set({ installingHubSkill: slug, installHubSkillError: null })

        const { client, currentSessionId } = get()
        if (!client) {
          set({ installHubSkillError: 'Not connected to server', installingHubSkill: null })
          return
        }

        try {
          // Send chat message — the agent runs clawhub install via exec tool
          await client.installHubSkill(slug, currentSessionId || undefined)

          // Poll for the skill to appear in the skills list (agent runs async)
          const maxAttempts = 24 // ~2 minutes
          const pollInterval = 5000
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, pollInterval))
            // Stop polling if user navigated away or started a different install
            if (get().installingHubSkill !== slug) return
            await get().fetchSkills()
            const installed = get().skills.some(s => {
              const sl = slug.toLowerCase()
              if (s.name.toLowerCase() === sl || s.id.toLowerCase() === sl) return true
              if (s.filePath) {
                const parts = s.filePath.replace(/\\/g, '/').split('/')
                const idx = parts.lastIndexOf('skills')
                if (idx >= 0 && idx + 1 < parts.length && parts[idx + 1].toLowerCase() === sl) return true
              }
              return false
            })
            if (installed) {
              set({ installingHubSkill: null })
              return
            }
          }
          // Timed out — clear state, user can check chat for output
          set({ installingHubSkill: null, installHubSkillError: 'Install may still be running — check the chat for output' })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Install failed'
          console.error('[clawhub] Install failed:', msg)
          set({ installHubSkillError: msg, installingHubSkill: null })
        }
      },
      fetchClawHubSkillDetail: async (slug) => {
        try {
          // Fetch REST detail and Convex data (VT scan) in parallel
          const [detail, convexData] = await Promise.all([
            getClawHubSkill(slug),
            getClawHubSkillConvex(slug)
          ])
          if (detail && get().selectedClawHubSkill?.slug === slug) {
            if (convexData?.vtAnalysis) {
              detail.vtAnalysis = convexData.vtAnalysis
            }
            set({ selectedClawHubSkill: detail })
            // Cache stats
            if (detail.downloads > 0 || detail.stars > 0) {
              _clawHubStatsCache.set(slug, { downloads: detail.downloads, stars: detail.stars })
            }
            // Fetch version details (files, changelog)
            if (detail.version) {
              const versionInfo = await getClawHubSkillVersion(slug, detail.version)
              if (versionInfo && get().selectedClawHubSkill?.slug === slug) {
                set((state) => ({
                  selectedClawHubSkill: state.selectedClawHubSkill ? {
                    ...state.selectedClawHubSkill,
                    changelog: versionInfo.changelog,
                    versionFiles: versionInfo.files
                  } : null
                }))
              }
            }
          }
        } catch {
          // detail fetch failed - keep the list data
        }
      },

      // Actions
      initializeApp: async () => {
        // Get config from platform (Electron, Capacitor, or web)
        const config = await Platform.getConfig()
        if (!get().serverUrl && config.defaultUrl) {
          set({ serverUrl: config.defaultUrl })
        }
        if (config.theme) {
          set({ theme: config.theme as 'dark' | 'light' })
        }

        // Load token from secure storage
        const secureToken = await Platform.getToken()
        if (secureToken) {
          set({ gatewayToken: secureToken })
        } else {
          // Migration: if Zustand has a token from old localStorage but secure storage is empty,
          // migrate it to secure storage
          const legacyToken = get().gatewayToken
          if (legacyToken) {
            await Platform.saveToken(legacyToken).catch(() => { })
          }
        }

        // Clean up legacy gatewayToken from localStorage
        try {
          const raw = localStorage.getItem('clawcontrol-storage')
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed.state?.gatewayToken) {
              delete parsed.state.gatewayToken
              localStorage.setItem('clawcontrol-storage', JSON.stringify(parsed))
            }
          }
        } catch { /* ignore */ }

        // Migration: create a default server profile from legacy single-server state
        const { serverProfiles, serverUrl: legacyUrl, gatewayToken: currentToken, authMode: currentMode, deviceName: currentName, pinnedSessionKeys, collapsedSessionGroups } = get()
        if (serverProfiles.length === 0 && legacyUrl) {
          const id = generateUUID()
          const profile: ServerProfile = {
            id,
            name: 'Server 1',
            serverUrl: legacyUrl,
            authMode: currentMode || 'token',
            deviceName: currentName || '',
          }
          set({ serverProfiles: [profile], activeProfileId: id })
          // Migrate token to profile-scoped storage
          if (currentToken) {
            await Platform.saveProfileToken(id, currentToken).catch(() => { })
          }
          // Migrate per-profile state
          saveProfileState(id, { pinnedSessionKeys, collapsedSessionGroups })
        }

        // If there's an active profile, load its connection data
        const { activeProfileId, serverProfiles: profiles } = get()
        if (activeProfileId) {
          const profile = profiles.find(p => p.id === activeProfileId)
          if (profile) {
            const profileToken = await Platform.getProfileToken(activeProfileId)
            set({
              serverUrl: profile.serverUrl,
              authMode: profile.authMode,
              deviceName: profile.deviceName,
              gatewayToken: profileToken || currentToken || '',
            })
          }
        }

        // Show settings if no URL or token configured
        const { serverUrl, gatewayToken } = get()
        if (!serverUrl || !gatewayToken) {
          set({ showSettings: true })
          return
        }

        // Auto-connect
        try {
          await get().connect()
        } catch {
          // Show settings on connection failure
          set({ showSettings: true })
        }
      },

      connect: async () => {
        const { serverUrl, gatewayToken, client: existingClient, connecting } = get()

        // Prevent concurrent connect() calls (React StrictMode fires effects twice)
        if (connecting) {
          return
        }

        // Show settings if URL is not configured
        if (!serverUrl) {
          set({ showSettings: true })
          return
        }

        // Disconnect existing client to prevent duplicate event handling
        if (existingClient) {
          existingClient.disconnect()
          set({ client: null })
        }

        // Also kill any stale client surviving across Vite HMR reloads.
        const stale = (globalThis as any).__clawdeskClient as OpenClawClient | undefined
        if (stale && stale !== existingClient) {
          try { stale.disconnect() } catch { /* already closed */ }
        }

        const thisGeneration = ++_connectGeneration
        set({ connecting: true, pairingStatus: 'none', pairingRequestId: null })

        // Hoisted so catch block can access for device token retry logic
        let serverHost: string | null = null
        let effectiveToken = gatewayToken
        try {
          serverHost = new URL(serverUrl).host
        } catch {
          // URL parsing failed
        }

        try {
          const { authMode } = get()

          // Load or create device identity for Ed25519 challenge signing.
          // ClawControl no longer supports the insecure-auth bypass; always attempt pairing.
          let deviceIdentity: DeviceIdentity | null = null
          try {
            deviceIdentity = await getOrCreateDeviceIdentity()
          } catch {
            // Ed25519 unavailable — connect without device identity
          }

          // Check for a stored device token for this server.
          if (serverHost) {
            try {
              const storedDeviceToken = await getDeviceToken(serverHost)
              if (storedDeviceToken) {
                effectiveToken = storedDeviceToken
              }
            } catch {
              // Storage read failed
            }
          }

          // On iOS/Android, use the native WebSocket plugin for TLS certificate handling (TOFU)
          let wsFactory: ((url: string) => any) | undefined
          try {
            const parsed = new URL(serverUrl)
            const origin = parsed.protocol === 'wss:' ? 'https://localhost' : 'http://localhost'
            wsFactory = Platform.createWebSocketFactory({
              required: false,
              allowTOFU: true,
              storeKey: parsed.host,
              origin,
            })
          } catch {
            // URL parsing failed, proceed without factory
          }
          const { deviceName } = get()
          const client = new OpenClawClient(serverUrl, effectiveToken, authMode, wsFactory, deviceIdentity, deviceName || undefined)

          // Set up event handlers
          client.on('message', (msgArg: unknown) => {
            const msgPayload = msgArg as Message & { sessionKey?: string; audioAsVoice?: boolean }
            const sessionKey = msgPayload.sessionKey
            const { currentSessionId } = get()
            const resolvedKey = sessionKey || currentSessionId
            const isCurrentSession = !sessionKey || !currentSessionId || sessionKey === currentSessionId

            // For non-current sessions, clear streaming state.
            // However, still process messages with media (audio/images) from subagent
            // sessions — these are responses the user expects to see in the parent session.
            if (!isCurrentSession) {
              if (resolvedKey) {
                set((state) => ({
                  streamingSessions: { ...state.streamingSessions, [resolvedKey]: false }
                }))
              }
              if (!msgPayload.audioUrl && !msgPayload.videoUrl && (!msgPayload.images || msgPayload.images.length === 0)) {
                return
              }
            }

            const message: Message = {
              id: msgPayload.id,
              role: msgPayload.role,
              content: msgPayload.content,
              timestamp: msgPayload.timestamp,
              thinking: msgPayload.thinking || get().streamingThinking[resolvedKey || ''] || undefined,
              images: msgPayload.images,
              audioUrl: msgPayload.audioUrl,
              videoUrl: msgPayload.videoUrl,
              audioAsVoice: msgPayload.audioAsVoice || undefined
            }
            let replacedStreaming = false

            set((state) => {
              const streamingSessions = resolvedKey
                ? { ...state.streamingSessions, [resolvedKey]: false }
                : state.streamingSessions

              // Replace streaming placeholder with the final server message
              const lastIdx = state.messages.length - 1
              const lastMsg = lastIdx >= 0 ? state.messages[lastIdx] : null

              // Helper: re-anchor tool calls from an old message id to the new final id
              const reanchorToolCalls = (oldId: string, sessionToolCalls: typeof state.sessionToolCalls) => {
                const tcKey = resolvedKey || ''
                const tcs = sessionToolCalls[tcKey]
                if (!tcs?.some(tc => tc.afterMessageId === oldId)) return sessionToolCalls
                return {
                  ...sessionToolCalls,
                  [tcKey]: tcs.map(tc =>
                    tc.afterMessageId === oldId ? { ...tc, afterMessageId: message.id } : tc
                  )
                }
              }

              // Helper: re-anchor subagents from an old message id to the new final id
              const reanchorSubagents = (oldId: string, activeSubagents: typeof state.activeSubagents) => {
                if (!activeSubagents.some(sa => sa.afterMessageId === oldId)) return activeSubagents
                return activeSubagents.map(sa =>
                  sa.afterMessageId === oldId ? { ...sa, afterMessageId: message.id } : sa
                )
              }

              if (lastMsg && lastMsg.role === 'assistant' && lastMsg.id.startsWith('streaming-')) {
                // Don't replace a streaming placeholder with a media-only message
                // (e.g. from lifecycle end) — that would destroy streamed text.
                // Instead, merge media into the streaming message.
                const isMediaOnly = !message.content.trim() && (message.images?.length || message.audioUrl || message.videoUrl)
                if (isMediaOnly) {
                  const updated = [...state.messages]
                  updated[lastIdx] = {
                    ...lastMsg,
                    images: [...(lastMsg.images || []), ...(message.images || [])],
                    audioUrl: message.audioUrl || lastMsg.audioUrl,
                    videoUrl: message.videoUrl || lastMsg.videoUrl,
                    audioAsVoice: message.audioAsVoice || lastMsg.audioAsVoice,
                  }
                  return { messages: updated, streamingSessions }
                }
                replacedStreaming = true
                const updated = [...state.messages]
                updated[lastIdx] = { ...message }
                return {
                  messages: updated,
                  streamingSessions,
                  sessionToolCalls: reanchorToolCalls(lastMsg.id, state.sessionToolCalls),
                  activeSubagents: reanchorSubagents(lastMsg.id, state.activeSubagents)
                }
              }

              // Also check for finalized messages (msg-finalized-*) that may hold tool calls
              const finalizedIdx = state.messages.findIndex(m =>
                m.role === 'assistant' && m.id.startsWith('msg-finalized-')
              )
              if (finalizedIdx >= 0) {
                const finalizedMsg = state.messages[finalizedIdx]
                const updated = [...state.messages]
                if (!finalizedMsg.content.trim() && (!finalizedMsg.images || finalizedMsg.images.length === 0)) {
                  // Empty finalized message (tool-call-only anchor) — remove it
                  updated.splice(finalizedIdx, 1)
                } else if (message.role === 'assistant' && message.content.trim()) {
                  // Canonical server message replacing the finalized streaming text.
                  // This prevents duplicate messages when agent lifecycle:end finalizes
                  // the streaming placeholder before chat:final arrives.
                  updated[finalizedIdx] = {
                    ...message,
                    images: [...(message.images || []), ...(finalizedMsg.images || [])].filter(
                      (img, i, arr) => arr.findIndex(x => x.url === img.url) === i
                    ) || undefined,
                    audioUrl: message.audioUrl || finalizedMsg.audioUrl,
                    videoUrl: message.videoUrl || finalizedMsg.videoUrl,
                  }
                  return {
                    messages: updated,
                    streamingSessions,
                    sessionToolCalls: reanchorToolCalls(finalizedMsg.id, state.sessionToolCalls),
                    activeSubagents: reanchorSubagents(finalizedMsg.id, state.activeSubagents)
                  }
                } else {
                  updated[finalizedIdx] = { ...finalizedMsg }
                }
                const exists = updated.some(m => m.id === message.id)
                return {
                  messages: exists
                    ? updated.map(m => m.id === message.id ? message : m)
                    : [...updated, message],
                  streamingSessions,
                  sessionToolCalls: reanchorToolCalls(finalizedMsg.id, state.sessionToolCalls),
                  activeSubagents: reanchorSubagents(finalizedMsg.id, state.activeSubagents)
                }
              }

              const exists = state.messages.some(m => m.id === message.id)
              if (exists) {
                return {
                  messages: state.messages.map(m => m.id === message.id ? message : m),
                  streamingSessions
                }
              }
              return {
                messages: [...state.messages, message],
                streamingSessions
              }
            })

            // Only notify for non-streamed responses (streamEnd handles streamed ones)
            if (message.role === 'assistant' && !replacedStreaming) {
              const preview = message.content.slice(0, 100) || (message.images?.length ? 'Image response' : message.videoUrl ? 'Video response' : 'New response')
              const { notificationsEnabled, streamingSessionId: msgSession, currentSessionId: activeSession, agents, currentAgentId } = get()
              if (shouldNotify(notificationsEnabled, msgSession, activeSession)) {
                const name = resolveAgentName(msgSession, agents, currentAgentId)
                Platform.showNotification(`${name} responded`, preview).catch(() => { })
              }
            }
          })

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

            // Flush any messages queued during transient disconnect.
            // Use the local `client` variable from the closure since
            // `set({ client })` hasn't been called yet at this point.
            const pending = get().pendingMessages
            if (pending.length > 0) {
              set({ pendingMessages: [] })
              for (const pm of pending) {
                // Re-send using the stored session/agent from when the message was queued,
                // not the current UI state (user may have switched sessions during disconnect).
                if (client) {
                  client.sendMessage({
                    sessionId: pm.sessionId,
                    content: pm.content.trim(),
                    agentId: pm.agentId || undefined,
                    thinking: pm.thinking,
                    attachments: pm.attachments.map(({ previewUrl: _, ...a }: any) => a)
                  }).catch(() => { })
                }
              }
            }

            // Reload session list and current chat history after reconnect
            // so the UI reflects any messages that arrived while disconnected.
            get().fetchSessions().catch(() => { })
            const activeSession = get().currentSessionId
            if (activeSession && client) {
              client.getSessionMessages(activeSession).then((historyResult) => {
                const { messages: loadedMessages, toolCalls: historyToolCalls } = historyResult
                _cacheSet(activeSession, loadedMessages)
                set((state) => {
                  if (state.currentSessionId !== activeSession) return state
                  const streamingMsgs = state.messages.filter(m => m.id.startsWith('streaming-'))
                  const mergedToolCalls = historyToolCalls.length > 0
                    ? { ...state.sessionToolCalls, [activeSession]: historyToolCalls.map(tc => ({ ...tc, startedAt: 0 })) }
                    : state.sessionToolCalls
                  return {
                    messages: streamingMsgs.length > 0 ? [...loadedMessages, ...streamingMsgs] : loadedMessages,
                    sessionToolCalls: mergedToolCalls
                  }
                })
              }).catch(() => { })
            }
          })

          client.on('pairingRequired', (payload: unknown) => {
            const { requestId } = (payload || {}) as { requestId?: string; deviceId?: string }
            set({
              connecting: false,
              pairingStatus: 'pending',
              pairingRequestId: requestId || null,
              showSettings: true
            })
          })

          client.on('deviceIdentityStale', () => {
            clearDeviceIdentity().catch(() => { })
          })

          client.on('disconnected', () => {
            // Clean up all watchdog timers — connection is down
            clearResponseWatchdog()  // clears all
            // Don't immediately mark as disconnected — use a grace period so
            // transient mobile drops (1-5s) don't flash the UI or disable input.
            if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer)
            disconnectGraceTimer = setTimeout(() => {
              disconnectGraceTimer = null
              // Grace period expired — actually mark as disconnected
              set({ connected: false, streamingSessions: {}, sessionHadChunks: {}, sessionToolCalls: {}, streamingThinking: {}, compactingSession: null, canvasHostUrl: null, canvasScopedUrl: null, canvasVisible: false })
              get().stopSubagentPolling()
            }, DISCONNECT_GRACE_MS)
          })

          client.on('certError', (payload: unknown) => {
            const { httpsUrl } = payload as { url: string; httpsUrl: string }
            get().showCertErrorModal(httpsUrl)
          })

          client.on('streamStart', (payload: unknown) => {
            const { sessionKey } = (payload || {}) as { sessionKey?: string }
            const { currentSessionId } = get()
            const resolvedKey = sessionKey || currentSessionId
            // Server started streaming — cancel the response watchdog for this session
            if (resolvedKey) clearResponseWatchdog(resolvedKey)
            if (resolvedKey) {
              set((state) => ({
                streamingSessions: { ...state.streamingSessions, [resolvedKey]: true },
                sessionHadChunks: { ...state.sessionHadChunks, [resolvedKey]: false },
              }))
            }
            if (!sessionKey || !currentSessionId || sessionKey === currentSessionId) {
              get().startSubagentPolling()
            }
          })

          client.on('streamChunk', (chunkArg: unknown) => {
            // Any streaming chunk means the connection is alive — cancel watchdog for this session

            const chunk = (chunkArg && typeof chunkArg === 'object')
              ? chunkArg as { text?: string; sessionKey?: string }
              : { text: String(chunkArg) }
            const text = chunk.text || ''
            const sessionKey = chunk.sessionKey
            // Skip empty chunks
            if (!text) return

            // Dedup guard: in multi-agent setups the server can send the same
            // content through multiple event paths (chat + agent, or multiple
            // agent streams). Skip identical consecutive chunks within a short
            // window to prevent triple/double streaming.
            const now = Date.now()
            if (text === _lastChunkText && (now - _lastChunkTime) < CHUNK_DEDUP_WINDOW_MS) {
              return
            }
            _lastChunkText = text
            _lastChunkTime = now

            const { currentSessionId, streamingDisabled } = get()
            const resolvedKey = sessionKey || currentSessionId
            if (resolvedKey) clearResponseWatchdog(resolvedKey)
            const isCurrentSession = !sessionKey || !currentSessionId || sessionKey === currentSessionId

            // For non-current sessions, just track that chunks arrived
            if (!isCurrentSession) {
              if (resolvedKey) {
                set((state) => ({
                  streamingSessions: { ...state.streamingSessions, [resolvedKey]: true },
                  sessionHadChunks: { ...state.sessionHadChunks, [resolvedKey]: true },
                }))
              }
              return
            }

            // When streaming display is disabled, track that we're streaming
            // but don't create/update the placeholder message. The typing indicator
            // stays visible (sessionHadChunks remains false) until the final message arrives.
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

              // Only append to an active streaming placeholder — finalized messages
              // should not be extended (a new streaming message will be created instead).
              if (lastMessage && lastMessage.role === 'assistant' && lastMessage.id.startsWith('streaming-')) {
                const rawContent = lastMessage.content + text
                const { text: cleanContent } = stripBase64FromStreaming(rawContent)
                const updatedMessage = { ...lastMessage, content: cleanContent }
                messages[messages.length - 1] = updatedMessage
                return { messages, ...perSession }
              } else {
                // Ghost bubble guard: if the last message is a finalized assistant
                // message whose content already contains (or matches) the incoming
                // chunk, this is a late-arriving duplicate from a secondary event
                // source (e.g. agent events after chat:final). Suppress it.
                if (lastMessage && lastMessage.role === 'assistant' && !lastMessage.id.startsWith('streaming-')) {
                  const existing = lastMessage.content.trim()
                  const incoming = text.trim()
                  if (existing && incoming && (existing.includes(incoming) || incoming.startsWith(existing.slice(0, GHOST_BUBBLE_PREFIX_LEN)))) {
                    return { ...perSession }
                  }
                }

                // Create new assistant placeholder
                const { text: cleanText } = stripBase64FromStreaming(text)
                const newMessage: Message = {
                  id: `streaming-${Date.now()}`,
                  role: 'assistant',
                  content: cleanText,
                  timestamp: new Date().toISOString()
                }

                // Re-anchor any orphaned (trailing) tool calls to this new message
                // so they render above the text inside the same bubble.
                const tcKey = resolvedKey || ''
                const currentTCs = state.sessionToolCalls[tcKey]
                let sessionToolCalls = state.sessionToolCalls
                if (currentTCs?.some(tc => !tc.afterMessageId)) {
                  const updated = currentTCs.map(tc =>
                    tc.afterMessageId ? tc : { ...tc, afterMessageId: newMessage.id }
                  )
                  sessionToolCalls = { ...state.sessionToolCalls, [tcKey]: updated }
                }

                return { messages: [...messages, newMessage], sessionToolCalls, ...perSession }
              }
            })
          })

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
                if (existing && incoming && (existing.includes(incoming) || incoming.startsWith(existing.slice(0, GHOST_BUBBLE_PREFIX_LEN)))) {
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

              // Re-anchor any orphaned (trailing) tool calls to this new message
              // so they render above the text inside the same bubble, matching
              // the streamChunk handler's behavior when it creates a placeholder.
              const tcKey = resolvedKey || ''
              const currentTCs = state.sessionToolCalls[tcKey]
              let sessionToolCalls = state.sessionToolCalls
              if (currentTCs?.some(tc => !tc.afterMessageId)) {
                const updated = currentTCs.map(tc =>
                  tc.afterMessageId ? tc : { ...tc, afterMessageId: newMessage.id }
                )
                sessionToolCalls = { ...state.sessionToolCalls, [tcKey]: updated }
              }

              return { messages: [...messages, newMessage], sessionToolCalls, ...perSession }
            })
          })

          client.on('authError', (payload: unknown) => {
            const p = (payload || {}) as {
              code?: string
              reason?: string
              canRetryWithDeviceToken?: boolean
              recommendedNextStep?: string
              message?: string
            }
            // connected: false / connecting: false are set by the connect() catch
            // block; this handler only adds the v4 structured fields.
            const hint = p.recommendedNextStep
              ? (AUTH_ERROR_HINT_MAP[p.recommendedNextStep] || p.recommendedNextStep)
              : null
            set({
              connectionError: p.message || 'Authentication failed',
              connectionErrorHint: hint,
            })
          })

          client.on('streamEnd', (payload: unknown) => {
            const { sessionKey } = (payload || {}) as { sessionKey?: string }
            const { currentSessionId } = get()
            const resolvedKey = sessionKey || get().streamingSessionId || currentSessionId

            // Per-subagent completion: if this streamEnd belongs to a tracked
            // subagent, mark it completed immediately rather than waiting for
            // the parent session's stream to end.
            if (resolvedKey) {
              set((state) => {
                const idx = state.activeSubagents.findIndex(
                  a => a.sessionKey === resolvedKey && a.status === 'running'
                )
                if (idx === -1) return state
                const updated = [...state.activeSubagents]
                updated[idx] = { ...updated[idx], status: 'completed' as const }
                return { activeSubagents: updated }
              })
            }

            // Notification / unread logic — works for any session, not just the viewed one
            if (resolvedKey && get().sessionHadChunks[resolvedKey]) {
              const { messages, notificationsEnabled, currentSessionId: activeSession, agents, currentAgentId } = get()
              const agentName = resolveAgentName(resolvedKey, agents, currentAgentId)
              // Only read last message if this is the current session (messages are loaded)
              if (resolvedKey === activeSession) {
                const lastMsg = messages[messages.length - 1]
                if (lastMsg?.role === 'assistant') {
                  const preview = lastMsg.content.slice(0, 100) || (lastMsg.images?.length ? 'Image response' : 'New response')
                  if (shouldNotify(notificationsEnabled, resolvedKey, activeSession)) {
                    Platform.showNotification(`${agentName} responded`, preview).catch(() => { })
                  }
                }
              }

              if (resolvedKey !== activeSession) {
                set((state) => ({
                  unreadCounts: {
                    ...state.unreadCounts,
                    [resolvedKey]: (state.unreadCounts[resolvedKey] || 0) + 1
                  }
                }))
                // Also notify for non-current sessions
                const { notificationsEnabled: ne } = get()
                if (ne) {
                  Platform.showNotification(`${agentName} responded`, `New message in another session`).catch(() => { })
                }
              }
            }

            // Clear per-session streaming state
            if (resolvedKey) {
              set((state) => {
                const { [resolvedKey]: _t, ...restThinking } = state.streamingThinking
                return {
                  streamingSessions: { ...state.streamingSessions, [resolvedKey]: false },
                  sessionHadChunks: { ...state.sessionHadChunks, [resolvedKey]: false },
                  streamingSessionId: state.streamingSessionId === resolvedKey ? null : state.streamingSessionId,
                  streamingThinking: restThinking,
                  compactingSession: state.compactingSession === resolvedKey ? null : state.compactingSession,
                }
              })
            } else {
              set({ streamingSessionId: null })
            }

            // Only stop subagent polling if the current session's stream ended
            if (!sessionKey || !currentSessionId || sessionKey === currentSessionId) {
              get().stopSubagentPolling()
            }
          })

          client.on('thinkingChunk', (payload: unknown) => {
            const { text, cumulative, sessionKey } = payload as {
              text: string; cumulative: boolean; sessionKey?: string
            }
            const { currentSessionId } = get()
            const resolvedKey = sessionKey || currentSessionId
            if (!resolvedKey) return

            const isCurrentSession = !sessionKey || !currentSessionId || sessionKey === currentSessionId
            if (!isCurrentSession) return

            set((state) => {
              const prev = state.streamingThinking[resolvedKey] || ''
              const next = cumulative ? text : prev + text
              return {
                streamingThinking: { ...state.streamingThinking, [resolvedKey]: next }
              }
            })
          })

          client.on('compaction', (payload: unknown) => {
            const { phase, sessionKey } = payload as { phase: string; willRetry: boolean; sessionKey?: string }
            const { currentSessionId } = get()
            const resolvedKey = sessionKey || currentSessionId
            if (!resolvedKey) return

            if (phase === 'start') {
              set({ compactingSession: resolvedKey })
            } else if (phase === 'end') {
              set((state) => ({
                compactingSession: state.compactingSession === resolvedKey ? null : state.compactingSession
              }))
            }
          })

          // When the server reports the canonical session key during streaming,
          // update local state so session lookups and history retrieval use the
          // correct key.
          client.on('streamSessionKey', (payload: unknown) => {
            const { sessionKey } = payload as { runId: string; sessionKey: string }
            if (!sessionKey) return

            const { streamingSessionId, currentSessionId } = get()
            const oldKey = streamingSessionId || currentSessionId
            if (!oldKey || sessionKey === oldKey) return

            set((state) => {
              // Rename the old session to the new key and remove any existing
              // session that already has that key to prevent duplicates.
              let renamed = false
              const sessions = state.sessions.reduce<typeof state.sessions>((acc, s) => {
                const sKey = s.key || s.id
                if (sKey === oldKey && !renamed) {
                  renamed = true
                  acc.push({ ...s, id: sessionKey, key: sessionKey })
                } else if (sKey !== sessionKey) {
                  acc.push(s)
                }
                return acc
              }, [])

              // Migrate ALL per-session keyed state from old key to new key
              const { [oldKey]: wasStreaming, ...restStreaming } = state.streamingSessions
              const { [oldKey]: hadChunks, ...restChunks } = state.sessionHadChunks
              const { [oldKey]: toolCalls, ...restToolCalls } = state.sessionToolCalls
              const { [oldKey]: thinkingText, ...restThinking } = state.streamingThinking
              const { [oldKey]: unreadCount, ...restUnread } = state.unreadCounts

              // Migrate pinned session keys
              const pinnedSessionKeys = state.pinnedSessionKeys.map(k => k === oldKey ? sessionKey : k)

              // Migrate session messages cache
              const cachedMessages = _sessionMessagesCache.get(oldKey)
              if (cachedMessages) {
                _sessionMessagesCache.delete(oldKey)
                _cacheSet(sessionKey, cachedMessages)
              }

              return {
                currentSessionId: state.currentSessionId === oldKey ? sessionKey : state.currentSessionId,
                streamingSessionId: state.streamingSessionId === oldKey ? sessionKey : state.streamingSessionId,
                sessions,
                streamingSessions: wasStreaming !== undefined ? { ...restStreaming, [sessionKey]: wasStreaming } : state.streamingSessions,
                sessionHadChunks: hadChunks !== undefined ? { ...restChunks, [sessionKey]: hadChunks } : state.sessionHadChunks,
                sessionToolCalls: toolCalls !== undefined ? { ...restToolCalls, [sessionKey]: toolCalls } : state.sessionToolCalls,
                streamingThinking: thinkingText !== undefined ? { ...restThinking, [sessionKey]: thinkingText } : state.streamingThinking,
                unreadCounts: unreadCount !== undefined ? { ...restUnread, [sessionKey]: unreadCount } : state.unreadCounts,
                pinnedSessionKeys,
              }
            })
          })

          client.on('toolCall', (payload: unknown) => {
            const tc = payload as { toolCallId: string; name: string; phase: string; result?: string; args?: Record<string, unknown>; meta?: string; sessionKey?: string }
            const { currentSessionId } = get()
            if (tc.sessionKey && currentSessionId && tc.sessionKey !== currentSessionId) return

            // Auto-show/hide canvas panel on canvas tool calls
            if (tc.name === 'canvas' && tc.args) {
              const action = tc.args.action as string | undefined
              if (action === 'present' && get().canvasHostUrl) {
                set({ canvasVisible: true })
              } else if (action === 'hide') {
                set({ canvasVisible: false })
              }
            }

            const toolSessionKey = tc.sessionKey || currentSessionId || ''
            // If server sent meta on result phase but no args, synthesize args for detail display
            const effectiveArgs = tc.args ?? (tc.meta ? { _meta: tc.meta } : undefined)
            set((state) => {
              const currentToolCalls = state.sessionToolCalls[toolSessionKey] || []
              const idx = currentToolCalls.findIndex(t => t.toolCallId === tc.toolCallId)
              if (idx >= 0) {
                const updated = [...currentToolCalls]
                updated[idx] = {
                  ...updated[idx],
                  phase: tc.phase as 'start' | 'result',
                  result: tc.result ?? updated[idx].result,
                  args: effectiveArgs ?? updated[idx].args
                }
                return { sessionToolCalls: { ...state.sessionToolCalls, [toolSessionKey]: updated } }
              }

              // New tool call: finalize the current streaming message so subsequent
              // stream chunks create a new bubble, and link this tool call to it.
              const { messages: finalizedMsgs, finalizedId } = finalizeStreamingMessage(state.messages)
              return {
                messages: finalizedMsgs,
                sessionToolCalls: {
                  ...state.sessionToolCalls,
                  [toolSessionKey]: [...currentToolCalls, {
                    toolCallId: tc.toolCallId,
                    name: tc.name,
                    phase: tc.phase as 'start' | 'result',
                    result: tc.result,
                    args: effectiveArgs,
                    startedAt: Date.now(),
                    afterMessageId: finalizedId || undefined
                  }]
                }
              }
            })
          })

          // Event-driven subagent detection: when the primary session filter
          // blocks an event from a different session, the client emits this.
          client.on('subagentDetected', (payload: unknown) => {
            const { sessionKey } = payload as { sessionKey: string }
            if (!sessionKey) return
            set((state) => {
              // Skip if already tracked
              if (state.activeSubagents.some(a => a.sessionKey === sessionKey)) return state

              // Only surface subagents that belong to the same agent as the current
              // session. Session keys follow "agent:{agentId}:{...}" — a different
              // agentId means this event is from another agent's conversation entirely
              // (e.g. Larry's subagent appearing in Florence's chat). Polling will
              // correctly attribute subagents via server-provided parentSessionId.
              const currentAgentId = (state.currentSessionId || '').split(':')[1]
              const subagentAgentId = sessionKey.split(':')[1]
              if (!currentAgentId || !subagentAgentId || currentAgentId !== subagentAgentId) return state

              const { messages: finalizedMsgs, finalizedId } = finalizeStreamingMessage(state.messages)
              // Anchor to the finalized assistant message, or fall back to the
              // last message of any role so subagents stay inline rather than
              // trailing at the bottom of chat.
              const anchorId = finalizedId || finalizedMsgs[finalizedMsgs.length - 1]?.id
              return {
                messages: finalizedMsgs,
                activeSubagents: [...state.activeSubagents, {
                  sessionKey,
                  parentSessionId: state.currentSessionId || undefined,
                  label: sessionKey,
                  status: 'running' as const,
                  detectedAt: Date.now(),
                  afterMessageId: anchorId || undefined
                }]
              }
            })
          })

          // When the client exhausts its reconnect attempts, stop trying.
          // The user can manually reconnect via settings or by refreshing.
          client.on('reconnectExhausted', () => {
            if (disconnectGraceTimer) {
              clearTimeout(disconnectGraceTimer)
              disconnectGraceTimer = null
            }
            // Discard any queued messages — reconnect failed
            const pending = get().pendingMessages
            if (pending.length > 0) {
              set((state) => ({
                pendingMessages: [],
                messages: [...state.messages, {
                  id: `error-${Date.now()}`,
                  role: 'system' as const,
                  content: `Connection lost. ${pending.length} message${pending.length > 1 ? 's were' : ' was'} not delivered.`,
                  timestamp: new Date().toISOString()
                }]
              }))
            }
            set({ connecting: false, connected: false, streamingSessions: {}, sessionHadChunks: {}, sessionToolCalls: {}, streamingThinking: {}, compactingSession: null, pendingExecApprovals: [] })
            get().stopSubagentPolling()
          })

          // BTW side result (v2026.3.22) — ephemeral inline response
          client.on('sideResult', (payload: unknown) => {
            const { text, sessionKey } = payload as { text: string; sessionKey?: string }
            const { currentSessionId } = get()
            const isCurrentSession = !sessionKey || !currentSessionId || sessionKey === currentSessionId
            if (isCurrentSession && text) {
              set({ sideResult: { text, timestamp: Date.now() } })
            }
          })

          // Rate limit notification: show a toast when the model provider throttles requests
          client.on('rateLimit', () => {
            showToast('Rate limit reached — waiting for provider cooldown', 'warning', 8000)
          })

          // Exec approval notifications: when a tool needs permission, notify the user
          client.on('execApprovalRequested', (payload: unknown) => {
            const data = (payload as any)?.data || payload
            const approvalId = data?.id || data?.approvalId || data?.requestId || `approval-${Date.now()}`
            const command = data?.command || data?.tool || data?.toolName || 'Unknown command'
            const source = data?.source === 'plugin' ? 'plugin' as const : 'exec' as const
            const approval: ExecApprovalRequest = {
              id: approvalId,
              command: typeof command === 'string' ? command : String(command),
              args: Array.isArray(data?.args) ? data.args : undefined,
              cwd: typeof data?.cwd === 'string' ? data.cwd : undefined,
              agent: typeof data?.agent === 'string' ? data.agent : undefined,
              sessionKey: typeof data?.sessionKey === 'string' ? data.sessionKey : undefined,
              source,
              hookId: typeof data?.hookId === 'string' ? data.hookId : undefined,
              toolName: typeof data?.toolName === 'string' ? data.toolName : undefined,
              receivedAt: Date.now(),
              raw: payload
            }
            set((state) => ({
              pendingExecApprovals: [...state.pendingExecApprovals, approval]
            }))
            Platform.showNotification('Exec Approval Required', String(command)).catch(() => { })
          })

          await client.connect()

          // Guard: if a newer connect() was started (e.g. rapid profile switch),
          // discard this stale connection to prevent wrong server's data appearing.
          if (_connectGeneration !== thisGeneration) {
            client.disconnect()
            return
          }

          ; (globalThis as any).__clawdeskClient = client
          set({ client })

          // Fetch initial data
          await Promise.all([
            get().fetchSessions(),
            get().fetchAgents(),
            get().fetchSkills(),
            get().fetchCronJobs(),
            get().fetchHooks()
          ])

          // Start node client if enabled — await so pairing status is known before connect() returns
          if (get().nodeEnabled) {
            // Resolve the node's own device token (separate from operator's token)
            let nodeToken = gatewayToken
            if (serverHost) {
              try {
                const storedNodeToken = await getDeviceToken(serverHost, 'node')
                if (storedNodeToken) nodeToken = storedNodeToken
              } catch { /* ignore */ }
            }

            const nodeClient = new NodeClient(
              serverUrl,
              nodeToken,
              get().authMode,
              wsFactory,
              deviceIdentity,
              get().deviceName || undefined,
              get().nodePermissions
            )
            // Capture generation so stale node client events (from a previous
            // profile) are ignored if the user switches profiles mid-connect.
            const nodeGeneration = thisGeneration
            nodeClient.on('connected', (payload: unknown) => {
              if (_connectGeneration !== nodeGeneration) return
              set({ nodeConnected: true })
              Platform.startForegroundService()
              // Store the node's device token from hello-ok
              if (serverHost && payload && typeof payload === 'object') {
                const helloOk = payload as Record<string, any>
                const dt = helloOk.auth?.deviceToken
                if (typeof dt === 'string' && dt) {
                  saveDeviceToken(serverHost, dt, 'node').catch(() => { })
                }
              }
              // Auto-sync enabled commands to server config
              const opClient = get().client
              if (opClient) syncNodePermissionsToServer(opClient, get().nodePermissions, () => get().connected)
            })
            nodeClient.on('disconnected', () => {
              if (_connectGeneration !== nodeGeneration) return
              set({ nodeConnected: false })
              Platform.stopForegroundService()
            })
            nodeClient.on('pairingRequired', (payload: unknown) => {
              if (_connectGeneration !== nodeGeneration) return
              const { requestId } = (payload || {}) as { requestId?: string; deviceId?: string }
              set({
                pairingStatus: 'pending',
                pairingRequestId: requestId || null,
                showSettings: true
              })
            })
            ;(globalThis as any).__clawdeskNodeClient = nodeClient
            try {
              await nodeClient.connect()
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : ''
              if (errMsg === 'NOT_PAIRED') {
                // Handled by the pairingRequired event above
              } else if (serverHost && nodeToken !== gatewayToken) {
                // Stale node device token — clear and retry with gateway token
                await clearDeviceToken(serverHost, 'node')
                nodeClient.disconnect()
                const retryClient = new NodeClient(
                  serverUrl,
                  gatewayToken,
                  get().authMode,
                  wsFactory,
                  deviceIdentity,
                  get().deviceName || undefined,
                  get().nodePermissions
                )
                retryClient.on('connected', (p: unknown) => {
                  if (_connectGeneration !== nodeGeneration) return
                  set({ nodeConnected: true })
                  Platform.startForegroundService()
                  if (serverHost && p && typeof p === 'object') {
                    const dt = (p as Record<string, any>).auth?.deviceToken
                    if (typeof dt === 'string' && dt) {
                      saveDeviceToken(serverHost, dt, 'node').catch(() => { })
                    }
                  }
                  const opClient = get().client
                  if (opClient) syncNodePermissionsToServer(opClient, get().nodePermissions, () => get().connected)
                })
                retryClient.on('disconnected', () => {
                  if (_connectGeneration !== nodeGeneration) return
                  set({ nodeConnected: false })
                  Platform.stopForegroundService()
                })
                retryClient.on('pairingRequired', (p: unknown) => {
                  if (_connectGeneration !== nodeGeneration) return
                  const { requestId } = (p || {}) as { requestId?: string; deviceId?: string }
                  set({ pairingStatus: 'pending', pairingRequestId: requestId || null, showSettings: true })
                })
                ;(globalThis as any).__clawdeskNodeClient = retryClient
                try {
                  await retryClient.connect()
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : ''
                  if (retryMsg !== 'NOT_PAIRED') {
                    console.warn('[node] Failed to connect after token retry:', retryMsg)
                  }
                }
              } else {
                console.warn('[node] Failed to connect:', errMsg)
              }
            }
          }

          // Reload current session's messages so the chat view is fresh after reconnect
          const { currentSessionId: activeSession, client: freshClient } = get()
          if (activeSession && freshClient) {
            freshClient.getSessionMessages(activeSession).then((historyResult) => {
              const { messages: loadedMessages, toolCalls: historyToolCalls } = historyResult
              _cacheSet(activeSession, loadedMessages)
              set((state) => {
                if (state.currentSessionId !== activeSession) return state
                const streamingMsgs = state.messages.filter(m => m.id.startsWith('streaming-'))
                const mergedToolCalls = historyToolCalls.length > 0
                  ? { ...state.sessionToolCalls, [activeSession]: historyToolCalls.map(tc => ({ ...tc, startedAt: 0 })) }
                  : state.sessionToolCalls
                return {
                  messages: streamingMsgs.length > 0 ? [...loadedMessages, ...streamingMsgs] : loadedMessages,
                  sessionToolCalls: mergedToolCalls
                }
              })
            }).catch(() => { /* best-effort reload */ })
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : ''

          // Don't rethrow pairing errors — the UI handles them via pairingStatus
          if (errMsg === 'NOT_PAIRED') {
            return
          }

          // Stale device identity — clear it and reconnect with a fresh keypair (once)
          if (errMsg === 'DEVICE_IDENTITY_STALE') {
            const retries = (get() as any)._staleIdentityRetries || 0
            if (retries >= 1) {
              console.warn('[connect] Stale device identity retry exhausted, giving up')
                ; (set as any)({ connecting: false, connected: false, _staleIdentityRetries: 0 })
              return
            }
            (set as any)({ _staleIdentityRetries: retries + 1 })
            await clearDeviceIdentity()
            set({ connecting: false })
            return get().connect()
          }

          // Don't rethrow cert errors — the CertErrorModal handles them
          if (errMsg.startsWith('Certificate error')) {
            set({ connecting: false, connected: false })
            return
          }

          // If we used a stored device token and it failed, retry with the gateway token
          if (serverHost && effectiveToken !== gatewayToken) {
            await clearDeviceToken(serverHost)
            set({ connecting: false })
            return get().connect()
          }

          const connectionError = err instanceof Error ? err.message : 'Connection failed'
          set({ connecting: false, connected: false, connectionError })
          throw err
        }
      },

      disconnect: () => {
        if (disconnectGraceTimer) {
          clearTimeout(disconnectGraceTimer)
          disconnectGraceTimer = null
        }
        clearResponseWatchdog()
        const { client } = get()
        client?.disconnect()
        if ((globalThis as any).__clawdeskClient === client) {
          (globalThis as any).__clawdeskClient = null
        }
        // Disconnect node client
        const nodeClient = (globalThis as any).__clawdeskNodeClient as NodeClient | undefined
        if (nodeClient) {
          nodeClient.disconnect()
          ;(globalThis as any).__clawdeskNodeClient = null
        }
        Platform.stopForegroundService()
        set({ client: null, connected: false, pendingMessages: [], nodeConnected: false })
      },

      sendMessage: async (content: string, attachments = []) => {
        const { client, currentSessionId, thinkingEnabled, currentAgentId, sessions } = get()
        const currentSession = sessions.find(s => (s.key || s.id) === currentSessionId)
        const sessionThinkingLevel = currentSession?.thinkingLevel || null
        const trimmed = content.trim()
        if (!client || (!trimmed && attachments.length === 0)) return

        // Intercept slash commands (v2026.3.12)
        if (attachments.length === 0) {
          const parsed = parseSlashCommand(trimmed)
          if (parsed && parsed.command.executeLocal) {
            const result = await get().executeSlashCommand(parsed.command.name, parsed.args)
            if (result) {
              // Show result as a system-style message in chat
              set((state) => ({
                messages: [...state.messages, {
                  id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  role: 'system' as const,
                  content: result.content,
                  timestamp: new Date().toISOString()
                }]
              }))
            }
            return
          }
        }

        let sessionId = currentSessionId
        if (!sessionId) {
          const session = await client.createSession(currentAgentId || undefined)
          sessionId = session.key || session.id
          set((state) => ({
            sessions: [session, ...state.sessions.filter(s => (s.key || s.id) !== sessionId)],
            currentSessionId: sessionId,
            messages: []
          }))
        }

        // Pre-seed the primary session filter so subagent events are dropped
        client.setPrimarySessionKey(sessionId!)

        // Reset chunk dedup state for the new send cycle
        _lastChunkText = ''
        _lastChunkTime = 0

        // Reset streaming state for this session
        // Keep activeSubagents so previous subagent blocks stay visible in chat
        set((state) => {
          const { [sessionId!]: _t, ...restThinking } = state.streamingThinking
          return {
            streamingSessions: { ...state.streamingSessions, [sessionId!]: true },
            sessionHadChunks: { ...state.sessionHadChunks, [sessionId!]: false },
            sessionToolCalls: { ...state.sessionToolCalls, [sessionId!]: [] },
            streamingThinking: restThinking,
            streamingSessionId: sessionId
          }
        })

        // Add user message immediately
        const userMessage: Message = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          content,
          timestamp: new Date().toISOString(),
          images: attachments.length > 0
            ? attachments
                .filter(a => typeof a.previewUrl === 'string' && a.previewUrl.trim())
                .map(a => ({ url: a.previewUrl as string, mimeType: a.mimeType }))
            : undefined
        }
        set((state) => ({ messages: [...state.messages, userMessage] }))

        // Send to server
        try {
          await client.sendMessage({
            sessionId: sessionId,
            content: trimmed,
            agentId: currentAgentId || undefined,
            thinking: thinkingEnabled,
            thinkingLevel: sessionThinkingLevel,
            attachments: attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment)
          })

          // Track message for in-app review prompt (mobile only, fire-and-forget)
          Platform.trackMessageAndMaybeRequestReview()

          // Start response watchdog: if no streaming event arrives within the
          // timeout, the connection is stale. Force-reconnect and retry once.
          {
            const existingWatchdog = responseWatchdogs.get(sessionId!)
            const alreadyRetried = existingWatchdog?.retried ?? false
            clearResponseWatchdog(sessionId!)

            if (alreadyRetried) {
              // This is the retried send — don't set up another watchdog
            } else {
              const watchdogSessionId = sessionId!
              // Capture send-time state for retry so we don't use stale UI state
              const watchdogAgentId = currentAgentId || undefined
              const watchdogThinking = thinkingEnabled
              const watchdogThinkingLevel = sessionThinkingLevel
              const timer = setTimeout(async () => {
                const entry = responseWatchdogs.get(watchdogSessionId)
                if (!entry) return
                const { client: currentClient } = get()

                // Check if the connection is still alive via server tick timestamps
                if (currentClient?.isAlive()) {
                  console.warn('[response-watchdog] No streaming response, but connection is alive (ticks OK) — not reconnecting')
                  clearResponseWatchdog(watchdogSessionId)
                  return
                }

                console.warn('[response-watchdog] No streaming response and connection is stale — reconnecting')
                const retryContent = entry.content
                const retryAttachments = entry.attachments
                // Mark as retried so the re-send doesn't create another watchdog
                responseWatchdogs.set(watchdogSessionId, { ...entry, retried: true })
                // Clear streaming state for the stale session
                set((state) => ({
                  streamingSessions: { ...state.streamingSessions, [watchdogSessionId]: false },
                  streamingSessionId: state.streamingSessionId === watchdogSessionId ? null : state.streamingSessionId
                }))
                clearResponseWatchdog(watchdogSessionId)
                // Force reconnect, then re-send the message directly to the correct session
                try {
                  await get().connect()
                  const retryClient = get().client
                  if (retryClient) {
                    // Use the captured agent/thinking from when the message was originally
                    // sent, not the current UI state — user may have switched sessions.
                    await retryClient.sendMessage({
                      sessionId: watchdogSessionId,
                      content: retryContent.trim(),
                      agentId: watchdogAgentId || undefined,
                      thinking: watchdogThinking,
                      thinkingLevel: watchdogThinkingLevel,
                      attachments: retryAttachments.map(({ previewUrl: _, ...a }: any) => a)
                    })
                    // Re-enable streaming state for the retried session
                    set((state) => ({
                      streamingSessions: { ...state.streamingSessions, [watchdogSessionId]: true },
                      streamingSessionId: watchdogSessionId
                    }))
                  }
                } catch {
                  set((state) => ({
                    messages: [...state.messages, {
                      id: `error-${Date.now()}`,
                      role: 'system' as const,
                      content: 'Message may not have been delivered — connection was stale. Please try again.',
                      timestamp: new Date().toISOString()
                    }]
                  }))
                }
              }, RESPONSE_WATCHDOG_MS)
              responseWatchdogs.set(watchdogSessionId, { timer, content, attachments, sessionId: watchdogSessionId, retried: false, agentId: watchdogAgentId, thinking: watchdogThinking, thinkingLevel: watchdogThinkingLevel })
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Unknown error'
          const isAuthOrScope = errMsg.includes('scope') || errMsg.includes('unauthorized') || errMsg.includes('permission')

          // If we're in the disconnect grace period (still showing connected),
          // queue the message for automatic retry on reconnect instead of showing an error.
          if (!isAuthOrScope && disconnectGraceTimer && sessionId) {
            set((state) => ({
              pendingMessages: [...state.pendingMessages, {
                content,
                attachments,
                sessionId: sessionId!,
                agentId: currentAgentId,
                thinking: thinkingEnabled,
                queuedAt: Date.now()
              }],
              streamingSessions: { ...state.streamingSessions, [sessionId]: false },
              streamingSessionId: null
            }))
            return
          }

          if (sessionId) {
            set((state) => ({
              messages: [...state.messages, {
                id: `error-${Date.now()}`,
                role: 'system' as const,
                content: isAuthOrScope
                  ? `Message failed: ${errMsg}`
                  : 'Message failed to send — connection lost. Reconnecting...',
                timestamp: new Date().toISOString(),
                failedContent: content,
                failedAttachments: attachments
              } as Message],
              streamingSessions: { ...state.streamingSessions, [sessionId]: false },
              streamingSessionId: null
            }))
          }

          // Only reconnect for connection errors, not auth/scope failures
          if (!isAuthOrScope) {
            get().connect().catch(() => { })
          }
        }
      },

      abortChat: async () => {
        const { client, currentSessionId } = get()
        if (!client || !currentSessionId) return
        if (!get().streamingSessions[currentSessionId]) return
        try {
          await client.abortChat(currentSessionId)
        } catch {
          // Abort is best-effort
        }
        set((state) => ({
          streamingSessions: { ...state.streamingSessions, [currentSessionId]: false },
          sessionHadChunks: { ...state.sessionHadChunks, [currentSessionId]: false },
          sessionToolCalls: { ...state.sessionToolCalls, [currentSessionId]: [] },
          streamingSessionId: state.streamingSessionId === currentSessionId ? null : state.streamingSessionId,
        }))
      },

      fetchSessions: async () => {
        const { client } = get()
        if (!client) return
        const serverSessions = await client.listSessions()

        set((state) => {
          // Deduplicate server sessions by key to prevent duplicate React keys
          const seen = new Set<string>()
          const uniqueServerSessions = serverSessions.filter(s => {
            const key = s.key || s.id
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })

          // Filter out spawned subagent sessions and cron sessions — they
          // clutter the sidebar. Subagents are tracked via SubagentBlock.
          // Always keep the currently active session even if it's spawned.
          const nonSpawnedSessions = uniqueServerSessions.filter(s => {
            const key = s.key || s.id
            if (key === state.currentSessionId) return true
            // Hide cron and subagent sessions, but keep agent:X:main (primary agent chats)
            if (/^agent:[^:]+:cron(:|$)/.test(key)) return false
            if (key.includes(':subagent:')) return false
            return !s.spawned && !s.parentSessionId && !s.cron
          })

          // Preserve local-only sessions (created but no message sent yet)
          // that aren't in the server's response — but never duplicate a key
          // that already exists in the server results.
          const allServerKeys = new Set(uniqueServerSessions.map(s => s.key || s.id))
          const keptKeys = new Set(nonSpawnedSessions.map(s => s.key || s.id))
          const localOnly = state.sessions.filter(s => {
            const key = s.key || s.id
            return !keptKeys.has(key) && !allServerKeys.has(key) && key.startsWith('agent:')
          })
          return { sessions: [...nonSpawnedSessions, ...localOnly] }
        })
      },

      fetchAgents: async () => {
        const { client } = get()
        if (!client) return
        const agents = await client.listAgents()
        set({ agents })
        if (agents.length > 0 && !get().currentAgentId) {
          set({ currentAgentId: agents[0].id })
        }
      },

      fetchSkills: async () => {
        const { client } = get()
        if (!client) return
        const skills = await client.listSkills()
        set({ skills })
      },

      fetchCronJobs: async () => {
        const { client } = get()
        if (!client) return
        const cronJobs = await client.listCronJobs()
        set({ cronJobs })
      },

      fetchHooks: async () => {
        const { client } = get()
        if (!client) return
        const { hooks, hooksConfig } = await client.fetchHooks()
        set({ hooks, hooksConfig })
      }
    }),
    {
      name: 'clawcontrol-storage',
      partialize: (state) => ({
        theme: state.theme,
        serverProfiles: state.serverProfiles,
        activeProfileId: state.activeProfileId,
        serverUrl: state.serverUrl,
        authMode: state.authMode,
        deviceName: state.deviceName,
        pinnedSessionKeys: state.pinnedSessionKeys,
        sidebarCollapsed: state.sidebarCollapsed,
        collapsedSessionGroups: state.collapsedSessionGroups,
        thinkingEnabled: state.thinkingEnabled,
        fastModeEnabled: state.fastModeEnabled,
        streamingDisabled: state.streamingDisabled,
        notificationsEnabled: state.notificationsEnabled,
        rightPanelWidth: state.rightPanelWidth,
        canvasWidth: state.canvasWidth,
        nodeEnabled: state.nodeEnabled,
        nodePermissions: state.nodePermissions
      })
    }
  )
)

// Per-session selectors — derive current-session values from the per-session maps.
const _emptyToolCalls: ToolCall[] = []
export const selectIsStreaming = (state: AppState) => !!state.streamingSessions[state.currentSessionId || '']
export const selectHadStreamChunks = (state: AppState) => !!state.sessionHadChunks[state.currentSessionId || '']
export const selectActiveToolCalls = (state: AppState) => state.sessionToolCalls[state.currentSessionId || ''] || _emptyToolCalls
export const selectStreamingThinking = (state: AppState) => state.streamingThinking[state.currentSessionId || ''] || ''
export const selectIsCompacting = (state: AppState) => state.compactingSession === state.currentSessionId
export const selectCurrentSession = (state: AppState) => state.sessions.find(s => (s.key || s.id) === state.currentSessionId)
export const selectSessionFastMode = (state: AppState) => selectCurrentSession(state)?.fastMode ?? false
export const selectSessionThinkingLevel = (state: AppState) => selectCurrentSession(state)?.thinkingLevel ?? null
export const selectSessionModel = (state: AppState) => selectCurrentSession(state)?.model ?? null

// Vite HMR: disconnect stale WebSocket connections when modules are hot-replaced.
// Without this, old module versions keep processing events, causing duplicate streams.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearResponseWatchdog()  // clears all
    const { client } = useStore.getState()
    if (client) {
      client.disconnect()
    }
  })
}
