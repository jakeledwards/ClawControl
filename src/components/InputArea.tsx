import { useState, useRef, useEffect, useCallback, KeyboardEvent, ChangeEvent, CompositionEvent } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'
import { useStore, selectIsStreaming } from '../store'
import { getPlatform, isNativeMobile } from '../lib/platform'
import { getSlashCommandCompletions, type SlashCommandDef } from '../lib/slash-commands'

type BrowserSpeechRecognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: any) => void) | null
  onresult: ((event: any) => void) | null
}

type NativeRecognitionMode = 'none' | 'wake' | 'dictation'
type PendingImageAttachment = {
  id: string
  fileName: string
  mimeType: string
  content: string
  previewUrl: string
}

const DEFAULT_WAKE_TRIGGERS = ['openclaw', 'claude', 'computer']
const WAKE_COOLDOWN_MS = 3000
const MAX_IMAGE_BYTES = 5_000_000

function joinDictatedText(existing: string, dictated: string): string {
  const trimmed = dictated.trim()
  if (!trimmed) return existing
  const separator = existing && !/\s$/.test(existing) ? ' ' : ''
  return `${existing}${separator}${trimmed}`
}

function getBrowserSpeechRecognitionCtor(): (new () => BrowserSpeechRecognition) | null {
  const win = window as any
  return win.SpeechRecognition || win.webkitSpeechRecognition || null
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeWakeTriggers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_WAKE_TRIGGERS
  const cleaned = raw
    .map(item => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter(Boolean)
  return cleaned.length > 0 ? cleaned : DEFAULT_WAKE_TRIGGERS
}

function containsWakeTrigger(text: string, triggers: string[]): boolean {
  const source = text.toLowerCase()
  return triggers.some(trigger => {
    const pattern = new RegExp(`(^|\\s|[.,!?;:])${escapeRegex(trigger)}($|\\s|[.,!?;:])`, 'i')
    return pattern.test(source)
  })
}

export function InputArea() {
  const [message, setMessage] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [wakeEnabled, setWakeEnabled] = useState(false)
  const [wakeTriggers, setWakeTriggers] = useState<string[]>(DEFAULT_WAKE_TRIGGERS)
  const [attachedImages, setAttachedImages] = useState<PendingImageAttachment[]>([])
  const [slashCompletions, setSlashCompletions] = useState<SlashCommandDef[]>([])
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const nativeSpeechAvailableRef = useRef(false)
  const electronSpeechAvailableRef = useRef(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const textareaFocusedRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dictationBrowserRecognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const wakeBrowserRecognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const nativeModeRef = useRef<NativeRecognitionMode>('none')
  const messageBeforeDictationRef = useRef('')
  const wakeCooldownUntilRef = useRef(0)
  const wakeRestartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeEnabledRef = useRef(false)
  const wakeTriggersRef = useRef<string[]>(DEFAULT_WAKE_TRIGGERS)
  const voiceSupportedRef = useRef(false)
  const connectedRef = useRef(false)
  const isStreamingRef = useRef(false)
  const isListeningRef = useRef(false)
  const clientRef = useRef<any>(null)

  const { sendMessage, abortChat, connected, client, draftMessage, setDraftMessage } = useStore()
  const isStreaming = useStore(selectIsStreaming)
  const platform = getPlatform()
  // Mic/voice button is hidden on native mobile (iOS + Android); desktop and web
  // keep it since speech recognition works there. The attach button is shown on
  // every platform, docked inside the composer field.
  const hideVoiceButton = platform === 'ios' || platform === 'android'

  const maxLength = 4000

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result)
        else reject(new Error('Failed to read image data'))
      }
      reader.onerror = () => reject(new Error('Failed to read image data'))
      reader.readAsDataURL(file)
    })

  useEffect(() => { wakeEnabledRef.current = wakeEnabled }, [wakeEnabled])
  useEffect(() => { wakeTriggersRef.current = wakeTriggers }, [wakeTriggers])
  useEffect(() => { voiceSupportedRef.current = voiceSupported }, [voiceSupported])
  useEffect(() => { connectedRef.current = connected }, [connected])
  useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])
  useEffect(() => { isListeningRef.current = isListening }, [isListening])
  useEffect(() => { clientRef.current = client }, [client])

  const clearWakeRestartTimer = () => {
    if (wakeRestartTimeoutRef.current) {
      clearTimeout(wakeRestartTimeoutRef.current)
      wakeRestartTimeoutRef.current = null
    }
  }

  const shouldListenWake = () =>
    wakeEnabledRef.current &&
    voiceSupportedRef.current &&
    connectedRef.current &&
    !isStreamingRef.current &&
    !isListeningRef.current &&
    !(isNativeMobile() && textareaFocusedRef.current)

  const scheduleWakeRestart = () => {
    clearWakeRestartTimer()
    wakeRestartTimeoutRef.current = setTimeout(() => {
      wakeRestartTimeoutRef.current = null
      void maybeStartWakeRecognition()
    }, 700)
  }

  const stopWakeRecognition = async () => {
    clearWakeRestartTimer()

    const wakeBrowser = wakeBrowserRecognitionRef.current
    if (wakeBrowser) {
      wakeBrowser.onstart = null
      wakeBrowser.onend = null
      wakeBrowser.onerror = null
      wakeBrowser.onresult = null
      wakeBrowser.stop()
      wakeBrowserRecognitionRef.current = null
    }

    if (isNativeMobile() && nativeModeRef.current === 'wake') {
      try {
        const { listening } = await SpeechRecognition.isListening()
        if (listening) await SpeechRecognition.stop()
      } catch {
        // ignore
      }
      await SpeechRecognition.removeAllListeners().catch(() => {})
      nativeModeRef.current = 'none'
    }
  }

  const stopDictationRecognition = async () => {
    const dictationBrowser = dictationBrowserRecognitionRef.current
    if (dictationBrowser) {
      dictationBrowser.onstart = null
      dictationBrowser.onend = null
      dictationBrowser.onerror = null
      dictationBrowser.onresult = null
      dictationBrowser.stop()
      dictationBrowserRecognitionRef.current = null
    }

    if (isNativeMobile() && nativeModeRef.current === 'dictation') {
      try {
        const { listening } = await SpeechRecognition.isListening()
        if (listening) await SpeechRecognition.stop()
      } catch {
        // ignore
      }
      await SpeechRecognition.removeAllListeners().catch(() => {})
      nativeModeRef.current = 'none'
    }

    setIsListening(false)
  }

  const stopAllRecognition = async () => {
    await stopDictationRecognition()
    await stopWakeRecognition()
  }

  const ensureNativePermissions = async () => {
    const { available } = await SpeechRecognition.available()
    if (!available) {
      throw new Error('Speech recognition is not available on this device.')
    }
    const permissionState = await SpeechRecognition.checkPermissions()
    if (permissionState.speechRecognition === 'granted') return
    const requested = await SpeechRecognition.requestPermissions()
    if (requested.speechRecognition !== 'granted') {
      throw new Error('Microphone permission is required for voice input.')
    }
  }

  const beginWakeCapture = async () => {
    if (!shouldListenWake()) return
    wakeCooldownUntilRef.current = Date.now() + WAKE_COOLDOWN_MS
    await stopWakeRecognition()
    try {
      if (nativeSpeechAvailableRef.current) {
        await startNativeDictation()
      } else {
        startBrowserDictation()
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Voice input failed. Please try again.'
      setVoiceError(errMsg)
      setIsListening(false)
      nativeModeRef.current = 'none'
      scheduleWakeRestart()
    }
  }

  const startBrowserWakeRecognition = () => {
    if (wakeBrowserRecognitionRef.current) return
    const ctor = getBrowserSpeechRecognitionCtor()
    if (!ctor) return

    const recognition = new ctor()
    recognition.lang = 'en-US'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onresult = (event: any) => {
      if (Date.now() < wakeCooldownUntilRef.current) return
      const transcript = Array.from(event.results ?? [])
        .map((result: any) => result?.[0]?.transcript || '')
        .join(' ')
        .trim()
      if (!transcript) return
      if (containsWakeTrigger(transcript, wakeTriggersRef.current)) {
        void beginWakeCapture()
      }
    }

    recognition.onerror = () => {
      wakeBrowserRecognitionRef.current = null
      if (shouldListenWake()) scheduleWakeRestart()
    }

    recognition.onend = () => {
      wakeBrowserRecognitionRef.current = null
      if (shouldListenWake() && Date.now() >= wakeCooldownUntilRef.current) {
        scheduleWakeRestart()
      }
    }

    wakeBrowserRecognitionRef.current = recognition
    try {
      recognition.start()
    } catch {
      wakeBrowserRecognitionRef.current = null
    }
  }

  const startNativeWakeRecognition = async () => {
    if (nativeModeRef.current !== 'none') return
    if (Date.now() < wakeCooldownUntilRef.current) {
      scheduleWakeRestart()
      return
    }

    await ensureNativePermissions()
    nativeModeRef.current = 'wake'
    await SpeechRecognition.removeAllListeners().catch(() => {})

    await SpeechRecognition.addListener('partialResults', (data) => {
      if (!shouldListenWake() || Date.now() < wakeCooldownUntilRef.current) return
      const transcript = (data.matches || []).join(' ').trim()
      if (!transcript) return
      if (containsWakeTrigger(transcript, wakeTriggersRef.current)) {
        void beginWakeCapture()
      }
    })

    await SpeechRecognition.addListener('listeningState', ({ status }) => {
      if (status === 'stopped' && nativeModeRef.current === 'wake') {
        nativeModeRef.current = 'none'
        if (shouldListenWake() && Date.now() >= wakeCooldownUntilRef.current) {
          scheduleWakeRestart()
        }
      }
    })

    try {
      await SpeechRecognition.start({
        language: 'en-US',
        maxResults: 3,
        popup: false,
        partialResults: true,
      })
    } catch {
      nativeModeRef.current = 'none'
      await SpeechRecognition.removeAllListeners().catch(() => {})
      if (shouldListenWake()) scheduleWakeRestart()
    }
  }

  const maybeStartWakeRecognition = async () => {
    if (!shouldListenWake()) return
    if (Date.now() < wakeCooldownUntilRef.current) {
      scheduleWakeRestart()
      return
    }
    try {
      if (nativeSpeechAvailableRef.current) {
        await startNativeWakeRecognition()
      } else {
        startBrowserWakeRecognition()
      }
    } catch {
      // No-op: wake listening is best-effort.
    }
  }

  const startBrowserDictation = () => {
    const ctor = getBrowserSpeechRecognitionCtor()
    if (!ctor) {
      throw new Error('Speech recognition is not available on this platform.')
    }

    const recognition = new ctor()
    messageBeforeDictationRef.current = message
    recognition.lang = 'en-US'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setIsListening(true)
      setVoiceError(null)
    }

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results ?? [])
        .map((result: any) => result?.[0]?.transcript || '')
        .join(' ')
        .trim()
      if (!transcript) return
      setMessage(joinDictatedText(messageBeforeDictationRef.current, transcript).slice(0, maxLength))
      setVoiceError(null)
    }

    recognition.onerror = (event: any) => {
      const code = event?.error || 'unknown'
      console.warn('Speech recognition error:', code)
      const messages: Record<string, string> = {
        'not-allowed': 'Microphone access was denied. Please allow microphone permission.',
        'service-not-allowed': 'Speech recognition service is not available.',
        'network': 'Network error during speech recognition.',
        'no-speech': 'No speech was detected. Please try again.',
        'audio-capture': 'No microphone was found. Please check your audio settings.',
        'aborted': 'Speech recognition was aborted.',
      }
      setVoiceError(messages[code] || `Voice input failed (${code}). Please try again.`)
      setIsListening(false)
      dictationBrowserRecognitionRef.current = null
      void maybeStartWakeRecognition()
    }

    recognition.onend = () => {
      setIsListening(false)
      dictationBrowserRecognitionRef.current = null
      void maybeStartWakeRecognition()
    }

    dictationBrowserRecognitionRef.current = recognition
    recognition.start()
  }

  const startNativeDictation = async () => {
    await ensureNativePermissions()
    await SpeechRecognition.removeAllListeners().catch(() => {})
    nativeModeRef.current = 'dictation'
    messageBeforeDictationRef.current = message
    setIsListening(true)
    setVoiceError(null)

    try {
      const result = await SpeechRecognition.start({
        language: 'en-US',
        maxResults: 1,
        prompt: 'Speak now',
        popup: getPlatform() === 'android',
        partialResults: false,
      })
      const transcript = result.matches?.[0]?.trim()
      if (transcript) {
        setMessage(joinDictatedText(messageBeforeDictationRef.current, transcript).slice(0, maxLength))
      }
    } finally {
      await SpeechRecognition.removeAllListeners().catch(() => {})
      nativeModeRef.current = 'none'
      setIsListening(false)
      void maybeStartWakeRecognition()
    }
  }

  const startElectronDictation = async () => {
    const api = (window as any).electronAPI
    if (!api?.speechRecognize) throw new Error('Electron speech API not available.')
    messageBeforeDictationRef.current = message
    setIsListening(true)
    setVoiceError(null)
    try {
      const result = await api.speechRecognize(15)
      if (result.error) {
        throw new Error(result.error)
      }
      const transcript = result.text?.trim()
      if (transcript) {
        setMessage(joinDictatedText(messageBeforeDictationRef.current, transcript).slice(0, maxLength))
      }
    } finally {
      setIsListening(false)
      void maybeStartWakeRecognition()
    }
  }

  const stopElectronDictation = async () => {
    const api = (window as any).electronAPI
    if (api?.speechStop) {
      await api.speechStop()
    }
    setIsListening(false)
  }

  useEffect(() => {
    let cancelled = false

    const detectVoiceSupport = async () => {
      // Check Electron native speech (Windows System.Speech)
      if (getPlatform() === 'electron' && (window as any).electronAPI?.speechAvailable) {
        try {
          const available = await (window as any).electronAPI.speechAvailable()
          if (available) {
            electronSpeechAvailableRef.current = true
            if (!cancelled) setVoiceSupported(true)
            return
          }
        } catch {
          // Fall through
        }
      }

      if (isNativeMobile()) {
        try {
          const { available } = await SpeechRecognition.available()
          if (available) {
            nativeSpeechAvailableRef.current = true
            if (!cancelled) setVoiceSupported(true)
            return
          }
        } catch (err) {
          console.warn('Native speech recognition not available, trying browser fallback:', err)
        }
        // Fall through to browser check — Android WebView often supports webkitSpeechRecognition
      }
      if (!cancelled) setVoiceSupported(Boolean(getBrowserSpeechRecognitionCtor()))
    }

    detectVoiceSupport()
    return () => {
      cancelled = true
      void stopAllRecognition()
    }
  }, [])

  useEffect(() => {
    if (!client) return
    let cancelled = false

    const syncWakeConfig = async () => {
      try {
        const status = await client.getVoicewake()
        if (cancelled) return
        setWakeEnabled(Boolean(status?.enabled))
        setWakeTriggers(normalizeWakeTriggers(status?.triggers))
      } catch {
        // leave defaults
      }
    }

    const onWakeChanged = (payload: any) => {
      if (!payload) return
      setWakeTriggers(normalizeWakeTriggers(payload?.triggers))
    }

    syncWakeConfig()
    client.on('voicewake.changed', onWakeChanged)
    return () => {
      cancelled = true
      client.off('voicewake.changed', onWakeChanged)
    }
  }, [client])

  useEffect(() => {
    if (shouldListenWake()) {
      void maybeStartWakeRecognition()
    } else {
      void stopWakeRecognition()
    }
    // Cleanup: stop any wake recognition started by this effect cycle
    // to prevent duplicate listeners when dependencies change rapidly
    return () => {
      void stopWakeRecognition()
    }
  }, [wakeEnabled, wakeTriggers, voiceSupported, connected, isStreaming, isListening])

  useEffect(() => {
    if (draftMessage) {
      setMessage(draftMessage)
      setDraftMessage('')
      textareaRef.current?.focus()
    }
  }, [draftMessage])

  useEffect(() => {
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [message])

  // Slash command autocomplete
  const updateSlashCompletions = useCallback((text: string) => {
    if (text.startsWith('/') && !text.includes(' ') && !text.includes('\n')) {
      const filter = text.slice(1)
      const completions = getSlashCommandCompletions(filter)
      setSlashCompletions(completions)
      setSlashSelectedIndex(0)
    } else {
      setSlashCompletions([])
    }
  }, [])

  const insertSlashCommand = useCallback((cmd: SlashCommandDef) => {
    const text = `/${cmd.name}${cmd.args ? ' ' : ''}`
    setMessage(text)
    setSlashCompletions([])
    textareaRef.current?.focus()
  }, [])

  const handleSubmit = async () => {
    // Read from the DOM to catch any text still in the Android IME
    // composition buffer that hasn't been committed to React state yet.
    const currentMessage = textareaRef.current?.value || message
    if (!currentMessage.trim() && attachedImages.length === 0) return

    composingRef.current = false
    setSlashCompletions([])
    const currentAttachments = attachedImages
    setMessage('')
    if (textareaRef.current) textareaRef.current.value = ''
    setAttachedImages([])
    await sendMessage(currentMessage, currentAttachments)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command menu navigation
    if (slashCompletions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex(i => Math.min(i + 1, slashCompletions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        insertSlashCommand(slashCompletions[slashSelectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashCompletions([])
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing) {
        // On Android, Enter during English swipe composition should still send.
        // CJK IMEs use Enter to confirm characters, but for non-CJK the user
        // expects Enter to submit. handleSubmit reads from the DOM to capture
        // any in-flight composition text.
        if (isNativeMobile()) {
          e.preventDefault()
          handleSubmit()
        }
        return
      }
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleTextareaFocus = () => {
    textareaFocusedRef.current = true
    // Release the microphone so the keyboard's voice button can use it
    if (isNativeMobile()) void stopWakeRecognition()
  }

  const handleTextareaBlur = () => {
    textareaFocusedRef.current = false
    // Clear stuck composition state (e.g. if compositionend never fired)
    composingRef.current = false
    // Debounce wake restart so tapping the voice button (blur then click)
    // doesn't briefly start the wake listener before dictation stops it.
    // stopWakeRecognition() cancels this timer if dictation starts first.
    scheduleWakeRestart()
  }

  const handleCompositionStart = () => {
    composingRef.current = true
  }

  const handleCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false
    // Android IME: compositionend fires after onChange, so sync the final value now
    const val = (e.target as HTMLTextAreaElement).value
    if (val.length > maxLength) {
      setMessage(val.slice(0, maxLength))
    } else {
      setMessage(val)
    }
    if (voiceError) setVoiceError(null)
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    // On desktop, skip state update during IME composition to avoid fighting
    // the keyboard buffer. On Android, always update — compositionend fires
    // unreliably on many keyboards (Gboard gesture, auto-suggest) which can
    // leave composingRef stuck true, blocking all input.
    if (composingRef.current && platform !== 'android') return
    const val = e.target.value
    if (val.length > maxLength) {
      setMessage(val.slice(0, maxLength))
      updateSlashCompletions(val.slice(0, maxLength))
    } else {
      setMessage(val)
      updateSlashCompletions(val)
    }
    if (voiceError) setVoiceError(null)
  }

  const handleVoiceInput = async () => {
    if (!voiceSupported || isStreaming) return

    if (isListening) {
      if (electronSpeechAvailableRef.current) {
        await stopElectronDictation()
      } else {
        await stopDictationRecognition()
      }
      await maybeStartWakeRecognition()
      return
    }

    try {
      await stopWakeRecognition()
      if (electronSpeechAvailableRef.current) {
        await startElectronDictation()
      } else if (nativeSpeechAvailableRef.current) {
        await startNativeDictation()
      } else {
        startBrowserDictation()
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Voice input failed. Please try again.'
      setVoiceError(errMsg)
      setIsListening(false)
      nativeModeRef.current = 'none'
      await maybeStartWakeRecognition()
    }
  }

  const handleAttachClick = () => {
    fileInputRef.current?.click()
  }

  const handleRemoveAttachment = (id: string) => {
    setAttachedImages((current) => current.filter((img) => img.id !== id))
  }

  const handleFileSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    const next: PendingImageAttachment[] = []
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (file.size > MAX_IMAGE_BYTES) {
        setVoiceError(`Image ${file.name} exceeds ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(1)}MB limit.`)
        continue
      }

      try {
        const dataUrl = await readFileAsDataUrl(file)
        const content = dataUrl.includes(',') ? dataUrl.split(',')[1] || '' : ''
        if (!content) continue
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          content,
          previewUrl: dataUrl,
        })
      } catch {
        setVoiceError(`Failed to process ${file.name}`)
      }
    }

    if (next.length > 0) {
      setAttachedImages((current) => [...current, ...next])
      setVoiceError(null)
    }
    e.target.value = ''
  }

  return (
    <div className="input-area" data-testid="input-area">
      {attachedImages.length > 0 && (
        <div className="image-attachments" aria-label="Attached images">
          {attachedImages.map((img) => (
            <div key={img.id} className="image-attachment-item">
              <img src={img.previewUrl} alt={img.fileName} />
              <button
                type="button"
                className="image-attachment-remove"
                onClick={() => handleRemoveAttachment(img.id)}
                aria-label={`Remove ${img.fileName}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {slashCompletions.length > 0 && (
        <div className="slash-command-menu" role="listbox" aria-label="Slash commands">
          {slashCompletions.map((cmd, i) => (
            <button
              key={cmd.name}
              role="option"
              aria-selected={i === slashSelectedIndex}
              className={`slash-command-item${i === slashSelectedIndex ? ' selected' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); insertSlashCommand(cmd) }}
              onMouseEnter={() => setSlashSelectedIndex(i)}
            >
              <span className="slash-command-name">/{cmd.name}</span>
              {cmd.args && <span className="slash-command-args">{cmd.args}</span>}
              <span className="slash-command-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="input-container">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelected}
          style={{ display: 'none' }}
        />
        <div className="composer-field">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={handleTextareaFocus}
            onBlur={handleTextareaBlur}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder="Type a message or /"
            rows={1}
            aria-label="Message input"
            data-testid="message-input"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
          />
          <button
            className="attach-inline-btn"
            onClick={handleAttachClick}
            disabled={isStreaming}
            aria-label="Attach images"
            title="Attach images"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        {!hideVoiceButton && (
          <button
            className={`voice-btn${isListening ? ' listening' : ''}`}
            onClick={handleVoiceInput}
            disabled={!voiceSupported || isStreaming}
            aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
            title={isListening ? 'Stop voice input' : 'Voice input'}
          >
            {isListening ? (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
                <path d="M19 11a7 7 0 0 1-14 0" />
                <path d="M12 18v3" />
              </svg>
            )}
          </button>
        )}
        {isStreaming ? (
          <button
            className="send-btn stop-btn"
            data-testid="stop-btn"
            onClick={abortChat}
            aria-label="Stop generation"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            className="send-btn"
            data-testid="send-btn"
            onClick={handleSubmit}
            disabled={!message.trim() && attachedImages.length === 0}
            aria-label="Send message"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        )}
      </div>
      <div className="input-footer">
        <span className="char-count">
          <span className={message.length > maxLength * 0.95 ? 'danger' : message.length > maxLength * 0.9 ? 'warning' : message.length > maxLength * 0.75 ? 'caution' : ''}>
            {message.length}
          </span>
          {' '}/{' '}{maxLength}
        </span>
        {voiceError ? (
          <span className="voice-error" role="status">
            {voiceError}
            {!hideVoiceButton && (
              <button
                type="button"
                className="voice-retry-btn"
                onClick={() => { setVoiceError(null); handleVoiceInput() }}
                aria-label="Retry voice input"
              >
                Retry
              </button>
            )}
          </span>
        ) : (
          <span className="keyboard-hint">
            Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
          </span>
        )}
      </div>
    </div>
  )
}
