import { useRef, useEffect, useMemo, Fragment, memo } from 'react'
import { useStore, selectIsStreaming, selectHadStreamChunks, selectActiveToolCalls, ToolCall, SubagentInfo } from '../store'
import { Message, stripAnsi } from '../lib/openclaw'
import { resolveToolDisplay, extractToolDetail } from '../lib/openclaw/tool-display'
import { ToolIcon } from './ToolIcon'
import { SubagentBlock } from './SubagentBlock'
import { SafeMarkdown } from './SafeMarkdown'
import { format, isSameDay } from 'date-fns'
import logoUrl from '../../build/icon.png'

export function ChatArea() {
  const { messages: allMessages, agents, currentAgentId, sessions, currentSessionId, activeSubagents, openSubagentPopout, openToolCallPopout } = useStore()
  const isStreaming = useStore(selectIsStreaming)
  const hadStreamChunks = useStore(selectHadStreamChunks)
  const activeToolCalls = useStore(selectActiveToolCalls)
  const messages = useMemo(
    () => allMessages.filter((m) => m.role !== 'system'),
    [allMessages]
  )
  const chatEndRef = useRef<HTMLDivElement>(null)
  // Track session switches so we can instant-scroll when history loads
  const prevSessionRef = useRef(currentSessionId)
  const needsInstantScroll = useRef(true)

  // Resolve agent from the current session's agentId (e.g. from key "agent:jerry:...")
  // so each chat shows the correct agent name/avatar, not just the globally selected one.
  const currentSession = sessions.find(s => (s.key || s.id) === currentSessionId)
  const sessionAgentId = currentSession?.agentId || currentAgentId
  const currentAgent = agents.find((a) => a.id === sessionAgentId)

  // Build lookup maps: tool calls and subagents grouped by afterMessageId
  // Must be before the early return to satisfy Rules of Hooks.
  const toolCallsByMessageId = useMemo(() => {
    const map = new Map<string, ToolCall[]>()
    for (const tc of activeToolCalls) {
      const key = tc.afterMessageId || '__trailing__'
      const list = map.get(key)
      if (list) list.push(tc)
      else map.set(key, [tc])
    }
    return map
  }, [activeToolCalls])

  const subagentsByMessageId = useMemo(() => {
    const map = new Map<string, SubagentInfo[]>()
    for (const sa of activeSubagents) {
      // Only show subagents belonging to this session
      if (sa.parentSessionId && sa.parentSessionId !== currentSessionId) continue
      const key = sa.afterMessageId || '__trailing__'
      const list = map.get(key)
      if (list) list.push(sa)
      else map.set(key, [sa])
    }
    return map
  }, [activeSubagents, currentSessionId])

  // Mark session switches so the next render with messages jumps instantly
  useEffect(() => {
    if (prevSessionRef.current !== currentSessionId) {
      prevSessionRef.current = currentSessionId
      needsInstantScroll.current = true
    }
  }, [currentSessionId])

  // Scroll to bottom: instant on history load, smooth for incremental updates
  useEffect(() => {
    if (messages.length === 0) return
    const behavior = needsInstantScroll.current ? 'instant' : 'smooth'
    needsInstantScroll.current = false
    chatEndRef.current?.scrollIntoView({ behavior })
  }, [messages, activeToolCalls, activeSubagents])

  if (messages.length === 0) {
    return (
      <div className="chat-area">
        <div className="chat-empty">
          <div className="empty-logo">
            <img src={logoUrl} alt="ClawControl logo" />
          </div>
          <h2>Start a Conversation</h2>
          <p>Send a message to begin chatting with {currentAgent?.name || 'the AI assistant'}</p>
          <div className="quick-actions">
            <button className="quick-action">
              <span>Explain a concept</span>
            </button>
            <button className="quick-action">
              <span>Help me code</span>
            </button>
            <button className="quick-action">
              <span>Analyze data</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-area">
      <div className="chat-container">
        {messages.map((message, index) => {
          const isNewDay = index === 0 || !isSameDay(new Date(message.timestamp), new Date(messages[index - 1].timestamp))
          const msgToolCalls = toolCallsByMessageId.get(message.id)
          const msgSubagents = subagentsByMessageId.get(message.id)

          return (
            <Fragment key={message.id}>
              {isNewDay && <DateSeparator date={new Date(message.timestamp)} />}
              {msgToolCalls && msgToolCalls.length > 0 && openToolCallPopout && (
                <ToolCallBubble
                  toolCalls={msgToolCalls}
                  agentAvatar={currentAgent?.avatar}
                  agentName={currentAgent?.name}
                  onOpenPopout={openToolCallPopout}
                />
              )}
              <MessageBubble
                message={message}
                agentName={currentAgent?.name}
                agentAvatar={currentAgent?.avatar}
              />
              {msgSubagents && (
                <div className="subagents-container">
                  {msgSubagents.map((sa) => (
                    <SubagentBlock key={sa.sessionKey} subagent={sa} onOpen={openSubagentPopout} />
                  ))}
                </div>
              )}
            </Fragment>
          )
        })}

        {/* Trailing tool calls and subagents (no afterMessageId) */}
        {toolCallsByMessageId.has('__trailing__') && openToolCallPopout && (
          <ToolCallBubble
            toolCalls={toolCallsByMessageId.get('__trailing__')!}
            agentAvatar={currentAgent?.avatar}
            agentName={currentAgent?.name}
            onOpenPopout={openToolCallPopout}
          />
        )}
        {subagentsByMessageId.has('__trailing__') && (
          <div className="subagents-container">
            {subagentsByMessageId.get('__trailing__')!.map((sa) => (
              <SubagentBlock key={sa.sessionKey} subagent={sa} onOpen={openSubagentPopout} />
            ))}
          </div>
        )}

        {isStreaming && !hadStreamChunks && (
          <div className="message agent typing-indicator-container">
            <div className="message-avatar">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2zm-4 12a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm8 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />
              </svg>
            </div>
            <div className="message-content">
              <div className="typing-indicator">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>
    </div>
  )
}

function DateSeparator({ date }: { date: Date }) {
  let dateText = ''
  try {
    dateText = format(date, 'EEEE, MMMM d, yyyy')
  } catch (e) {
    return null
  }

  return (
    <div className="date-separator">
      <span>{dateText}</span>
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({
  message,
  agentName,
  agentAvatar,
}: {
  message: Message
  agentName?: string
  agentAvatar?: string
}) {
  const isUser = message.role === 'user'
  const time = format(new Date(message.timestamp), 'h:mm a')

  return (
    <div className={`message ${isUser ? 'user' : 'agent'}`}>
      {!isUser && (
        <div className="message-avatar">
          {agentAvatar ? (
            <img src={agentAvatar} alt={agentName || 'Agent'} />
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2zm-4 12a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm8 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />
            </svg>
          )}
        </div>
      )}

      <div className="message-content">
        <div className="message-header">
          {isUser ? (
            <>
              <span className="message-time">{time}</span>
              <span className="message-author">You</span>
            </>
          ) : (
            <>
              <span className="message-author">{agentName || 'Assistant'}</span>
              <span className="message-time">{time}</span>
            </>
          )}
        </div>
        <div className="message-bubble">
          {message.thinking && (
            <div className="thinking-block">
              <div className="thinking-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                <span>Thinking...</span>
              </div>
              <div className="thinking-content">{message.thinking}</div>
            </div>
          )}
          <MessageContent content={message.content} />
        </div>
      </div>

      {isUser && (
        <div className="message-avatar user-avatar">
          <span>You</span>
        </div>
      )}
    </div>
  )
})

/** Renders a group of tool calls in their own agent-style bubble */
function ToolCallBubble({ toolCalls, agentAvatar, agentName, onOpenPopout }: {
  toolCalls: ToolCall[]
  agentAvatar?: string
  agentName?: string
  onOpenPopout: (id: string) => void
}) {
  return (
    <div className="message agent tool-call-bubble">
      <div className="message-avatar">
        {agentAvatar ? (
          <img src={agentAvatar} alt={agentName || 'Agent'} />
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2zm-4 12a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm8 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />
          </svg>
        )}
      </div>
      <div className="message-content">
        <div className="message-bubble">
          {toolCalls.map((tc) => (
            <ToolCallBlock key={tc.toolCallId} toolCall={tc} onOpenPopout={onOpenPopout} />
          ))}
        </div>
      </div>
    </div>
  )
}

const TOOL_INLINE_THRESHOLD = 80
const TOOL_PREVIEW_MAX = 100

function getTruncatedPreview(text: string): string {
  const lines = text.split('\n')
  const preview = lines.slice(0, 2).join('\n')
  if (preview.length > TOOL_PREVIEW_MAX) return preview.slice(0, TOOL_PREVIEW_MAX) + '\u2026'
  if (lines.length > 2) return preview + '\u2026'
  return preview
}

function ToolCallBlock({ toolCall, onOpenPopout }: { toolCall: ToolCall; onOpenPopout: (id: string) => void }) {
  const isRunning = toolCall.phase === 'start'
  const display = resolveToolDisplay(toolCall.name)
  const detail = extractToolDetail(toolCall.args, display.detailKeys)
  const resultText = toolCall.result ? stripAnsi(toolCall.result).trim() : ''
  const hasText = resultText.length > 0
  const isShort = hasText && resultText.length <= TOOL_INLINE_THRESHOLD
  const showCollapsed = hasText && !isShort
  const showInline = hasText && isShort
  const isEmpty = !hasText && !isRunning

  const canClick = hasText || isEmpty
  const handleClick = () => {
    if (hasText) {
      onOpenPopout(toolCall.toolCallId)
    }
  }

  return (
    <div
      className={`chat-tool-card${canClick && !isRunning ? ' chat-tool-card--clickable' : ''}`}
      onClick={canClick && !isRunning ? handleClick : undefined}
      role={canClick && !isRunning ? 'button' : undefined}
      tabIndex={canClick && !isRunning ? 0 : undefined}
      onKeyDown={canClick && !isRunning ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() }
      } : undefined}
    >
      <div className="chat-tool-card__header">
        <div className="chat-tool-card__title">
          <span className="chat-tool-card__icon">
            {isRunning ? (
              <svg className="spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <ToolIcon type={display.icon} size={14} />
            )}
          </span>
          <span>{display.title}</span>
        </div>
        {!isRunning && hasText && (
          <span className="chat-tool-card__action">
            <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        )}
        {isEmpty && (
          <span className="chat-tool-card__status">
            <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        )}
        {isRunning && (
          <span className="chat-tool-card__running-text">Running&hellip;</span>
        )}
      </div>
      {detail && <div className="chat-tool-card__detail">{detail}</div>}
      {isEmpty && <div className="chat-tool-card__status-text muted">Completed</div>}
      {isRunning && <div className="chat-tool-card__status-text muted">In progress&hellip;</div>}
      {showCollapsed && (
        <div className="chat-tool-card__preview mono">{getTruncatedPreview(resultText)}</div>
      )}
      {showInline && (
        <div className="chat-tool-card__inline mono">{resultText}</div>
      )}
    </div>
  )
}

function MessageContent({ content }: { content: string }) {
  return <SafeMarkdown content={content} />
}
