import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternal } from '../lib/platform'
import { useStore } from '../store'
import { showToast } from './ToastContainer'
import { resolveModel } from '../lib/openclaw/utils'
import type { CronScheduleType, CronPayload, CronDelivery, CronSessionTarget, CronWakeMode } from '../lib/openclaw/types'

export function CronJobDetailView() {
  const { selectedCronJob, closeDetailView, client, fetchCronJobs, agents } = useStore()

  const [running, setRunning] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Unified edit mode
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // Edit form state
  const [nameValue, setNameValue] = useState('')
  const [descriptionValue, setDescriptionValue] = useState('')
  const [scheduleKind, setScheduleKind] = useState<'cron' | 'every' | 'at'>('cron')
  const [cronExpr, setCronExpr] = useState('')
  const [cronTz, setCronTz] = useState('')
  const [everyMs, setEveryMs] = useState('')
  const [atTime, setAtTime] = useState('')
  const [sessionTarget, setSessionTarget] = useState<CronSessionTarget>('isolated')
  const [wakeMode, setWakeMode] = useState<CronWakeMode>('now')
  const [agentId, setAgentId] = useState('')
  const [deleteAfterRun, setDeleteAfterRun] = useState(false)
  const [payloadKind, setPayloadKind] = useState<'agentTurn' | 'systemEvent'>('agentTurn')
  const [payloadText, setPayloadText] = useState('')
  const [payloadModel, setPayloadModel] = useState('')
  const [payloadThinking, setPayloadThinking] = useState('')
  const [payloadTimeout, setPayloadTimeout] = useState('')
  const [deliveryMode, setDeliveryMode] = useState<'none' | 'announce' | 'webhook'>('none')
  const [deliveryChannel, setDeliveryChannel] = useState('')
  const [deliveryTo, setDeliveryTo] = useState('')
  const [deliveryBestEffort, setDeliveryBestEffort] = useState(false)
  const [contentValue, setContentValue] = useState('')

  if (!selectedCronJob) return null

  const refreshDetail = async () => {
    if (!client) return
    await fetchCronJobs()
    const details = await client.getCronJobDetails(selectedCronJob.id)
    if (details) useStore.setState({ selectedCronJob: details })
  }

  const handleToggle = async () => {
    if (!client) return
    const resuming = selectedCronJob.status === 'paused'
    await client.toggleCronJob(selectedCronJob.id, resuming)
    await refreshDetail()
    showToast(`Cron job ${resuming ? 'resumed' : 'paused'}`)
  }

  const handleRun = async () => {
    if (!client) return
    setRunning(true)
    try {
      await client.runCronJob(selectedCronJob.id)
    } catch (e) {
      console.error(e)
    } finally {
      setRunning(false)
    }
  }

  const handleDelete = async () => {
    if (!client) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await client.removeCronJob(selectedCronJob.id)
      await fetchCronJobs()
      closeDetailView()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete cron job')
      setDeleting(false)
    }
  }

  const handleStartEdit = () => {
    const job = selectedCronJob
    setNameValue(job.name)
    setDescriptionValue(job.description || '')

    // Schedule
    const raw = job.scheduleRaw
    if (raw) {
      setScheduleKind(raw.kind)
      if (raw.kind === 'cron') {
        setCronExpr(raw.expr)
        setCronTz(raw.tz || '')
      } else if (raw.kind === 'every') {
        setEveryMs(String(raw.everyMs))
      } else if (raw.kind === 'at') {
        setAtTime(raw.at)
      }
    } else {
      setScheduleKind('cron')
      setCronExpr(job.schedule)
      setCronTz('')
    }

    // Execution
    setSessionTarget(job.sessionTarget || 'isolated')
    setWakeMode(job.wakeMode || 'now')
    setAgentId(job.agentId || '')
    setDeleteAfterRun(job.deleteAfterRun || false)

    // Payload
    const p = job.payload
    if (p?.kind === 'systemEvent') {
      setPayloadKind('systemEvent')
      setPayloadText(p.text || '')
      setPayloadModel('')
      setPayloadThinking('')
      setPayloadTimeout('')
    } else if (p?.kind === 'agentTurn') {
      setPayloadKind('agentTurn')
      setPayloadText(p.message || '')
      setPayloadModel(resolveModel(p.model) || '')
      setPayloadThinking(p.thinking || '')
      setPayloadTimeout(p.timeoutSeconds ? String(p.timeoutSeconds) : '')
    } else {
      setPayloadKind('agentTurn')
      setPayloadText('')
      setPayloadModel('')
      setPayloadThinking('')
      setPayloadTimeout('')
    }

    // Delivery
    const d = job.delivery
    setDeliveryMode(d?.mode || 'none')
    setDeliveryChannel(d?.channel || '')
    setDeliveryTo(d?.to || '')
    setDeliveryBestEffort(d?.bestEffort || false)

    // Content
    setContentValue(job.content || '')

    setEditError(null)
    setEditing(true)
  }

  const handleSaveAll = async () => {
    if (!client) return
    if (!nameValue.trim()) {
      setEditError('Job name is required')
      return
    }

    setSaving(true)
    setEditError(null)
    try {
      let schedule: CronScheduleType
      if (scheduleKind === 'cron') {
        schedule = { kind: 'cron', expr: cronExpr.trim(), ...(cronTz ? { tz: cronTz } : {}) }
      } else if (scheduleKind === 'every') {
        schedule = { kind: 'every', everyMs: parseInt(everyMs) || 60000 }
      } else {
        schedule = { kind: 'at', at: atTime.trim() }
      }

      let payload: CronPayload
      if (payloadKind === 'systemEvent') {
        payload = { kind: 'systemEvent', text: payloadText }
      } else {
        payload = {
          kind: 'agentTurn',
          message: payloadText,
          ...(payloadModel ? { model: payloadModel } : {}),
          ...(payloadThinking ? { thinking: payloadThinking } : {}),
          ...(payloadTimeout ? { timeoutSeconds: parseInt(payloadTimeout) } : {}),
        }
      }

      const delivery: CronDelivery = { mode: deliveryMode }
      if (deliveryMode === 'announce' && deliveryChannel) delivery.channel = deliveryChannel
      if (deliveryMode === 'webhook') {
        if (deliveryTo) delivery.to = deliveryTo
        delivery.bestEffort = deliveryBestEffort
      }

      await client.updateCronJob(selectedCronJob.id, {
        name: nameValue.trim(),
        ...(descriptionValue.trim() ? { description: descriptionValue.trim() } : { description: '' }),
        schedule,
        sessionTarget,
        wakeMode,
        ...(agentId ? { agentId } : { agentId: null }),
        deleteAfterRun,
        payload,
        delivery,
      })
      await refreshDetail()
      setEditing(false)
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Failed to save changes')
    } finally {
      setSaving(false)
    }
  }

  const isActive = selectedCronJob.status === 'active'

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`
    return `${(ms / 3600000).toFixed(1)}h`
  }

  const formatTimestamp = (ms: number) => {
    try { return new Date(ms).toLocaleString() } catch { return String(ms) }
  }

  // ==================== EDIT MODE ====================
  if (editing) {
    return (
      <div className="detail-view">
        <div className="detail-header">
          <button className="detail-back" onClick={() => setEditing(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            <span>Back</span>
          </button>
          <div className="detail-title-section">
            <div className="detail-icon cron-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <div>
              <h1 className="detail-title">Edit Cron Job</h1>
              <p className="detail-subtitle">Modify settings for {selectedCronJob.name}</p>
            </div>
          </div>
        </div>

        <div className="detail-content">
          {editError && <div className="settings-error">{editError}</div>}

          {/* Basic Info */}
          <div className="create-agent-section">
            <h3>Basic Info</h3>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Name</span>
                <span className="settings-hint">A unique name for this job</span>
              </div>
              <div className="settings-row-control">
                <input
                  type="text"
                  className="settings-input"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  placeholder="e.g., Daily Cleanup"
                  autoFocus
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Description</span>
                <span className="settings-hint">Optional description</span>
              </div>
              <div className="settings-row-control">
                <input
                  type="text"
                  className="settings-input"
                  value={descriptionValue}
                  onChange={(e) => setDescriptionValue(e.target.value)}
                  placeholder="What does this job do?"
                />
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className="create-agent-section">
            <h3>Schedule</h3>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Kind</span>
              </div>
              <div className="settings-row-control">
                <select className="settings-select" value={scheduleKind} onChange={(e) => setScheduleKind(e.target.value as 'cron' | 'every' | 'at')}>
                  <option value="cron">Cron Expression</option>
                  <option value="every">Interval</option>
                  <option value="at">One-time</option>
                </select>
              </div>
            </div>
            {scheduleKind === 'cron' && (
              <>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-label">Expression</span>
                    <span className="settings-hint">e.g. 0 * * * *</span>
                  </div>
                  <div className="settings-row-control">
                    <input className="settings-input" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder="0 * * * *" />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-label">Timezone</span>
                    <span className="settings-hint">Optional</span>
                  </div>
                  <div className="settings-row-control">
                    <input className="settings-input" value={cronTz} onChange={(e) => setCronTz(e.target.value)} placeholder="UTC" />
                  </div>
                </div>
              </>
            )}
            {scheduleKind === 'every' && (
              <div className="settings-row">
                <div className="settings-row-label">
                  <span className="settings-label">Interval (ms)</span>
                  <span className="settings-hint">e.g. 60000 for every minute</span>
                </div>
                <div className="settings-row-control">
                  <input className="settings-input" type="number" value={everyMs} onChange={(e) => setEveryMs(e.target.value)} placeholder="60000" />
                </div>
              </div>
            )}
            {scheduleKind === 'at' && (
              <div className="settings-row">
                <div className="settings-row-label">
                  <span className="settings-label">Run At</span>
                  <span className="settings-hint">ISO 8601 datetime</span>
                </div>
                <div className="settings-row-control">
                  <input className="settings-input" type="datetime-local" value={atTime} onChange={(e) => setAtTime(e.target.value)} />
                </div>
              </div>
            )}
          </div>

          {/* Execution */}
          <div className="create-agent-section">
            <h3>Execution</h3>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Session Target</span>
                <span className="settings-hint">Run in the main session or an isolated one</span>
              </div>
              <div className="settings-row-control">
                <select className="settings-select" value={sessionTarget} onChange={(e) => setSessionTarget(e.target.value as CronSessionTarget)}>
                  <option value="isolated">Isolated</option>
                  <option value="main">Main</option>
                </select>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Wake Mode</span>
                <span className="settings-hint">When the agent should wake up</span>
              </div>
              <div className="settings-row-control">
                <select className="settings-select" value={wakeMode} onChange={(e) => setWakeMode(e.target.value as CronWakeMode)}>
                  <option value="now">Immediately</option>
                  <option value="next-heartbeat">Next Heartbeat</option>
                </select>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Agent</span>
                <span className="settings-hint">Which agent should execute this job</span>
              </div>
              <div className="settings-row-control">
                <select className="settings-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Default</option>
                  {agents.map(a => (
                    <option key={a.id} value={a.id}>{a.name || a.id}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Delete After Run</span>
                <span className="settings-hint">Remove this job after it executes once</span>
              </div>
              <div className="settings-row-control">
                <label className="toggle-switch">
                  <input type="checkbox" checked={deleteAfterRun} onChange={(e) => setDeleteAfterRun(e.target.checked)} />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          </div>

          {/* Payload */}
          <div className="create-agent-section">
            <h3>Payload</h3>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Kind</span>
                <span className="settings-hint">Type of payload to send</span>
              </div>
              <div className="settings-row-control">
                <select className="settings-select" value={payloadKind} onChange={(e) => setPayloadKind(e.target.value as 'agentTurn' | 'systemEvent')}>
                  <option value="agentTurn">Agent Turn</option>
                  <option value="systemEvent">System Event</option>
                </select>
              </div>
            </div>
            <div className="settings-row" style={{ alignItems: 'flex-start' }}>
              <div className="settings-row-label">
                <span className="settings-label">{payloadKind === 'systemEvent' ? 'Text' : 'Message'}</span>
              </div>
              <div className="settings-row-control">
                <textarea
                  className="settings-textarea"
                  style={{ width: 300, height: 80 }}
                  value={payloadText}
                  onChange={(e) => setPayloadText(e.target.value)}
                  placeholder={payloadKind === 'systemEvent' ? 'System event text...' : 'Message to send...'}
                  autoCorrect="on"
                  autoCapitalize="sentences"
                  spellCheck={true}
                />
              </div>
            </div>
            {payloadKind === 'agentTurn' && (
              <>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-label">Model</span>
                    <span className="settings-hint">Optional model override</span>
                  </div>
                  <div className="settings-row-control">
                    <input className="settings-input" value={payloadModel} onChange={(e) => setPayloadModel(e.target.value)} placeholder="Default" />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-label">Thinking</span>
                    <span className="settings-hint">Thinking level</span>
                  </div>
                  <div className="settings-row-control">
                    <select className="settings-select" value={payloadThinking} onChange={(e) => setPayloadThinking(e.target.value)}>
                      <option value="">Default</option>
                      <option value="none">None</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-label">Timeout (s)</span>
                    <span className="settings-hint">Max execution time</span>
                  </div>
                  <div className="settings-row-control">
                    <input className="settings-input" type="number" value={payloadTimeout} onChange={(e) => setPayloadTimeout(e.target.value)} placeholder="None" />
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Delivery */}
          <div className="create-agent-section">
            <h3>Delivery</h3>
            <div className="settings-row">
              <div className="settings-row-label">
                <span className="settings-label">Mode</span>
                <span className="settings-hint">How results are delivered</span>
              </div>
              <div className="settings-row-control">
                <select className="settings-select" value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value as 'none' | 'announce' | 'webhook')}>
                  <option value="none">None</option>
                  <option value="announce">Announce</option>
                  <option value="webhook">Webhook</option>
                </select>
              </div>
            </div>
            {deliveryMode === 'announce' && (
              <div className="settings-row">
                <div className="settings-row-label">
                  <span className="settings-label">Channel</span>
                  <span className="settings-hint">Optional channel to announce in</span>
                </div>
                <div className="settings-row-control">
                  <input className="settings-input" value={deliveryChannel} onChange={(e) => setDeliveryChannel(e.target.value)} placeholder="Default" />
                </div>
              </div>
            )}
            {deliveryMode === 'webhook' && (
              <>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-label">URL</span>
                    <span className="settings-hint">Webhook endpoint</span>
                  </div>
                  <div className="settings-row-control">
                    <input className="settings-input" value={deliveryTo} onChange={(e) => setDeliveryTo(e.target.value)} placeholder="https://..." />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-label">Best Effort</span>
                    <span className="settings-hint">Don't fail the job if delivery fails</span>
                  </div>
                  <div className="settings-row-control">
                    <label className="toggle-switch">
                      <input type="checkbox" checked={deliveryBestEffort} onChange={(e) => setDeliveryBestEffort(e.target.checked)} />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Content */}
          <div className="create-agent-section">
            <h3>Content</h3>
            <p className="section-description">Optional notes or script content for this job.</p>
            <textarea
              className="settings-textarea"
              style={{ height: '120px', fontFamily: 'monospace' }}
              value={contentValue}
              onChange={(e) => setContentValue(e.target.value)}
              placeholder="Optional content or notes..."
            />
          </div>
        </div>

        <div className="detail-footer">
          <button className="settings-button secondary" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
          <button
            className="settings-button primary"
            onClick={handleSaveAll}
            disabled={saving || !nameValue.trim()}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    )
  }

  // ==================== VIEW MODE ====================
  return (
    <div className="detail-view">
      <div className="detail-header">
        <div className="detail-header-top">
          <button className="detail-back" onClick={closeDetailView} aria-label="Back to chat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            <span>Back</span>
          </button>
          <div className="detail-actions">
            <button
              className="btn btn-secondary"
              onClick={handleStartEdit}
              title="Edit Cron Job"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
            <button
              className="btn btn-secondary"
              data-testid="cron-run-now"
              onClick={handleRun}
              disabled={running}
              title="Run Now"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              {running ? 'Running...' : 'Run'}
            </button>

            <div className={`status-badge ${isActive ? 'enabled' : 'disabled'}`}>
              {isActive ? 'Active' : 'Paused'}
            </div>
            <button
              className={`toggle-button ${isActive ? 'active' : ''}`}
              data-testid="cron-pause-toggle"
              onClick={handleToggle}
              aria-label={isActive ? 'Pause cron job' : 'Resume cron job'}
            >
              <span className="toggle-track">
                <span className="toggle-thumb" />
              </span>
            </button>
          </div>
        </div>
        <div className="detail-title-section">
          <div className="detail-icon cron-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 className="detail-title" title={selectedCronJob.name}>
              {selectedCronJob.name}
            </h1>
            {selectedCronJob.description && (
              <p className="detail-subtitle">{selectedCronJob.description}</p>
            )}
          </div>
        </div>
      </div>

      {/* Schedule Section */}
      <div className="detail-meta">
        <div className="meta-section">
          <h3>Schedule</h3>
          <div className="schedule-display">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            <span className="schedule-expression">
              {selectedCronJob.schedule}
              {selectedCronJob.scheduleRaw?.kind === 'cron' && selectedCronJob.scheduleRaw.tz && (
                <span className="schedule-tz"> ({selectedCronJob.scheduleRaw.tz})</span>
              )}
            </span>
          </div>
        </div>
        {selectedCronJob.nextRun && isActive && (
          <div className="meta-section">
            <h3>Next Run</h3>
            <div className="next-run-display">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <span>{selectedCronJob.nextRun}</span>
            </div>
          </div>
        )}
      </div>

      <div className="detail-content">
        {/* Execution Section */}
        <section className="detail-section cron-config-section">
          <h3>Execution</h3>
          <div className="cron-config-display">
            <div className="cron-config-row">
              <span className="cron-config-label">Session</span>
              <span className="cron-config-value">{selectedCronJob.sessionTarget || 'isolated'}</span>
            </div>
            <div className="cron-config-row">
              <span className="cron-config-label">Wake</span>
              <span className="cron-config-value">{selectedCronJob.wakeMode === 'next-heartbeat' ? 'Next Heartbeat' : 'Immediately'}</span>
            </div>
            {selectedCronJob.agentId && (
              <div className="cron-config-row">
                <span className="cron-config-label">Agent</span>
                <span className="cron-config-value">{agents.find(a => a.id === selectedCronJob.agentId)?.name || selectedCronJob.agentId}</span>
              </div>
            )}
            {selectedCronJob.deleteAfterRun && (
              <div className="cron-config-row">
                <span className="cron-config-label">Delete After Run</span>
                <span className="cron-config-value">Yes</span>
              </div>
            )}
          </div>
        </section>

        {/* Payload Section */}
        <section className="detail-section cron-config-section">
          <h3>Payload</h3>
          <div className="cron-config-display">
            {selectedCronJob.payload ? (
              <>
                <div className="cron-config-row">
                  <span className="cron-config-label">Kind</span>
                  <span className="cron-config-value">{selectedCronJob.payload.kind === 'systemEvent' ? 'System Event' : 'Agent Turn'}</span>
                </div>
                <div className="cron-config-row">
                  <span className="cron-config-label">{selectedCronJob.payload.kind === 'systemEvent' ? 'Text' : 'Message'}</span>
                  <span className="cron-config-value cron-config-text">
                    {selectedCronJob.payload.kind === 'systemEvent' ? selectedCronJob.payload.text : selectedCronJob.payload.message}
                  </span>
                </div>
                {selectedCronJob.payload.kind === 'agentTurn' && selectedCronJob.payload.model && (
                  <div className="cron-config-row">
                    <span className="cron-config-label">Model</span>
                    <span className="cron-config-value">{resolveModel(selectedCronJob.payload.model)}</span>
                  </div>
                )}
              </>
            ) : (
              <p className="cron-config-empty">No payload configured</p>
            )}
          </div>
        </section>

        {/* Delivery Section */}
        <section className="detail-section cron-config-section">
          <h3>Delivery</h3>
          <div className="cron-config-display">
            <div className="cron-config-row">
              <span className="cron-config-label">Mode</span>
              <span className="cron-config-value">{selectedCronJob.delivery?.mode || 'none'}</span>
            </div>
            {selectedCronJob.delivery?.mode === 'announce' && selectedCronJob.delivery.channel && (
              <div className="cron-config-row">
                <span className="cron-config-label">Channel</span>
                <span className="cron-config-value">{selectedCronJob.delivery.channel}</span>
              </div>
            )}
            {selectedCronJob.delivery?.mode === 'webhook' && (
              <>
                {selectedCronJob.delivery.to && (
                  <div className="cron-config-row">
                    <span className="cron-config-label">URL</span>
                    <span className="cron-config-value cron-config-text">{selectedCronJob.delivery.to}</span>
                  </div>
                )}
                {selectedCronJob.delivery.bestEffort && (
                  <div className="cron-config-row">
                    <span className="cron-config-label">Best Effort</span>
                    <span className="cron-config-value">Yes</span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* State Section (read-only) */}
        {selectedCronJob.state && (
          <section className="detail-section cron-config-section">
            <h3>Last Run State</h3>
            <div className="cron-config-display">
              {selectedCronJob.state.lastRunStatus && (
                <div className="cron-config-row">
                  <span className="cron-config-label">Status</span>
                  <span className={`cron-config-value cron-state-${selectedCronJob.state.lastRunStatus}`}>
                    {selectedCronJob.state.lastRunStatus}
                  </span>
                </div>
              )}
              {selectedCronJob.state.lastRunAtMs && (
                <div className="cron-config-row">
                  <span className="cron-config-label">Last Run</span>
                  <span className="cron-config-value">{formatTimestamp(selectedCronJob.state.lastRunAtMs)}</span>
                </div>
              )}
              {selectedCronJob.state.lastDurationMs != null && (
                <div className="cron-config-row">
                  <span className="cron-config-label">Duration</span>
                  <span className="cron-config-value">{formatMs(selectedCronJob.state.lastDurationMs)}</span>
                </div>
              )}
              {selectedCronJob.state.nextRunAtMs && (
                <div className="cron-config-row">
                  <span className="cron-config-label">Next Run</span>
                  <span className="cron-config-value">{formatTimestamp(selectedCronJob.state.nextRunAtMs)}</span>
                </div>
              )}
              {selectedCronJob.state.lastError && (
                <div className="cron-config-row">
                  <span className="cron-config-label">Error</span>
                  <span className="cron-config-value cron-state-error">{selectedCronJob.state.lastError}</span>
                </div>
              )}
              {(selectedCronJob.state.consecutiveErrors ?? 0) > 0 && (
                <div className="cron-config-row">
                  <span className="cron-config-label">Consecutive Errors</span>
                  <span className="cron-config-value cron-state-error">{selectedCronJob.state.consecutiveErrors}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Content Section */}
        <section className="detail-section cron-config-section">
          <h3>Content</h3>
          {selectedCronJob.content ? (
            <div className="markdown-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children, ...props }) => {
                    const url = href || ''
                    const isExternal = /^(https?:\/\/|mailto:|tel:)/i.test(url)
                    return (
                      <a
                        {...props}
                        href={href}
                        onClick={(e) => {
                          if (!isExternal) return
                          e.preventDefault()
                          void openExternal(url)
                        }}
                      >
                        {children}
                      </a>
                    )
                  }
                }}
              >
                {selectedCronJob.content}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="cron-config-empty">No content</p>
          )}
        </section>

        {/* Danger Zone */}
        <section className="detail-section cron-danger-zone">
          <h2>Danger Zone</h2>
          {!showDeleteConfirm ? (
            <button
              className="btn btn-danger"
              data-testid="cron-delete"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete Cron Job
            </button>
          ) : (
            <div className="delete-confirm">
              <p className="delete-confirm-text">
                Are you sure you want to delete <strong>{selectedCronJob.name}</strong>? This action cannot be undone.
              </p>
              {deleteError && (
                <p className="delete-confirm-error">{deleteError}</p>
              )}
              <div className="delete-confirm-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => { setShowDeleteConfirm(false); setDeleteError(null) }}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-danger"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
