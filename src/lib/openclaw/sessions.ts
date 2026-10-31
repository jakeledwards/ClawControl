// OpenClaw Client - Session API Methods

import type { Session, RpcCaller } from './types'
import { resolveSessionKey, toIsoTimestamp, isNoiseContent, stripAnsi, generateUUID, resolveModel } from './utils'

// Extract agentId from session key format "agent:{agentId}:{uuid}"
function extractAgentIdFromKey(key?: string): string | undefined {
  if (!key) return undefined
  const parts = key.split(':')
  if (parts[0] === 'agent' && parts.length >= 3) return parts[1]
  return undefined
}

// Subagent sessions use key format "agent:<agentId>:subagent:<uuid>"
function isSubagentKey(key?: string): boolean {
  return !!key && key.includes(':subagent:')
}

// Cron-triggered sessions use key format "agent:<agentId>:cron:<jobName>"
function isCronKey(key?: string): boolean {
  return !!key && key.includes(':cron:')
}

/** Clean up a session's lastMessage preview — strip noise, heartbeats, ANSI, etc. */
function sanitizeLastMessage(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const text = stripAnsi(raw).trim()
  if (!text) return undefined
  if (isNoiseContent(text)) return undefined
  // Strip cron-trigger user messages
  const lower = text.toLowerCase()
  if (lower.includes('a scheduled reminder has been triggered') || lower.includes('scheduled update')) return undefined
  return text
}

export async function listSessions(call: RpcCaller): Promise<Session[]> {
  try {
    const result = await call<any>('sessions.list', {
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 50
    })

    const sessions = Array.isArray(result) ? result : (result?.sessions || [])
    return (Array.isArray(sessions) ? sessions : []).map((s: any) => {
      const key = s.key || s.id
      const spawned = (s.spawned ?? s.isSpawned ?? isSubagentKey(key)) || undefined
      const cron = (s.cron ?? isCronKey(key)) || undefined
      return {
        id: key || `session-${Math.random()}`,
        key,
        title: s.title || s.label || key || 'New Chat',
        agentId: s.agentId || extractAgentIdFromKey(key),
        createdAt: new Date(s.updatedAt || s.createdAt || Date.now()).toISOString(),
        updatedAt: new Date(s.updatedAt || s.createdAt || Date.now()).toISOString(),
        lastMessage: sanitizeLastMessage(s.lastMessagePreview || s.lastMessage),
        spawned,
        cron,
        parentSessionId: s.parentSessionId || s.parentKey || s.spawnedBy || undefined,
        // Session-level directives (v2026.3.12)
        thinkingLevel: s.thinkingLevel || undefined,
        fastMode: s.fastMode ?? undefined,
        verboseLevel: s.verboseLevel || undefined,
        reasoningLevel: s.reasoningLevel || undefined,
        model: resolveModel(s.model),
        modelProvider: s.modelProvider || undefined,
        inputTokens: s.inputTokens ?? undefined,
        outputTokens: s.outputTokens ?? undefined,
        totalTokens: s.totalTokens ?? undefined,
        contextTokens: s.contextTokens ?? undefined,
      }
    })
  } catch {
    return []
  }
}

export async function createSession(agentId?: string): Promise<Session> {
  // In v3, sessions are created lazily on first message.
  // Generate a proper session key in the server's expected format.
  const agent = agentId || 'main'
  const uniqueId = generateUUID()
  const key = `agent:${agent}:${uniqueId}`
  return {
    id: key,
    key,
    title: 'New Chat',
    agentId: agent,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

export async function getSession(call: RpcCaller, sessionKey: string): Promise<Session | null> {
  try {
    const result = await call<any>('sessions.get', { key: sessionKey })
    const s = result?.session || result
    if (!s) return null
    const key = s.key || s.id || sessionKey
    return {
      id: key,
      key,
      title: s.title || s.label || key || 'New Chat',
      agentId: s.agentId || undefined,
      createdAt: new Date(s.updatedAt || s.createdAt || Date.now()).toISOString(),
      updatedAt: new Date(s.updatedAt || s.createdAt || Date.now()).toISOString(),
      lastMessage: s.lastMessagePreview || s.lastMessage || undefined,
      thinkingLevel: s.thinkingLevel || undefined,
      fastMode: s.fastMode ?? undefined,
      verboseLevel: s.verboseLevel || undefined,
      reasoningLevel: s.reasoningLevel || undefined,
      model: resolveModel(s.model),
      modelProvider: s.modelProvider || undefined,
      inputTokens: s.inputTokens ?? undefined,
      outputTokens: s.outputTokens ?? undefined,
      totalTokens: s.totalTokens ?? undefined,
      contextTokens: s.contextTokens ?? undefined,
    }
  } catch {
    return null
  }
}

export async function deleteSession(call: RpcCaller, sessionId: string): Promise<void> {
  await call('sessions.delete', { key: sessionId })
}

export interface SessionPatchParams {
  label?: string | null
  thinkingLevel?: string | null
  fastMode?: boolean | null
  verboseLevel?: string | null
  reasoningLevel?: string | null
  model?: string | null
}

export async function updateSession(call: RpcCaller, sessionId: string, updates: SessionPatchParams): Promise<void> {
  const params: Record<string, unknown> = { key: sessionId }
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) params[k] = v
  }
  await call('sessions.patch', params)
}

export async function compactSession(call: RpcCaller, sessionId: string): Promise<void> {
  await call('sessions.compact', { key: sessionId })
}

export async function spawnSession(call: RpcCaller, agentId: string, prompt?: string): Promise<Session> {
  const result = await call<any>('sessions.spawn', { agentId, prompt })
  const s = result?.session || result || {}
  const key = resolveSessionKey(s) || `spawned-${Date.now()}`
  return {
    id: key,
    key,
    title: s.title || s.label || key,
    agentId: s.agentId || agentId,
    createdAt: toIsoTimestamp(s.createdAt ?? Date.now()),
    updatedAt: toIsoTimestamp(s.updatedAt ?? s.createdAt ?? Date.now()),
    spawned: true,
    parentSessionId: s.parentSessionId || s.parentKey || undefined
  }
}
