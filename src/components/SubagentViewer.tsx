import { useState, useRef, useEffect, useMemo } from 'react'
import { OpenClawClient, Message, stripAnsi } from '../lib/openclaw'
import { resolveToolDisplay, extractToolDetail } from '../lib/openclaw/tool-display'
import { ToolIcon } from './ToolIcon'
import { SafeMarkdown } from './SafeMarkdown'

interface ToolCallInfo {
  toolCallId: string
  name: string
  phase: 'start' | 'result'
  result?: string
  args?: Record<string, unknown>
  startedAt: number
}

export function SubagentViewer({
  sessionKey,
  serverUrl,
  authToken,
  authMode
}: {
  sessionKey: string
  serverUrl: string
  authToken: string
  authMode: 'token' | 'password'
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const clientRef = useRef<OpenClawClient | null>(null)

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, toolCalls])

  useEffect(() => {
    const client = new OpenClawClient(serverUrl, authToken, authMode)
    clientRef.current = client

    // Lock this client to only process events for our session
    client.setPrimarySessionKey(sessionKey)

    client.on('connected', () => {
      setConnectionStatus('connected')

      // Fetch history for the session
      client.getSessionMessages(sessionKey).then((result) => {
        setMessages(result.messages)
      }).catch(() => {})
    })

    client.on('disconnected', () => {
      setConnectionStatus('disconnected')
      setIsStreaming(false)
    })

    client.on('streamStart', () => {
      setIsStreaming(true)
      setStreamingText('')
      setToolCalls([])
    })

    client.on('streamChunk', (chunkArg: unknown) => {
      const chunk = (chunkArg && typeof chunkArg === 'object')
        ? chunkArg as { text?: string; sessionKey?: string }
        : { text: String(chunkArg) }
      const text = chunk.text || ''
      if (!text) return
      setStreamingText((prev) => prev + text)
    })

    client.on('streamEnd', () => {
      setIsStreaming(false)
      // Refresh history to get the canonical final message
      client.getSessionMessages(sessionKey).then((result) => {
        setMessages(result.messages)
        setStreamingText('')
        setToolCalls([])
      }).catch(() => {})
    })

    client.on('message', (msgArg: unknown) => {
      const msg = msgArg as Message
      setMessages((prev) => {
        const exists = prev.some(m => m.id === msg.id)
        if (exists) return prev.map(m => m.id === msg.id ? msg : m)
        return [...prev, msg]
      })
      setStreamingText('')
      setIsStreaming(false)
    })

    client.on('toolCall', (payload: unknown) => {
      const tc = payload as { toolCallId: string; name: string; phase: string; result?: string; args?: Record<string, unknown> }
      setToolCalls((prev) => {
        const idx = prev.findIndex(t => t.toolCallId === tc.toolCallId)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = {
            ...updated[idx],
            phase: tc.phase as 'start' | 'result',
            result: tc.result,
            args: tc.args ?? updated[idx].args
          }
          return updated
        }
        return [...prev, {
          toolCallId: tc.toolCallId,
          name: tc.name,
          phase: tc.phase as 'start' | 'result',
          result: tc.result,
          args: tc.args,
          startedAt: Date.now()
        }]
      })
    })

    client.connect().catch(() => {
      setConnectionStatus('disconnected')
    })

    return () => {
      client.disconnect()
      clientRef.current = null
    }
  }, [sessionKey, serverUrl, authToken, authMode])

  const filteredMessages = useMemo(
    () => messages.filter((m) => m.role !== 'system'),
    [messages]
  )

  return (
    <div className="subagent-viewer" data-theme="dark">
      <div className="subagent-viewer-header">
        <div className="subagent-viewer-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2zm-4 12a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm8 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />
          </svg>
          <span>Subagent</span>
        </div>
        <div className={`subagent-viewer-status ${connectionStatus}`}>
          <span className="status-dot-small" />
          {connectionStatus === 'connecting' ? 'Connecting...' : connectionStatus === 'connected' ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      <div className="subagent-viewer-chat">
        <div className="subagent-viewer-messages">
          {filteredMessages.map((msg) => (
            <ViewerMessage key={msg.id} message={msg} />
          ))}

          {toolCalls.length > 0 && (
            <div className="tool-calls-container">
              {toolCalls.map((tc) => (
                <ViewerToolCall key={tc.toolCallId} toolCall={tc} />
              ))}
            </div>
          )}

          {streamingText && (
            <div className="message agent">
              <div className="message-content">
                <div className="message-bubble">
                  <ViewerMarkdown content={streamingText} />
                </div>
              </div>
            </div>
          )}

          {isStreaming && !streamingText && (
            <div className="message agent">
              <div className="message-content">
                <div className="typing-indicator">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>
    </div>
  )
}

function ViewerMessage({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`message ${isUser ? 'user' : 'agent'}`}>
      <div className="message-content">
        <div className="message-header">
          <span className="message-author">{isUser ? 'User' : 'Assistant'}</span>
        </div>
        <div className="message-bubble">
          {message.thinking && (
            <div className="thinking-block">
              <div className="thinking-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                <span>Thinking...</span>
              </div>
              <div className="thinking-content">{message.thinking}</div>
            </div>
          )}
          <ViewerMarkdown content={message.content} />
        </div>
      </div>
    </div>
  )
}

function ViewerMarkdown({ content }: { content: string }) {
  return <SafeMarkdown content={content} />
}

function ViewerToolCall({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = toolCall.phase === 'start'
  const display = resolveToolDisplay(toolCall.name)
  const detail = extractToolDetail(toolCall.args, display.detailKeys)

  return (
    <div className={`tool-call-block ${isRunning ? 'running' : 'completed'}`}>
      <button className="tool-call-header tool-call-main" onClick={() => setExpanded(!expanded)}>
        {isRunning ? (
          <svg className="tool-call-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        ) : (
          <ToolIcon type={display.icon} size={14} className="tool-call-icon" />
        )}
        <span className="tool-call-label">{display.title}</span>
        {detail && <span className="tool-call-detail">{detail}</span>}
        <span className="tool-call-status">{isRunning ? 'Running...' : 'Done'}</span>
        <svg className={`tool-call-chevron ${expanded ? 'expanded' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {expanded && toolCall.result && (
        <div className="tool-call-result">
          <pre>{stripAnsi(toolCall.result)}</pre>
        </div>
      )}
    </div>
  )
}
