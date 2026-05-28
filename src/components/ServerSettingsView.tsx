import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store'

type Tab = 'agent-defaults' | 'tools-memory' | 'channels' | 'features'

const TABS: { id: Tab; label: string }[] = [
  { id: 'agent-defaults', label: 'Agent Defaults' },
  { id: 'tools-memory', label: 'Tools & Memory' },
  { id: 'channels', label: 'Channels' },
  { id: 'features', label: 'Features' },
]

const THINKING_OPTIONS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const VERBOSE_OPTIONS = ['off', 'on', 'full']
const ELEVATED_OPTIONS = ['off', 'on', 'ask', 'full']
const TIME_FORMAT_OPTIONS = ['auto', '12', '24']
const COMPACTION_OPTIONS = ['default', 'safeguard']
const HUMAN_DELAY_OPTIONS = ['off', 'natural', 'custom']
const TOOLS_PROFILE_OPTIONS = ['minimal', 'coding', 'messaging', 'full']
const EXEC_HOST_OPTIONS = ['sandbox', 'gateway', 'node']
const MEMORY_BACKEND_OPTIONS = ['sqlite', 'qmd']
const MEMORY_CITATIONS_OPTIONS = ['auto', 'on', 'off']
const MEMORY_SEARCH_PROVIDER_OPTIONS = ['local', 'openai', 'gemini', 'voyage']

const CHANNEL_IDS = ['whatsapp', 'telegram', 'discord', 'slack', 'signal', 'imessage', 'mattermost'] as const
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  signal: 'Signal',
  imessage: 'iMessage',
  mattermost: 'Mattermost',
}
const POLICY_OPTIONS = ['off', 'on', 'allowlist']

/** Deep-get a value from a nested object by dot-separated path. */
function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj)
}

/** Deep-set a value in a nested object by dot-separated path (immutable). */
function setPath(obj: any, path: string, value: any): any {
  const keys = path.split('.')
  if (keys.length === 1) {
    return { ...obj, [keys[0]]: value }
  }
  const [head, ...rest] = keys
  return { ...obj, [head]: setPath(obj?.[head] ?? {}, rest.join('.'), value) }
}

/** Build a minimal patch object from original config and edited config. */
function buildPatch(original: any, edited: any, paths: string[]): object | null {
  let patch: any = null
  for (const path of paths) {
    const orig = getPath(original, path)
    const edit = getPath(edited, path)
    if (edit !== orig) {
      // Skip if both are undefined (no change)
      if (edit === undefined && orig === undefined) continue
      if (!patch) patch = {}
      // Build nested object for this path
      const keys = path.split('.')
      let current = patch
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {}
        current = current[keys[i]]
      }
      // Use null to signal "clear this setting" when user removes a value
      current[keys[keys.length - 1]] = edit !== undefined ? edit : null
    }
  }
  return patch
}

/** All editable setting paths for dirty-tracking. */
const ALL_PATHS = [
  // Agent Defaults
  'agents.defaults.model.primary',
  'agents.defaults.thinkingDefault',
  'agents.defaults.verboseDefault',
  'agents.defaults.elevatedDefault',
  'agents.defaults.userTimezone',
  'agents.defaults.timeFormat',
  'agents.defaults.contextTokens',
  'agents.defaults.timeoutSeconds',
  'agents.defaults.maxConcurrent',
  'agents.defaults.workspace',
  'agents.defaults.mediaMaxMb',
  'agents.defaults.subagents.maxConcurrent',
  'agents.defaults.compaction.mode',
  'agents.defaults.humanDelay.mode',
  // Tools & Memory
  'tools.profile',
  'tools.web.search.enabled',
  'tools.web.search.maxResults',
  'tools.web.fetch.enabled',
  'tools.web.fetch.maxChars',
  'tools.exec.host',
  'tools.exec.timeoutSec',
  'tools.elevated.enabled',
  'memory.backend',
  'memory.citations',
  'agents.defaults.memorySearch.enabled',
  'agents.defaults.memorySearch.provider',
  // Channel paths added dynamically
  ...CHANNEL_IDS.flatMap(ch => [
    `channels.${ch}.enabled`,
    `channels.${ch}.dmPolicy`,
    `channels.${ch}.groupPolicy`,
    `channels.${ch}.historyLimit`,
  ]),
]

export function ServerSettingsView() {
  const { client, closeDetailView } = useStore()
  const [tab, setTab] = useState<Tab>('agent-defaults')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<'success' | 'error' | null>(null)
  const [validating, setValidating] = useState(false)
  const [validationErrors, setValidationErrors] = useState<Array<{ path: string; message: string }> | null>(null)
  const [configErrors, setConfigErrors] = useState<Array<{ path: string; message: string }> | null>(null)

  // The original config from the server (read-only reference)
  const [originalConfig, setOriginalConfig] = useState<any>(null)
  const [baseHash, setBaseHash] = useState('')
  // The edited config (user's working copy)
  const [editedConfig, setEditedConfig] = useState<any>(null)

  const saveResultTimeout = useRef<ReturnType<typeof setTimeout>>()

  const loadConfig = useCallback(async () => {
    if (!client) return
    setLoading(true)
    setError(null)
    try {
      const result = await client.getServerConfig()
      setOriginalConfig(result.config)
      setEditedConfig(result.config)
      setBaseHash(result.hash)

      // Probe the server's view of its own config with an empty dry-run patch.
      // If the existing config has validation errors, surface them so the user
      // knows why saves may be rejected with "invalid config; fix before patching".
      try {
        const probe = await client.validateServerConfig({}, result.hash)
        if (!probe.valid && probe.errors?.length) {
          setConfigErrors(probe.errors)
        } else {
          setConfigErrors(null)
        }
      } catch {
        // Older server without dry-run support — silently skip
        setConfigErrors(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    }
    setLoading(false)
  }, [client])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (saveResultTimeout.current) clearTimeout(saveResultTimeout.current)
    }
  }, [])

  const isDirty = useCallback(() => {
    if (!originalConfig || !editedConfig) return false
    return ALL_PATHS.some(p => getPath(originalConfig, p) !== getPath(editedConfig, p))
  }, [originalConfig, editedConfig])

  const setValue = useCallback((path: string, value: any) => {
    setEditedConfig((prev: any) => setPath(prev, path, value))
    setSaveResult(null)
  }, [])

  const handleDiscard = useCallback(() => {
    setEditedConfig(originalConfig)
    setSaveResult(null)
  }, [originalConfig])

  const handleSave = useCallback(async () => {
    if (!client || !editedConfig || !originalConfig) return

    const patch = buildPatch(originalConfig, editedConfig, ALL_PATHS)
    if (!patch) return

    setSaving(true)
    setSaveResult(null)
    try {
      await client.patchServerConfig(patch, baseHash)

      // config.patch triggers server restart — wait for reconnect
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

      // Reload config to get fresh hash and confirm values
      const result = await client.getServerConfig()
      setOriginalConfig(result.config)
      setEditedConfig(result.config)
      setBaseHash(result.hash)
      setSaveResult('success')
    } catch (err) {
      setSaveResult('error')
      setError(err instanceof Error ? err.message : 'Failed to save config')
    }
    setSaving(false)

    if (saveResultTimeout.current) clearTimeout(saveResultTimeout.current)
    saveResultTimeout.current = setTimeout(() => setSaveResult(null), 4000)
  }, [client, editedConfig, originalConfig, baseHash])

  const handleValidate = useCallback(async () => {
    if (!client || !editedConfig || !originalConfig) return
    const patch = buildPatch(originalConfig, editedConfig, ALL_PATHS)
    if (!patch) { setValidationErrors(null); return }

    setValidating(true)
    setValidationErrors(null)
    try {
      const result = await client.validateServerConfig(patch, baseHash)
      if (result.valid) {
        setValidationErrors([])
      } else {
        setValidationErrors(result.errors || [{ path: '', message: 'Validation failed' }])
      }
    } catch {
      setValidationErrors([{ path: '', message: 'Validation not supported by this server version' }])
    }
    setValidating(false)

    if (saveResultTimeout.current) clearTimeout(saveResultTimeout.current)
    saveResultTimeout.current = setTimeout(() => setValidationErrors(null), 6000)
  }, [client, editedConfig, originalConfig, baseHash])

  const val = useCallback((path: string) => {
    return getPath(editedConfig, path)
  }, [editedConfig])

  if (loading) {
    return (
      <div className="detail-view">
        <div className="detail-header">
          <button className="detail-back" onClick={closeDetailView} aria-label="Back to chat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            <span>Back</span>
          </button>
          <div className="detail-title-section">
            <div>
              <h1 className="detail-title">Server Settings</h1>
              <p className="detail-subtitle">Loading server configuration...</p>
            </div>
          </div>
        </div>
        <div className="detail-content">
          <div className="server-settings">
            <div className="settings-loading">Loading server configuration...</div>
          </div>
        </div>
      </div>
    )
  }

  if (error && !editedConfig) {
    return (
      <div className="detail-view">
        <div className="detail-header">
          <button className="detail-back" onClick={closeDetailView} aria-label="Back to chat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            <span>Back</span>
          </button>
          <div className="detail-title-section">
            <div>
              <h1 className="detail-title">Server Settings</h1>
              <p className="detail-subtitle">Error loading configuration</p>
            </div>
          </div>
        </div>
        <div className="detail-content">
          <div className="server-settings">
            <div className="settings-error">
              <p>{error}</p>
              <button className="btn btn-secondary" onClick={loadConfig}>Retry</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="detail-view">
      <div className="detail-header">
        <button className="detail-back" onClick={closeDetailView} aria-label="Back to chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span>Back</span>
        </button>
        <div className="detail-title-section">
          <div>
            <h1 className="detail-title">Server Settings</h1>
            <p className="detail-subtitle">Configure OpenClaw defaults, tools, channels, and features</p>
          </div>
        </div>
        <div className="detail-actions">
          {tab !== 'features' && isDirty() && (
            <div className="settings-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {saveResult === 'success' && <span className="save-feedback success">Saved! Restarting...</span>}
              {saveResult === 'error' && <span className="save-feedback error">Save failed</span>}
              {validationErrors !== null && validationErrors.length === 0 && <span className="save-feedback success">Valid</span>}
              {validationErrors !== null && validationErrors.length > 0 && (
                <span className="save-feedback error" title={validationErrors.map(e => `${e.path ? e.path + ': ' : ''}${e.message}`).join('\n')}>
                  {validationErrors.length} error{validationErrors.length !== 1 ? 's' : ''}
                </span>
              )}
              <button className="settings-button secondary" onClick={handleDiscard} disabled={saving}>
                Discard
              </button>
              <button className="settings-button secondary" onClick={handleValidate} disabled={saving || validating}>
                {validating ? 'Validating...' : 'Validate'}
              </button>
              <button
                className="settings-button primary"
                data-testid="server-settings-save"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="detail-content">
        <div className="server-settings" style={{ padding: 0 }}>
          <div className="settings-tabs">
            {TABS.map(t => (
              <button
                key={t.id}
                className={`settings-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="settings-body">
            {configErrors && configErrors.length > 0 && (
              <div
                className="settings-config-errors"
                role="alert"
                style={{
                  margin: '12px 16px',
                  padding: '12px 14px',
                  border: '1px solid var(--color-error-border, #d9534f)',
                  background: 'var(--color-error-bg, rgba(217, 83, 79, 0.08))',
                  borderRadius: 6,
                  color: 'var(--color-error-text, #b53e3a)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Server config has {configErrors.length} validation error{configErrors.length !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: 13, marginBottom: 8, opacity: 0.85 }}>
                  The server will reject all patches (including from this UI) until these are fixed.
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, fontFamily: 'var(--font-mono, monospace)' }}>
                  {configErrors.map((e, i) => (
                    <li key={i}>
                      {e.path ? <strong>{e.path}: </strong> : null}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {tab === 'agent-defaults' && (
              <AgentDefaultsTab val={val} setValue={setValue} />
            )}
            {tab === 'tools-memory' && (
              <ToolsMemoryTab val={val} setValue={setValue} />
            )}
            {tab === 'channels' && (
              <ChannelsTab val={val} setValue={setValue} />
            )}
            {tab === 'features' && (
              <FeaturesTab />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Tab components ---

interface TabProps {
  val: (path: string) => any
  setValue: (path: string, value: any) => void
}

function AgentDefaultsTab({ val, setValue }: TabProps) {
  return (
    <>
      <section className="settings-section">
        <h3>Model & Behavior</h3>
        <SettingsRow label="Primary Model" hint="Default LLM model for agents">
          <input
            type="text"
            className="settings-input"
            value={val('agents.defaults.model.primary') ?? ''}
            onChange={e => setValue('agents.defaults.model.primary', e.target.value)}
            placeholder="e.g. claude-sonnet-4-5-20250929"
          />
        </SettingsRow>
        <SettingsRow label="Thinking Level" hint="Default extended thinking level">
          <select
            className="settings-select"
            value={val('agents.defaults.thinkingDefault') ?? 'off'}
            onChange={e => setValue('agents.defaults.thinkingDefault', e.target.value)}
          >
            {THINKING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label="Verbose Mode" hint="Default verbosity for agent output">
          <select
            className="settings-select"
            value={val('agents.defaults.verboseDefault') ?? 'off'}
            onChange={e => setValue('agents.defaults.verboseDefault', e.target.value)}
          >
            {VERBOSE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label="Elevated Mode" hint="Default elevated tool access">
          <select
            className="settings-select"
            value={val('agents.defaults.elevatedDefault') ?? 'off'}
            onChange={e => setValue('agents.defaults.elevatedDefault', e.target.value)}
          >
            {ELEVATED_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
      </section>

      <section className="settings-section">
        <h3>Time & Locale</h3>
        <SettingsRow label="User Timezone" hint="IANA timezone for scheduling">
          <input
            type="text"
            className="settings-input"
            value={val('agents.defaults.userTimezone') ?? ''}
            onChange={e => setValue('agents.defaults.userTimezone', e.target.value)}
            placeholder="e.g. America/New_York"
          />
        </SettingsRow>
        <SettingsRow label="Time Format" hint="Clock display format">
          <select
            className="settings-select"
            value={val('agents.defaults.timeFormat') ?? 'auto'}
            onChange={e => setValue('agents.defaults.timeFormat', e.target.value)}
          >
            {TIME_FORMAT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
      </section>

      <section className="settings-section">
        <h3>Limits</h3>
        <SettingsRow label="Context Tokens" hint="Max context window size">
          <input
            type="number"
            className="settings-input"
            value={val('agents.defaults.contextTokens') ?? ''}
            onChange={e => setValue('agents.defaults.contextTokens', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 200000"
          />
        </SettingsRow>
        <SettingsRow label="Timeout (seconds)" hint="Max response time per turn">
          <input
            type="number"
            className="settings-input"
            value={val('agents.defaults.timeoutSeconds') ?? ''}
            onChange={e => setValue('agents.defaults.timeoutSeconds', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 300"
          />
        </SettingsRow>
        <SettingsRow label="Max Concurrent" hint="Max concurrent agent tasks">
          <input
            type="number"
            className="settings-input"
            value={val('agents.defaults.maxConcurrent') ?? ''}
            onChange={e => setValue('agents.defaults.maxConcurrent', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 5"
          />
        </SettingsRow>
        <SettingsRow label="Max Media Size (MB)" hint="Upload file size limit">
          <input
            type="number"
            className="settings-input"
            value={val('agents.defaults.mediaMaxMb') ?? ''}
            onChange={e => setValue('agents.defaults.mediaMaxMb', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 25"
          />
        </SettingsRow>
        <SettingsRow label="Max Subagent Concurrent" hint="Max concurrent subagents">
          <input
            type="number"
            className="settings-input"
            value={val('agents.defaults.subagents.maxConcurrent') ?? ''}
            onChange={e => setValue('agents.defaults.subagents.maxConcurrent', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 3"
          />
        </SettingsRow>
      </section>

      <section className="settings-section">
        <h3>Advanced</h3>
        <SettingsRow label="Workspace" hint="Default workspace directory">
          <input
            type="text"
            className="settings-input"
            value={val('agents.defaults.workspace') ?? ''}
            onChange={e => setValue('agents.defaults.workspace', e.target.value)}
            placeholder="e.g. /home/user/agents"
          />
        </SettingsRow>
        <SettingsRow label="Compaction Mode" hint="Context compaction strategy">
          <select
            className="settings-select"
            value={val('agents.defaults.compaction.mode') ?? 'default'}
            onChange={e => setValue('agents.defaults.compaction.mode', e.target.value)}
          >
            {COMPACTION_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label="Human Delay" hint="Simulate typing delay">
          <select
            className="settings-select"
            value={val('agents.defaults.humanDelay.mode') ?? 'off'}
            onChange={e => setValue('agents.defaults.humanDelay.mode', e.target.value)}
          >
            {HUMAN_DELAY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
      </section>
    </>
  )
}

function ToolsMemoryTab({ val, setValue }: TabProps) {
  return (
    <>
      <section className="settings-section">
        <h3>Tools Profile</h3>
        <SettingsRow label="Profile" hint="Preset tool selection">
          <select
            className="settings-select"
            value={val('tools.profile') ?? 'full'}
            onChange={e => setValue('tools.profile', e.target.value)}
          >
            {TOOLS_PROFILE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
      </section>

      <section className="settings-section">
        <h3>Web Tools</h3>
        <SettingsRow label="Web Search" hint="Enable web search tool">
          <SettingsToggle
            checked={val('tools.web.search.enabled') ?? false}
            onChange={v => setValue('tools.web.search.enabled', v)}
          />
        </SettingsRow>
        <SettingsRow label="Search Max Results" hint="Maximum search results returned">
          <input
            type="number"
            className="settings-input"
            value={val('tools.web.search.maxResults') ?? ''}
            onChange={e => setValue('tools.web.search.maxResults', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 10"
          />
        </SettingsRow>
        <SettingsRow label="Web Fetch" hint="Enable URL fetch tool">
          <SettingsToggle
            checked={val('tools.web.fetch.enabled') ?? false}
            onChange={v => setValue('tools.web.fetch.enabled', v)}
          />
        </SettingsRow>
        <SettingsRow label="Fetch Max Chars" hint="Max characters fetched per URL">
          <input
            type="number"
            className="settings-input"
            value={val('tools.web.fetch.maxChars') ?? ''}
            onChange={e => setValue('tools.web.fetch.maxChars', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 50000"
          />
        </SettingsRow>
      </section>

      <section className="settings-section">
        <h3>Code Execution</h3>
        <SettingsRow label="Exec Host" hint="Where code runs">
          <select
            className="settings-select"
            value={val('tools.exec.host') ?? 'sandbox'}
            onChange={e => setValue('tools.exec.host', e.target.value)}
          >
            {EXEC_HOST_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label="Exec Timeout (sec)" hint="Code execution time limit">
          <input
            type="number"
            className="settings-input"
            value={val('tools.exec.timeoutSec') ?? ''}
            onChange={e => setValue('tools.exec.timeoutSec', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="e.g. 30"
          />
        </SettingsRow>
        <SettingsRow label="Elevated Tools" hint="Enable elevated tool access">
          <SettingsToggle
            checked={val('tools.elevated.enabled') ?? false}
            onChange={v => setValue('tools.elevated.enabled', v)}
          />
        </SettingsRow>
      </section>

      <section className="settings-section">
        <h3>Memory</h3>
        <SettingsRow label="Backend" hint="Memory storage backend">
          <select
            className="settings-select"
            value={val('memory.backend') ?? 'sqlite'}
            onChange={e => setValue('memory.backend', e.target.value)}
          >
            {MEMORY_BACKEND_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label="Citations" hint="Include memory citations in responses">
          <select
            className="settings-select"
            value={val('memory.citations') ?? 'auto'}
            onChange={e => setValue('memory.citations', e.target.value)}
          >
            {MEMORY_CITATIONS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label="Memory Search" hint="Enable memory search for agents">
          <SettingsToggle
            checked={val('agents.defaults.memorySearch.enabled') ?? false}
            onChange={v => setValue('agents.defaults.memorySearch.enabled', v)}
          />
        </SettingsRow>
        <SettingsRow label="Search Provider" hint="Embedding provider for memory search">
          <select
            className="settings-select"
            value={val('agents.defaults.memorySearch.provider') ?? 'local'}
            onChange={e => setValue('agents.defaults.memorySearch.provider', e.target.value)}
          >
            {MEMORY_SEARCH_PROVIDER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </SettingsRow>
      </section>
    </>
  )
}

function ChannelsTab({ val, setValue }: TabProps) {
  return (
    <>
      {CHANNEL_IDS.map(ch => {
        const enabled = val(`channels.${ch}.enabled`) ?? false
        return (
          <div key={ch} className="channel-card">
            <div className="channel-card-header">
              <span className="channel-card-name">{CHANNEL_LABELS[ch]}</span>
              <SettingsToggle
                checked={enabled}
                onChange={v => setValue(`channels.${ch}.enabled`, v)}
              />
            </div>
            {enabled && (
              <div className="channel-card-body">
                <SettingsRow label="DM Policy" hint="How to handle direct messages">
                  <select
                    className="settings-select"
                    value={val(`channels.${ch}.dmPolicy`) ?? 'on'}
                    onChange={e => setValue(`channels.${ch}.dmPolicy`, e.target.value)}
                  >
                    {POLICY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </SettingsRow>
                <SettingsRow label="Group Policy" hint="How to handle group messages">
                  <select
                    className="settings-select"
                    value={val(`channels.${ch}.groupPolicy`) ?? 'off'}
                    onChange={e => setValue(`channels.${ch}.groupPolicy`, e.target.value)}
                  >
                    {POLICY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </SettingsRow>
                <SettingsRow label="History Limit" hint="Max messages to load per conversation">
                  <input
                    type="number"
                    className="settings-input"
                    value={val(`channels.${ch}.historyLimit`) ?? ''}
                    onChange={e => setValue(`channels.${ch}.historyLimit`, e.target.value ? Number(e.target.value) : undefined)}
                    placeholder="e.g. 50"
                  />
                </SettingsRow>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

// --- Shared sub-components ---

function SettingsRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span className="settings-label">{label}</span>
        <span className="settings-hint">{hint}</span>
      </div>
      <div className="settings-row-control">
        {children}
      </div>
    </div>
  )
}

function SettingsToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-switch">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="toggle-slider"></span>
    </label>
  )
}
function FeaturesTab() {
  const { client } = useStore()
  const [ttsStatus, setTtsStatus] = useState<any>(null)
  const [wakeStatus, setWakeStatus] = useState<any>(null)

  useEffect(() => {
    if (!client) return
    client.getTtsStatus().then(setTtsStatus).catch(() => { })
    client.getVoicewake().then(setWakeStatus).catch(() => { })
  }, [client])

  const toggleTts = async (enabled: boolean) => {
    if (!client) return
    await client.setTtsEnable(enabled)
    setTtsStatus((prev: any) => ({ ...prev, enabled }))
  }

  const toggleWake = async (enabled: boolean) => {
    if (!client) return
    const triggers = wakeStatus?.triggers ?? ['openclaw', 'claude', 'computer']
    await client.setVoicewake({ enabled, triggers, sensitivity: wakeStatus?.sensitivity })
    setWakeStatus((prev: any) => ({ ...prev, enabled }))
  }

  return (
    <>
      <div className="settings-section">
        <h3>Text-to-Speech (TTS)</h3>
        <p className="setting-description">Enable or disable TTS functionality for voice interactions.</p>

        <div className="settings-row">
          <div className="settings-row-label">
            <span className="settings-label">Enable TTS</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={!!ttsStatus?.enabled}
              onChange={(e) => toggleTts(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-section">
        <h3>Voice Wake</h3>
        <p className="setting-description">Listen for wake words continuously. Currently only supported on Android and web browsers.</p>

        <div className="settings-row">
          <div className="settings-row-label">
            <span className="settings-label">Enable Voice Wake</span>
            <span className="settings-hint">Triggers: {(wakeStatus?.triggers ?? ['openclaw', 'claude', 'computer']).join(', ')}</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={!!wakeStatus?.enabled}
              onChange={(e) => toggleWake(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </>
  )
}
