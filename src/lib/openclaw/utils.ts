// OpenClaw Client - Utility Functions

/**
 * Strip model control tokens leaked into assistant text output (v2026.3.11).
 * Models like GLM-5 and DeepSeek sometimes emit internal delimiter tokens
 * (e.g. `<|assistant|>`, `<|tool_call_result_begin|>`, `<｜begin▁of▁sentence｜>`)
 * in their responses. These should never reach end users.
 */
export function stripModelSpecialTokens(text: string): string {
  if (!text) return text
  // Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
  const cleaned = text.replace(/<[|｜][^|｜]*[|｜]>/g, ' ').replace(/  +/g, ' ').trim()
  return cleaned || text
}

// Strip ANSI escape sequences (colors, cursor movement, mode switches, OSC, etc.)
// so terminal output from tool calls and streaming text renders cleanly in the UI.
// Uses inline regexes to avoid lastIndex state issues with reused global RegExp objects.
export function stripAnsi(text: string): string {
  return text
    // Standard CSI sequences: ESC[ ... final_byte
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC sequences: ESC] ... BEL  or  ESC] ... ST(ESC\)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // ESC + single character sequences (charset selection, etc.)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()#][A-Z0-9]/g, '')
    // Remaining ESC + one character (e.g. ESC>, ESC=, ESCM, etc.)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[A-Z=><!*+\-/]/gi, '')
    // C1 control codes (0x80-0x9F range, e.g. \x9b as CSI)
    // eslint-disable-next-line no-control-regex
    .replace(/\x9b[0-9;?]*[A-Za-z]/g, '')
    // Bell character
    // eslint-disable-next-line no-control-regex
    .replace(/\x07/g, '')
}

// Extract displayable text from a tool result payload.
// The server sends result as { content: [{ type: "text", text: "..." }, ...] }
// or as a plain string (rare). Returns undefined if no text can be extracted.
export function extractToolResultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return undefined

  const record = result as Record<string, unknown>
  const content = Array.isArray(record.content) ? record.content : null
  if (!content) {
    // Maybe the result is { text: "..." } or { output: "..." }
    if (typeof record.text === 'string') return record.text
    if (typeof record.output === 'string') return record.output
    return undefined
  }

  const texts = content
    .filter((c: any) => c && typeof c === 'object' && typeof c.text === 'string')
    .map((c: any) => c.text as string)
  return texts.length > 0 ? texts.join('\n') : undefined
}

export function extractTextFromContent(content: unknown): string {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    // Include text, input_text, and output_text blocks (output_text from xAI Responses API, v2026.3.28)
    text = content
      .filter((c: any) => c.type === 'text' || c.type === 'input_text' || c.type === 'output_text')
      .map((c: any) => c.text)
      .join('')
  } else if (content && typeof content === 'object' && 'text' in content) {
    text = String((content as any).text)
  }
  return stripAnsi(text)
}

/**
 * Check if a string looks like valid base64-encoded data (not shell commands,
 * descriptive text, or other non-base64 content).
 */
function isLikelyBase64(str: string): boolean {
  if (str.length < 20) return false
  // Must not contain characters invalid in base64
  // Shell refs ($, parens, spaces, angle brackets, etc.) are dead giveaways
  if (/[$()<>{}\[\]!?;|&\\]/.test(str)) return false
  // Must not contain spaces (base64 is continuous)
  if (/\s/.test(str.slice(0, 200))) return false
  // Sample first 200 chars — should be exclusively base64 alphabet
  const sample = str.slice(0, 200)
  return /^[A-Za-z0-9+/=]+$/.test(sample)
}

export function extractImagesFromContent(content: unknown): Array<{ url: string; mimeType?: string; alt?: string }> {
  if (!Array.isArray(content)) return []
  const images: Array<{ url: string; mimeType?: string; alt?: string }> = []

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const type = typeof b.type === 'string' ? b.type : ''
    const alt = typeof b.alt === 'string' ? b.alt : undefined
    const blockMime = typeof b.mimeType === 'string' ? b.mimeType : undefined

    const pushDataUrl = (raw: unknown, mime?: string) => {
      if (typeof raw !== 'string') return
      const trimmed = raw.trim()
      if (!trimmed) return
      if (trimmed.startsWith('data:image/')) {
        // Validate that the data URI contains actual base64 after the prefix
        const commaIdx = trimmed.indexOf(',')
        if (commaIdx === -1) return
        const payload = trimmed.slice(commaIdx + 1)
        // For data URIs we already know the prefix is valid, so just check
        // that the payload contains only base64 characters (skip length check)
        if (!payload || /[^A-Za-z0-9+/=\s]/.test(payload.slice(0, 200))) return
        images.push({ url: trimmed, mimeType: mime || blockMime, alt })
        return
      }
      // Only wrap as data URI if it actually looks like base64-encoded data
      if (!isLikelyBase64(trimmed)) return
      const dataMime = (mime || blockMime || 'image/png').trim()
      images.push({ url: `data:${dataMime};base64,${trimmed}`, mimeType: dataMime, alt })
    }

    const pushUrl = (raw: unknown, mime?: string) => {
      if (typeof raw !== 'string') return
      const trimmed = raw.trim()
      if (!trimmed) return
      if (/^https?:\/\//i.test(trimmed)) {
        images.push({ url: trimmed, mimeType: mime || blockMime, alt })
      } else if (/^data:image\//i.test(trimmed)) {
        // Validate data URI has actual base64 payload
        const commaIdx = trimmed.indexOf(',')
        if (commaIdx !== -1 && isLikelyBase64(trimmed.slice(commaIdx + 1))) {
          images.push({ url: trimmed, mimeType: mime || blockMime, alt })
        }
      }
    }

    if (type === 'image' || type === 'input_image' || type === 'output_image') {
      pushUrl(b.url)
      pushDataUrl(b.data)

      const source = b.source as Record<string, unknown> | undefined
      if (source && typeof source === 'object') {
        const sourceType = typeof source.type === 'string' ? source.type : ''
        const sourceMime = typeof source.mediaType === 'string' ? source.mediaType : undefined
        if (sourceType === 'url') {
          pushUrl(source.url, sourceMime)
        } else if (sourceType === 'base64') {
          pushDataUrl(source.data, sourceMime)
        }
      }

      const image = b.image as Record<string, unknown> | undefined
      if (image && typeof image === 'object') {
        pushUrl(image.url)
        pushDataUrl(image.data)
        pushUrl(image.source)
      }
    }
  }

  const seen = new Set<string>()
  return images.filter((img) => {
    if (!img.url || seen.has(img.url)) return false
    seen.add(img.url)
    return true
  })
}

const AUDIO_EXTENSIONS = /\.(mp3|opus|ogg|wav|m4a|aac|webm)$/i
const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|flv|wmv|avi)$/i

/**
 * Parse MEDIA: tokens from message text.
 * OpenClaw agents emit "MEDIA: /path/to/file" lines for generated images/audio/video.
 * This extracts the paths and returns cleaned text with MEDIA lines removed.
 */
export function parseMediaTokens(text: string, gatewayUrl?: string): {
  cleanText: string
  images: Array<{ url: string; mimeType?: string; alt?: string }>
  audioUrls: string[]
  videoUrls: string[]
} {
  const MEDIA_RE = /\bMEDIA:\s*`?([^\n`]+)`?/gi
  const images: Array<{ url: string; mimeType?: string; alt?: string }> = []
  const audioUrls: string[] = []
  const videoUrls: string[] = []
  const cleanLines: string[] = []

  for (const line of text.split('\n')) {
    const matches = Array.from(line.matchAll(MEDIA_RE))
    if (matches.length === 0) {
      cleanLines.push(line)
      continue
    }
    for (const match of matches) {
      let mediaPath = match[1].trim()
      // Strip trailing backtick if present
      if (mediaPath.endsWith('`')) mediaPath = mediaPath.slice(0, -1).trim()
      if (!mediaPath) continue

      const isAudio = AUDIO_EXTENSIONS.test(mediaPath)
      const isVideo = VIDEO_EXTENSIONS.test(mediaPath)

      // Convert local file path to gateway media URL
      if (mediaPath.startsWith('/') && !mediaPath.startsWith('//')) {
        let baseUrl = ''
        if (gatewayUrl) {
          try {
            const u = new URL(gatewayUrl)
            const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
            baseUrl = `${protocol}//${u.host}`
          } catch { /* ignore */ }
        }
        const url = `${baseUrl}/media/${mediaPath.replace(/^\/+/, '')}`
        if (isAudio) {
          audioUrls.push(url)
        } else if (isVideo) {
          videoUrls.push(url)
        } else {
          images.push({ url, alt: mediaPath.split('/').pop() || 'Generated image' })
        }
      } else if (/^data:image\//i.test(mediaPath)) {
        // Validate the data URI contains actual base64 payload
        const commaIdx = mediaPath.indexOf(',')
        if (commaIdx !== -1 && isLikelyBase64(mediaPath.slice(commaIdx + 1))) {
          images.push({ url: mediaPath, alt: 'Generated image' })
        }
      } else if (/^https?:\/\//i.test(mediaPath)) {
        if (isAudio) {
          audioUrls.push(mediaPath)
        } else if (isVideo) {
          videoUrls.push(mediaPath)
        } else {
          images.push({ url: mediaPath, alt: 'Generated image' })
        }
      }
    }
    // Keep non-MEDIA parts of the line if any text remains
    const remainder = line.replace(MEDIA_RE, '').trim()
    if (remainder) cleanLines.push(remainder)
  }

  return { cleanText: cleanLines.join('\n'), images, audioUrls, videoUrls }
}

/**
 * Classify raw media URL strings into images, audio, and video categories.
 * Used when the server sends pre-parsed media URLs (data.mediaUrls) without
 * MEDIA: token text to parse.
 */
export function classifyMediaUrls(urls: string[], gatewayUrl?: string): {
  images: Array<{ url: string; mimeType?: string; alt?: string }>
  audioUrls: string[]
  videoUrls: string[]
} {
  const images: Array<{ url: string; mimeType?: string; alt?: string }> = []
  const audioUrls: string[] = []
  const videoUrls: string[] = []

  for (const rawUrl of urls) {
    if (!rawUrl) continue
    let url = rawUrl

    // Convert local file paths to gateway media URLs
    if (url.startsWith('/') && !url.startsWith('//')) {
      let baseUrl = ''
      if (gatewayUrl) {
        try {
          const u = new URL(gatewayUrl)
          const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
          baseUrl = `${protocol}//${u.host}`
        } catch { /* ignore */ }
      }
      url = `${baseUrl}/media/${url.replace(/^\/+/, '')}`
    }

    if (AUDIO_EXTENSIONS.test(url)) {
      audioUrls.push(url)
    } else if (VIDEO_EXTENSIONS.test(url)) {
      videoUrls.push(url)
    } else {
      images.push({ url, alt: url.split('/').pop() || 'Media' })
    }
  }

  return { images, audioUrls, videoUrls }
}

export function isHeartbeatContent(text: string): boolean {
  const upper = text.toUpperCase()
  return upper.includes('HEARTBEAT_OK') || upper.includes('HEARTBEAT.MD') || upper.includes('CRON: HEARTBEAT')
}

/** Content that is agent noise — not meaningful to display. */
export function isNoiseContent(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === 'NO_REPLY' || trimmed === 'no_reply') return true
  if (isHeartbeatContent(trimmed)) return true
  // Detect agent internal state JSON — objects with keys like lastCheck, checks, notes, etc.
  if (isAgentStateJson(trimmed)) return true
  // Server-injected runtime context blocks — internal metadata not intended for users.
  if (trimmed.startsWith('OpenClaw runtime context (internal)')) return true
  return false
}

/** Detect JSON blobs that are agent internal state/metadata, not user-facing content. */
function isAgentStateJson(text: string): boolean {
  if (!text.startsWith('{') || !text.endsWith('}')) return false
  try {
    const obj = JSON.parse(text)
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false
    const keys = Object.keys(obj)
    // Agent status/check state — contains monitoring-related keys
    const stateKeys = ['lastCheck', 'lastFocus', 'checks', 'notes', 'lastReport', 'lastRun', 'status', 'schedule']
    const matchCount = keys.filter(k => stateKeys.includes(k)).length
    return matchCount >= 2
  } catch {
    return false
  }
}

/**
 * Strip system notification lines injected into streamed text.
 * These are exec status lines like "System: [timestamp] Exec completed (...)"
 * that belong in tool call cards, not in chat text.
 */
/**
 * Strip base64 image data from streaming text to avoid rendering raw encoded data.
 * Replaces inline base64 content with a placeholder that the UI renders as a spinner.
 *
 * Key challenge: base64 data arrives incrementally during streaming, so we must
 * detect partial sequences early — not just complete ones. We handle:
 * - Complete markdown images: ![alt](data:image/...;base64,...)
 * - Complete/partial data URIs: data:image/...;base64,... (truncate from prefix)
 * - Trailing base64 runs: long sequences of [A-Za-z0-9+/=] at the end of text
 */
const BASE64_IMAGE_PLACEHOLDER = '\n\n[__IMAGE_LOADING__]\n\n'

export function stripBase64FromStreaming(text: string): { text: string; hasImages: boolean } {
  let hasImages = false

  // 1. Replace complete markdown images: ![...](data:image/...;base64,...)
  let result = text.replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, () => {
    hasImages = true
    return BASE64_IMAGE_PLACEHOLDER
  })

  // 2. Detect data:image URI prefix — truncate everything from there.
  //    This catches both complete and in-progress (still-streaming) base64 data.
  const dataUriStart = result.search(/data:image\//)
  if (dataUriStart !== -1) {
    hasImages = true
    result = result.slice(0, dataUriStart).trimEnd() + BASE64_IMAGE_PLACEHOLDER
  }

  // 3. Detect trailing base64 blob — a run of 100+ base64 chars at the end of text
  //    with no whitespace or punctuation (natural language would have spaces/periods).
  //    This catches bare base64 that hasn't been prefixed with data:image yet.
  if (!hasImages) {
    const trailingMatch = result.match(/[A-Za-z0-9+/=]{100,}$/)
    if (trailingMatch) {
      // Verify it looks like base64: high ratio of uppercase + digits + /+=
      const sample = trailingMatch[0]
      const b64Chars = (sample.match(/[A-Z0-9+/=]/g) || []).length
      if (b64Chars / sample.length > 0.4) {
        hasImages = true
        result = result.slice(0, trailingMatch.index).trimEnd() + BASE64_IMAGE_PLACEHOLDER
      }
    }
  }

  // 4. Also catch mid-text base64 blobs (already fully streamed)
  if (!hasImages) {
    result = result.replace(/(?:^|\n)[A-Za-z0-9+/]{300,}={0,2}(?:\n|$)/g, () => {
      hasImages = true
      return BASE64_IMAGE_PLACEHOLDER
    })
  }

  // Collapse multiple consecutive placeholders
  result = result.replace(/(\[__IMAGE_LOADING__\]\s*){2,}/g, '[__IMAGE_LOADING__]')

  return { text: result.trim(), hasImages }
}

export function stripSystemNotifications(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^System:\s*\[\d{4}-\d{2}-\d{2}/.test(line.trim()))
    .join('\n')
}

/** Detect cron-triggered user messages (scheduled reminders, updates, etc.) */
export function isCronTriggerContent(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('a scheduled reminder has been triggered') ||
    lower.includes('scheduled update')
}

/**
 * Strip server-injected metadata prefix from user messages loaded via chat.history.
 *
 * The server wraps inbound user messages with two layers:
 * 1. Context blocks — "Conversation info (untrusted metadata):", "Sender (untrusted metadata):",
 *    "Thread starter (untrusted, for context):", etc.  Each block contains a ```json fenced
 *    code block and is separated by blank lines.
 * 2. An envelope line — "[channel user timestamp] <actual message>"
 *
 * We strip all context blocks and the envelope bracket prefix, preserving the user's message.
 */
export function stripConversationMetadata(text: string): string {
  // Strategy 1: Find the envelope line [channel user timestamp] and extract
  // just the user's message after it. This is the most reliable anchor since
  // the metadata format may vary but the envelope is consistent.
  // Pattern: [word(s) YYYY-MM-DD HH:MM TZ] or [word(s) Mon YYYY-MM-DD ...]
  const envelopeMatch = text.match(/\[[\w#: -]+\d{4}-\d{2}-\d{2}\s[^\]]*\]/)
    || text.match(/\[[\w#: -]+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s[^\]]*\]/)
    || text.match(/\[[^\]]{10,80}(?:EST|CST|MST|PST|UTC|GMT|EDT|CDT|MDT|PDT|[A-Z]{2,4})\s*\]/)
  if (envelopeMatch) {
    const afterEnvelope = text.slice(envelopeMatch.index! + envelopeMatch[0].length).trimStart()
    if (afterEnvelope) return afterEnvelope
  }

  // Strategy 2: Strip known metadata patterns for messages without an envelope.
  let stripped = text

  // Strip "...(untrusted...):" blocks with their fenced JSON.
  stripped = stripped.replace(
    /^(?:[^\n]*\(untrusted[^)]*\):[\s\S]*?```\s*\n*)+/,
    ''
  ).trimStart()

  // Strip leading fenced JSON blocks (with optional label and "json" tag).
  stripped = stripped.replace(
    /^(?:[^\n`]*:\s*\n)?```(?:json)?\s*\n[\s\S]*?```\s*\n*/g,
    ''
  ).trimStart()

  // Strip bare "json\n{ ... }" blocks (language tag without fencing).
  stripped = stripped.replace(
    /^json\s*\n\s*\{[^}]*\}\s*\n*/gi,
    ''
  ).trimStart()

  // Strip bare JSON objects that look like metadata.
  stripped = stripped.replace(
    /^\s*\{[^}]*"(?:conversation_label|sender|thread_starter|channel|metadata)"[^}]*\}\s*\n*/g,
    ''
  ).trimStart()

  // Strip envelope bracket prefix if still present.
  if (stripped.startsWith('[')) {
    const bracketEnd = stripped.indexOf(']')
    if (bracketEnd !== -1 && bracketEnd < 100) {
      stripped = stripped.slice(bracketEnd + 1).trimStart()
    }
  }

  return stripped || text
}

export function resolveSessionKey(raw: any): string | null {
  const key =
    raw?.key ||
    raw?.sessionKey ||
    raw?.id ||
    raw?.session?.key ||
    raw?.session?.sessionKey ||
    raw?.session?.id
  return typeof key === 'string' && key.trim() ? key.trim() : null
}

export function toIsoTimestamp(ts: unknown): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts > 1e12 ? ts : ts * 1000
    return new Date(ms).toISOString()
  }
  if (typeof ts === 'string' || ts instanceof Date) {
    const d = new Date(ts as any)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

// Resolve avatar URL - handles relative paths like /avatar/main
export function resolveAvatarUrl(avatar: string | undefined, agentId: string, wsUrl: string): string | undefined {
  if (!avatar) return undefined

  // Already a full URL or data URI
  if (avatar.startsWith('http://') || avatar.startsWith('https://') || avatar.startsWith('data:')) {
    return avatar
  }

  // Server-relative path like /avatar/main - convert to full URL
  if (avatar.startsWith('/avatar/')) {
    try {
      const urlObj = new URL(wsUrl)
      const protocol = urlObj.protocol === 'wss:' ? 'https:' : 'http:'
      return `${protocol}//${urlObj.host}${avatar}`
    } catch {
      return undefined
    }
  }

  // Looks like a valid relative file path - construct avatar URL
  if (avatar.includes('/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(avatar)) {
    try {
      const urlObj = new URL(wsUrl)
      const protocol = urlObj.protocol === 'wss:' ? 'https:' : 'http:'
      return `${protocol}//${urlObj.host}/avatar/${agentId}`
    } catch {
      return undefined
    }
  }

  // Invalid avatar (like single character from parsing error)
  return undefined
}

/**
 * Generate a UUID v4 string.
 * Uses crypto.randomUUID() when available, falls back to a simple
 * implementation for non-secure contexts (e.g., HTTP development).
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Normalize a model value to a display string. Servers can return either a
 * plain string or `{ primary, fallbacks }` (model fallbacks, #23).
 */
export function resolveModel(m: unknown): string | undefined {
  if (typeof m === 'string') return m || undefined
  if (m && typeof m === 'object') {
    const primary = (m as { primary?: unknown }).primary
    if (typeof primary === 'string' && primary) return primary
  }
  return undefined
}
