// OpenClaw Client - Agent API Methods

import type { Agent, RpcCaller } from './types'
import { resolveAvatarUrl } from './utils'

export async function listAgents(call: RpcCaller, wsUrl: string): Promise<Agent[]> {
  try {
    const result = await call<any>('agents.list')
    const agents = Array.isArray(result) ? result : (result?.agents || result?.items || result?.list || [])

    // Fetch all agent identities in parallel
    const identityResults = await Promise.allSettled(
      agents.map((a: any) => {
        const agentId = String(a.agentId || a.id || a.key || a.slug || 'main')
        const identity = a.identity || {}
        if (identity.name || identity.avatar) return Promise.resolve(null)
        return call<any>('agent.identity.get', { agentId })
      })
    )

    // Enrich each agent with identity results
    const enrichedAgents: Agent[] = agents.map((a: any, i: number) => {
      const agentId = String(a.agentId || a.id || a.key || a.slug || 'main')
      let identity = a.identity || {}

      const result = identityResults[i]
      if (result.status === 'fulfilled' && result.value) {
        identity = {
          name: result.value.name,
          emoji: result.value.emoji,
          avatar: result.value.avatar,
          avatarUrl: result.value.avatarUrl
        }
      }

      // Resolve avatar URL
      const avatarUrl = resolveAvatarUrl(identity.avatarUrl || identity.avatar, agentId, wsUrl)

      // Clean up emoji - filter out placeholder text
      let emoji = identity.emoji
      if (emoji && (emoji.includes('none') || emoji.includes('*') || emoji.length > 4)) {
        emoji = undefined
      }

      // Prefer config name (a.name) over identity name — the server's
      // agent.identity.get can return the wrong name for non-main agents.
      return {
        id: agentId,
        name: String(a.name || identity.name || agentId || 'Unnamed Agent'),
        description: a.description || identity.theme ? String(a.description || identity.theme) : undefined,
        status: a.status || 'online',
        avatar: avatarUrl,
        emoji,
        theme: identity.theme,
        model: a.model || a.config?.model || undefined,
        thinkingLevel: a.thinkingLevel || a.config?.thinkingLevel || a.thinking || undefined,
        timeout: a.timeout ?? a.config?.timeout ?? undefined,
        configured: a.configured ?? a.config?.configured ?? undefined
      }
    })

    return enrichedAgents
  } catch {
    return []
  }
}

export async function getAgentIdentity(call: RpcCaller, agentId: string): Promise<{ name?: string; emoji?: string; avatar?: string; avatarUrl?: string } | null> {
  try {
    return await call<any>('agent.identity.get', { agentId })
  } catch {
    return null
  }
}

export async function getAgentFiles(call: RpcCaller, agentId: string): Promise<{ workspace: string; files: Array<{ name: string; path: string; missing: boolean; size?: number }> } | null> {
  // Surface errors to the caller — silently returning null hides server failures.
  return await call<any>('agents.files.list', { agentId })
}

export async function getAgentFile(call: RpcCaller, agentId: string, fileName: string): Promise<{ content?: string; missing: boolean } | null> {
  const result = await call<any>('agents.files.get', { agentId, name: fileName })
  return result?.file || null
}

export async function setAgentFile(call: RpcCaller, agentId: string, fileName: string, content: string): Promise<boolean> {
  // Throws on failure so the caller can show the server's error message.
  // Previously returned false silently, which discarded user edits without warning.
  await call<any>('agents.files.set', { agentId, name: fileName, content })
  return true
}

export interface CreateAgentParams {
  name: string
  workspace: string
  model?: string
  emoji?: string
  avatar?: string
  avatarFileName?: string
}

export interface CreateAgentResult {
  ok: boolean
  agentId: string
  name: string
  workspace: string
}

// Normalize agent name to a safe ID (mirrors server-side normalizeAgentId)
export function normalizeAgentId(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'main'
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  return normalized || 'main'
}

/**
 * Reads the full server config via config.get.
 * Returns the raw config object and the hash needed for config.patch.
 */
export async function getConfig(call: RpcCaller): Promise<{ config: any; hash: string }> {
  const result = await call<any>('config.get', {})

  // config.get returns a ConfigFileSnapshot: { config, hash, path, exists, valid, ... }
  // Extract the config object and hash, with defensive fallbacks
  const config = result?.config ?? null
  const hash = result?.hash ?? ''

  return { config, hash }
}

/**
 * Create a new agent by patching the server config.
 *
 * This ONLY patches the config (adds the agent entry to agents.list).
 * It does NOT write IDENTITY.md because config.patch triggers a server
 * restart, and agents.files.set won't work until the server comes back
 * with the new config loaded. The caller (store) handles writing
 * IDENTITY.md after reconnection.
 */
export async function createAgent(call: RpcCaller, params: CreateAgentParams): Promise<CreateAgentResult> {
  const agentId = normalizeAgentId(params.name)
  if (agentId === 'main') {
    throw new Error('"main" is reserved and cannot be used as an agent name')
  }

  // 1. Get current config and hash
  const { config, hash } = await getConfig(call)

  if (!config || typeof config !== 'object') {
    throw new Error('Failed to read server config — config.get returned unexpected data')
  }
  if (!hash) {
    throw new Error('Failed to read config hash — config.get did not return a baseHash')
  }

  // 2. Extract the existing agents list — must preserve every entry
  const agentsSection = config.agents || {}
  const existingList: any[] = Array.isArray(agentsSection.list) ? agentsSection.list : []

  // 3. Check for duplicates
  if (existingList.some((a: any) => normalizeAgentId(a.id || a.name || '') === agentId)) {
    throw new Error(`Agent "${agentId}" already exists`)
  }

  // 4. Build the new agent config entry
  const newAgent: Record<string, any> = {
    id: agentId,
    name: params.name.trim(),
    workspace: params.workspace.trim()
  }
  if (params.model) {
    newAgent.model = params.model
  }

  // 5. Build patch — ONLY touch agents.list, preserve everything else via merge patch
  //    Send ONLY { agents: { list: [...] } } so the merge patch:
  //      - recursively enters the agents object (it's a plain object)
  //      - replaces the list array with our full new array
  //      - leaves agents.defaults and all other config sections untouched
  const newList = [...existingList, newAgent]
  const patch = { agents: { list: newList } }

  await call<any>('config.patch', { raw: JSON.stringify(patch), baseHash: hash })

  return {
    ok: true,
    agentId,
    name: params.name.trim(),
    workspace: params.workspace.trim()
  }
}

export interface DeleteAgentResult {
  ok: boolean
  agentId: string
}

/**
 * Delete an agent by removing it from the server config's agents.list.
 * Config-only — does not clean up workspace files.
 */
export async function deleteAgent(call: RpcCaller, agentId: string): Promise<DeleteAgentResult> {
  if (agentId === 'main') {
    throw new Error('Cannot delete the "main" agent')
  }

  const { config, hash } = await getConfig(call)

  if (!config || typeof config !== 'object') {
    throw new Error('Failed to read server config — config.get returned unexpected data')
  }
  if (!hash) {
    throw new Error('Failed to read config hash — config.get did not return a baseHash')
  }

  const agentsSection = config.agents || {}
  const existingList: any[] = Array.isArray(agentsSection.list) ? agentsSection.list : []

  const filteredList = existingList.filter(
    (a: any) => normalizeAgentId(a.id || a.name || '') !== agentId
  )

  if (filteredList.length === existingList.length) {
    throw new Error(`Agent "${agentId}" not found in config`)
  }

  const patch = { agents: { list: filteredList } }

  await call<any>('config.patch', { raw: JSON.stringify(patch), baseHash: hash })

  return { ok: true, agentId }
}

/**
 * Build the IDENTITY.md content string for a new agent.
 */
export function buildIdentityContent(params: {
  name: string
  emoji?: string
  avatar?: string
  agentId?: string
  avatarFileName?: string
}): string {
  const lines = [`- **Name:** ${params.name.trim()}`]
  if (params.emoji) lines.push(`- **Emoji:** ${params.emoji}`)

  // Reference avatar by workspace-relative path instead of embedding data URI
  if (params.avatarFileName && params.agentId) {
    lines.push(`- **Avatar:** avatars/${params.agentId}/${params.avatarFileName}`)
  } else if (params.avatar && !params.avatar.startsWith('data:')) {
    // Allow non-data-URI values (e.g. http URLs) to pass through
    lines.push(`- **Avatar:** ${params.avatar}`)
  }

  return lines.join('\n') + '\n'
}
