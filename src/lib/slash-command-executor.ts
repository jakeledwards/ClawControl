// Slash command execution engine for ClawControl
// Executes local slash commands via gateway RPC methods (v2026.3.12)

import type { OpenClawClient } from './openclaw/client'
import type { Message, Session, Agent } from './openclaw/types'
import { SLASH_COMMANDS } from './slash-commands'

export interface SlashCommandResult {
  /** Markdown-formatted result to display in chat as a system message. */
  content: string
  /** Side-effect action the caller should perform after displaying the result. */
  action?: 'refresh' | 'export' | 'new-session' | 'reset' | 'stop' | 'clear'
}

export async function executeSlashCommand(
  client: OpenClawClient,
  sessionKey: string,
  commandName: string,
  args: string,
  context: {
    sessions: Session[]
    agents: Agent[]
    messages: Message[]
    currentAgentId: string | null
  }
): Promise<SlashCommandResult> {
  switch (commandName) {
    case 'help':
      return executeHelp()
    case 'new':
      return { content: 'Starting a new session.', action: 'new-session' }
    case 'reset':
      // Delete the current session on the server, then create a fresh one
      // with the same agent — this matches OpenClaw's /reset semantics
      // (clears the conversation context server-side, not just locally).
      return { content: 'Resetting session — clearing server state and starting fresh.', action: 'reset' }
    case 'stop':
      return { content: 'Stopping current run...', action: 'stop' }
    case 'clear':
      return { content: 'Chat history cleared.', action: 'clear' }
    case 'compact':
      return await executeCompact(client, sessionKey)
    case 'model':
      return await executeModel(client, sessionKey, args, context)
    case 'think':
      return await executeThink(client, sessionKey, args, context)
    case 'fast':
      return await executeFast(client, sessionKey, args, context)
    case 'verbose':
      return await executeVerbose(client, sessionKey, args, context)
    case 'export':
      return executeExport(context.messages, sessionKey)
    case 'usage':
      return executeUsage(context)
    case 'agents':
      return executeAgents(context.agents)
    case 'kill':
      return await executeKill(client, sessionKey, args)
    default:
      return { content: `Unknown command: \`/${commandName}\`` }
  }
}

function executeHelp(): SlashCommandResult {
  const lines = ['**Available Commands**\n']
  let currentCategory = ''

  for (const cmd of SLASH_COMMANDS) {
    if (cmd.category !== currentCategory) {
      currentCategory = cmd.category
      lines.push(`**${currentCategory.charAt(0).toUpperCase() + currentCategory.slice(1)}**`)
    }
    const argStr = cmd.args ? ` ${cmd.args}` : ''
    lines.push(`\`/${cmd.name}${argStr}\` — ${cmd.description}`)
  }

  lines.push('\nType `/` to open the command menu.')
  return { content: lines.join('\n') }
}

async function executeCompact(client: OpenClawClient, sessionKey: string): Promise<SlashCommandResult> {
  try {
    await client.call('sessions.compact', { key: sessionKey })
    return { content: 'Context compacted successfully.', action: 'refresh' }
  } catch (err) {
    return { content: `Compaction failed: ${String(err)}` }
  }
}

async function executeModel(
  client: OpenClawClient,
  sessionKey: string,
  args: string,
  context: { sessions: Session[] }
): Promise<SlashCommandResult> {
  if (!args) {
    const session = context.sessions.find(s => s.key === sessionKey)
    const model = session?.model || 'default'
    const lines = [`**Current model:** \`${model}\``]

    // Fetch available models via models.list RPC
    try {
      const models = await client.listModels()
      if (models.length > 0) {
        const modelIds = models.map(m => m.id)
        lines.push(
          `**Available:** ${modelIds.slice(0, 10).map(m => `\`${m}\``).join(', ')}` +
          (modelIds.length > 10 ? ` +${modelIds.length - 10} more` : '')
        )
      }
    } catch { /* ignore */ }

    return { content: lines.join('\n') }
  }

  try {
    await client.call('sessions.patch', { key: sessionKey, model: args.trim() })
    return { content: `Model set to \`${args.trim()}\`.`, action: 'refresh' }
  } catch (err) {
    return { content: `Failed to set model: ${String(err)}` }
  }
}

async function executeThink(
  client: OpenClawClient,
  sessionKey: string,
  args: string,
  context: { sessions: Session[] }
): Promise<SlashCommandResult> {
  const level = args.trim().toLowerCase()

  if (!level) {
    const session = context.sessions.find(s => s.key === sessionKey)
    const current = session?.thinkingLevel || 'off'
    return { content: `Current thinking level: **${current}**.\nOptions: off, low, medium, high.` }
  }

  const valid = ['off', 'low', 'medium', 'high', 'xhigh']
  if (!valid.includes(level)) {
    return { content: `Unrecognized thinking level "${level}". Valid levels: ${valid.join(', ')}.` }
  }

  try {
    await client.call('sessions.patch', { key: sessionKey, thinkingLevel: level === 'off' ? null : level })
    return { content: `Thinking level set to **${level}**.`, action: 'refresh' }
  } catch (err) {
    return { content: `Failed to set thinking level: ${String(err)}` }
  }
}

async function executeFast(
  client: OpenClawClient,
  sessionKey: string,
  args: string,
  context: { sessions: Session[] }
): Promise<SlashCommandResult> {
  const mode = args.trim().toLowerCase()

  if (!mode || mode === 'status') {
    const session = context.sessions.find(s => s.key === sessionKey)
    const current = session?.fastMode === true ? 'on' : 'off'
    return { content: `Current fast mode: **${current}**.\nOptions: status, on, off.` }
  }

  if (mode !== 'on' && mode !== 'off') {
    return { content: `Unrecognized fast mode "${args.trim()}". Valid options: status, on, off.` }
  }

  try {
    await client.call('sessions.patch', { key: sessionKey, fastMode: mode === 'on' })
    return { content: `Fast mode ${mode === 'on' ? 'enabled' : 'disabled'}.`, action: 'refresh' }
  } catch (err) {
    return { content: `Failed to set fast mode: ${String(err)}` }
  }
}

async function executeVerbose(
  client: OpenClawClient,
  sessionKey: string,
  args: string,
  context: { sessions: Session[] }
): Promise<SlashCommandResult> {
  const level = args.trim().toLowerCase()

  if (!level) {
    const session = context.sessions.find(s => s.key === sessionKey)
    const current = session?.verboseLevel || 'off'
    return { content: `Current verbose level: **${current}**.\nOptions: off, on, full.` }
  }

  const valid = ['off', 'on', 'full']
  if (!valid.includes(level)) {
    return { content: `Unrecognized verbose level "${level}". Valid levels: ${valid.join(', ')}.` }
  }

  try {
    await client.call('sessions.patch', { key: sessionKey, verboseLevel: level === 'off' ? null : level })
    return { content: `Verbose mode set to **${level}**.`, action: 'refresh' }
  } catch (err) {
    return { content: `Failed to set verbose mode: ${String(err)}` }
  }
}

function executeExport(messages: Message[], sessionKey: string): SlashCommandResult {
  if (messages.length === 0) {
    return { content: 'No messages to export.' }
  }

  const lines: string[] = [`# Chat Export: ${sessionKey}\n`]
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System'
    lines.push(`## ${role}`)
    if (msg.thinking) {
      lines.push(`<details><summary>Thinking</summary>\n\n${msg.thinking}\n\n</details>\n`)
    }
    lines.push(msg.content)
    lines.push('')
  }

  const markdown = lines.join('\n')

  // Copy to clipboard
  navigator.clipboard.writeText(markdown).catch(() => { /* ignore */ })

  return { content: `Exported ${messages.length} messages to clipboard.`, action: 'export' }
}

function executeUsage(context: { sessions: Session[] }): SlashCommandResult {
  // Sum up across all sessions or show current session
  // For simplicity, show aggregate
  let totalInput = 0
  let totalOutput = 0
  for (const s of context.sessions) {
    totalInput += s.inputTokens ?? 0
    totalOutput += s.outputTokens ?? 0
  }
  const total = totalInput + totalOutput

  const lines = [
    '**Token Usage**',
    `Input: **${fmtTokens(totalInput)}** tokens`,
    `Output: **${fmtTokens(totalOutput)}** tokens`,
    `Total: **${fmtTokens(total)}** tokens`,
    `Sessions: **${context.sessions.length}**`,
  ]
  return { content: lines.join('\n') }
}

function executeAgents(agents: Agent[]): SlashCommandResult {
  if (agents.length === 0) {
    return { content: 'No agents configured.' }
  }
  const lines = [`**Agents** (${agents.length})\n`]
  for (const agent of agents) {
    const status = agent.status === 'online' ? '🟢' : agent.status === 'busy' ? '🟡' : '⚫'
    lines.push(`- ${status} \`${agent.id}\` — ${agent.name}`)
  }
  return { content: lines.join('\n') }
}

async function executeKill(client: OpenClawClient, sessionKey: string, args: string): Promise<SlashCommandResult> {
  const target = args.trim()
  if (!target) {
    return { content: 'Usage: `/kill <id|all>`' }
  }

  try {
    // For "all", abort the current session's run
    if (target.toLowerCase() === 'all') {
      await client.call('chat.abort', { sessionKey })
      return { content: 'Aborted all active runs.' }
    }
    // Try to abort a specific session
    await client.call('chat.abort', { sessionKey: target })
    return { content: `Aborted session \`${target}\`.` }
  } catch (err) {
    return { content: `Failed to abort: ${String(err)}` }
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
