import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { getPlatform, openExternal, clipboardWrite } from '../lib/platform'
import { clearDeviceToken } from '../lib/device-identity'
import { NodePermissionsDialog } from './NodePermissionsDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { showToast } from './ToastContainer'

export function SettingsModal() {
  const {
    serverUrl,
    setServerUrl,
    authMode,
    setAuthMode,
    gatewayToken,
    setGatewayToken,
    showSettings,
    setShowSettings,
    connect,
    disconnect,
    connected,
    connecting,
    notificationsEnabled,
    setNotificationsEnabled,
    streamingDisabled,
    setStreamingDisabled,
    nodeEnabled,
    setNodeEnabled,
    openServerSettings,
    theme,
    toggleTheme,
    pairingStatus,
    pairingRequestId,
    retryConnect,
    connectionError,
    deviceName,
    setDeviceName,
    serverProfiles,
    activeProfileId,
    addServerProfile,
    updateServerProfile,
    deleteServerProfile,
    switchProfile
  } = useStore()

  const [url, setUrl] = useState(serverUrl)
  const [mode, setMode] = useState(authMode)
  const [token, setToken] = useState(gatewayToken)
  const [name, setName] = useState(deviceName)
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [connectionExpanded, setConnectionExpanded] = useState(!connected)
  const [editingProfileName, setEditingProfileName] = useState<string | null>(null)
  const [profileNameDraft, setProfileNameDraft] = useState('')
  const [connectPhase, setConnectPhase] = useState<'idle' | 'connecting' | 'retrying' | 'failed'>('idle')
  const [autoRetryCount, setAutoRetryCount] = useState(0)
  const [autoRetryTimer, setAutoRetryTimer] = useState<ReturnType<typeof setInterval> | null>(null)
  const [nextRetryIn, setNextRetryIn] = useState(0)
  const [showNodePermissions, setShowNodePermissions] = useState(false)
  const [profileToDelete, setProfileToDelete] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    setUrl(serverUrl)
    setMode(authMode)
    setToken(gatewayToken)
    setName(deviceName)
    setConnectionExpanded(!connected)
  }, [serverUrl, authMode, gatewayToken, deviceName, showSettings, connected])

  // Reset connect phase when modal opens or connection succeeds
  useEffect(() => {
    if (connected || showSettings) setConnectPhase('idle')
  }, [connected, showSettings])

  // Stop auto-retry when connected or modal closes
  useEffect(() => {
    if ((connected || !showSettings) && autoRetryTimer) {
      clearInterval(autoRetryTimer)
      setAutoRetryTimer(null)
      setAutoRetryCount(0)
      setNextRetryIn(0)
    }
  }, [connected, showSettings, autoRetryTimer])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoRetryTimer) clearInterval(autoRetryTimer)
    }
  }, [autoRetryTimer])

  const validateUrl = (value: string) => {
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return 'URL must start with ws:// or wss://'
      }
      if (!parsed.hostname) {
        return 'URL must include a hostname'
      }
      return ''
    } catch {
      return 'Invalid URL format'
    }
  }

  const startAutoRetry = () => {
    // Stop any existing timer
    if (autoRetryTimer) {
      clearInterval(autoRetryTimer)
    }

    let count = 0
    let secondsLeft = 60
    setAutoRetryCount(0)
    setNextRetryIn(60)

    const timer = setInterval(async () => {
      secondsLeft--
      setNextRetryIn(secondsLeft)

      if (secondsLeft <= 0) {
        count++
        setAutoRetryCount(count)

        if (count >= 5) {
          // Stop after 5 auto-retries (5 minutes)
          clearInterval(timer)
          setAutoRetryTimer(null)
          setNextRetryIn(0)
          setConnectPhase('idle')
          return
        }

        // Attempt reconnect
        setConnectPhase('retrying')
        try {
          await retryConnect()
          // Check if we actually connected (pairing may have silently failed)
          const state = useStore.getState()
          if (state.connected) {
            clearInterval(timer)
            setAutoRetryTimer(null)
            setAutoRetryCount(0)
            setNextRetryIn(0)
            setConnectPhase('idle')
            setShowSettings(false)
            return
          }
        } catch {
          // Retry failed
        }
        setConnectPhase('idle')
        secondsLeft = 60
        setNextRetryIn(60)
      }
    }, 1000)

    setAutoRetryTimer(timer)
  }

  const handleManualRetry = async () => {
    setConnectPhase('retrying')
    try {
      await retryConnect()
      const state = useStore.getState()
      if (state.connected) {
        if (autoRetryTimer) {
          clearInterval(autoRetryTimer)
          setAutoRetryTimer(null)
        }
        setAutoRetryCount(0)
        setNextRetryIn(0)
        setConnectPhase('idle')
        setShowSettings(false)
        return
      }
    } catch {
      // Retry failed
    }
    setConnectPhase('idle')
  }

  const handleSave = async () => {
    setError('')
    const trimmedUrl = url.trim()
    const trimmedToken = token.trim()

    if (!trimmedUrl) {
      setError('Server URL is required')
      return
    }

    const urlError = validateUrl(trimmedUrl)
    if (urlError) {
      setError(urlError)
      return
    }

    // If no profiles exist yet, create one
    if (serverProfiles.length === 0) {
      const id = addServerProfile({
        name: 'Server 1',
        serverUrl: trimmedUrl,
        authMode: mode,
        deviceName: name.trim()
      })
      await switchProfile(id)
    }

    // Save settings (these also update the active profile)
    setServerUrl(trimmedUrl)
    setAuthMode(mode)
    setGatewayToken(trimmedToken)
    setDeviceName(name.trim())

    // Clear stored device token so the fresh gateway token is used immediately
    try {
      const host = new URL(trimmedUrl).host
      await clearDeviceToken(host)
    } catch {
      // URL parsing failed or storage error — proceed anyway
    }

    // Try to connect
    setConnectPhase('connecting')
    try {
      await connect()
      // Check if pairing is required — connect() doesn't throw for NOT_PAIRED
      const state = useStore.getState()
      if (state.pairingStatus === 'pending') {
        setConnectPhase('idle')
        startAutoRetry()
        return  // Keep modal open
      }
      setConnectPhase('idle')
      setShowSettings(false)
      return
    } catch (err) {
      // First attempt failed — retry once
      setError(err instanceof Error ? err.message : 'Connection failed')
    }

    setConnectPhase('retrying')
    try {
      await connect()
      const state = useStore.getState()
      if (state.pairingStatus === 'pending') {
        setConnectPhase('idle')
        startAutoRetry()
        return  // Keep modal open
      }
      setError('')
      setConnectPhase('idle')
      setShowSettings(false)
      return
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    }

    // Start auto-retry cycle
    setConnectPhase('idle')
    startAutoRetry()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      setShowSettings(false)
    }
  }

  if (!showSettings) return null

  const originHelpBlock = (
    <div style={{ marginTop: '8px', fontSize: '12px', lineHeight: '1.5' }}>
      Your ClawControl origin must be allowed on the server. Run this on your OpenClaw host:
      <code style={{ display: 'block', padding: '8px', background: 'var(--bg-primary)', borderRadius: '6px', marginTop: '6px', fontSize: '11px', wordBreak: 'break-all' }}>
        {`openclaw config set gateway.controlUi.allowedOrigins '["${window.location.origin}"]'`}
      </code>
      <span style={{ display: 'block', marginTop: '4px' }}>Then restart the gateway for the change to take effect.</span>
      <a
        href="#"
        onClick={(e) => { e.preventDefault(); openExternal('https://docs.openclaw.ai/web/control-ui') }}
        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
      >
        Learn more
      </a>
    </div>
  )

  return (
    <div className="modal-overlay" onClick={() => setShowSettings(false)}>
      <div className="modal" data-testid="settings-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={() => setShowSettings(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '4px 0', marginBottom: connectionExpanded ? '8px' : '0' }}
            onClick={() => setConnectionExpanded(!connectionExpanded)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className={`status-indicator ${connected ? 'connected' : 'disconnected'}`} />
              <span style={{ fontWeight: 600, fontSize: '14px' }}>
                {connected ? 'Connected' : connecting ? 'Connecting...' : pairingStatus === 'pending' ? 'Pairing required' : 'Disconnected'}
              </span>
              {connected && !connectionExpanded && (
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {serverUrl}
                </span>
              )}
            </div>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transition: 'transform 0.2s', transform: connectionExpanded ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>

          {connectionExpanded && (
            <>
              {serverProfiles.length > 0 && (
                <div className="form-group" style={{ marginBottom: '16px' }}>
                  <label style={{ marginBottom: '8px', display: 'block' }}>Server Profiles</label>
                  <div className="server-profile-list">
                    {serverProfiles.map(profile => (
                      <div
                        key={profile.id}
                        className={`server-profile-item ${profile.id === activeProfileId ? 'active' : ''}`}
                        onClick={async () => {
                          if (profile.id !== activeProfileId) {
                            await switchProfile(profile.id)
                            // Sync local form state with the newly selected profile
                            setUrl(profile.serverUrl)
                            setMode(profile.authMode)
                            setName(profile.deviceName)
                            setToken('')
                            // Token will be loaded async by switchProfile
                            const { gatewayToken: newToken } = useStore.getState()
                            setToken(newToken)
                          }
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                          <span className={`status-indicator ${profile.id === activeProfileId && connected ? 'connected' : 'disconnected'}`} />
                          {editingProfileName === profile.id ? (
                            <input
                              className="profile-name-input"
                              value={profileNameDraft}
                              onChange={(e) => setProfileNameDraft(e.target.value)}
                              onBlur={() => {
                                const trimmed = profileNameDraft.trim()
                                if (trimmed) updateServerProfile(profile.id, { name: trimmed })
                                setEditingProfileName(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const trimmed = profileNameDraft.trim()
                                  if (trimmed) updateServerProfile(profile.id, { name: trimmed })
                                  setEditingProfileName(null)
                                } else if (e.key === 'Escape') {
                                  setEditingProfileName(null)
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              autoFocus
                            />
                          ) : (
                            <span
                              style={{ fontWeight: profile.id === activeProfileId ? 600 : 400, cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              onDoubleClick={(e) => {
                                e.stopPropagation()
                                setEditingProfileName(profile.id)
                                setProfileNameDraft(profile.name)
                              }}
                              title="Double-click to rename"
                            >
                              {profile.name}
                            </span>
                          )}
                          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={profile.serverUrl}>
                            {profile.serverUrl}
                          </span>
                        </div>
                        {serverProfiles.length > 1 && (
                          <button
                            className="profile-delete-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              setProfileToDelete({ id: profile.id, name: profile.name })
                            }}
                            title="Delete profile"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    className="btn btn-secondary"
                    style={{ marginTop: '8px', fontSize: '13px', padding: '6px 12px' }}
                    onClick={() => {
                      const newName = `Server ${serverProfiles.length + 1}`
                      const id = addServerProfile({
                        name: newName,
                        serverUrl: '',
                        authMode: 'token',
                        deviceName: ''
                      })
                      switchProfile(id)
                      setUrl('')
                      setMode('token')
                      setToken('')
                      setName('')
                    }}
                  >
                    + Add Server
                  </button>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="serverUrl">Server URL</label>
                <input
                  type="text"
                  id="serverUrl"
                  data-testid="settings-server-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="wss://your-server.local"
                  autoComplete="off"
                />
                <span className="form-hint">WebSocket URL (e.g., wss://your-server.local or ws://localhost:8080)</span>
              </div>

              <div className="form-group">
                <label htmlFor="deviceName">Device Name</label>
                <input
                  type="text"
                  id="deviceName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Jake's MacBook"
                  autoComplete="off"
                />
                <span className="form-hint">Optional — identifies this device in the OpenClaw devices list. Defaults to &quot;ClawControl&quot;.</span>
              </div>

              <div className="form-group">
                <label>Authentication Mode</label>
                <div className="auth-mode-toggle">
                  <button
                    type="button"
                    className={`toggle-btn ${mode === 'token' ? 'active' : ''}`}
                    onClick={() => setMode('token')}
                  >
                    Token
                  </button>
                  <button
                    type="button"
                    className={`toggle-btn ${mode === 'password' ? 'active' : ''}`}
                    onClick={() => setMode('password')}
                  >
                    Password
                  </button>
                </div>
                <span className="form-hint">Choose based on your server's gateway.auth.mode setting.</span>
              </div>

              <div className="form-group">
                <label htmlFor="gatewayToken">{mode === 'token' ? 'Gateway Token' : 'Gateway Password'}</label>
                <div className="input-with-icon">
                  <input
                    id="gatewayToken"
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={mode === 'token' ? 'Enter your gateway token' : 'Enter your gateway password'}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="input-icon-btn"
                    onClick={() => setShowToken(!showToken)}
                    title={showToken ? 'Hide' : 'Show'}
                    aria-label={showToken ? 'Hide password' : 'Show password'}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                      {showToken ? (
                        <>
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </>
                      ) : (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
                <span className="form-hint">Required if authentication is enabled on the server.</span>
              </div>

              {error && <div className="form-error">{error}{error.toLowerCase().includes('origin not allowed') && originHelpBlock}</div>}
              {!error && !connected && connectionError && (
                <div className="form-error">{connectionError}{connectionError.toLowerCase().includes('origin not allowed') && originHelpBlock}</div>
              )}
            </>
          )}

          {pairingStatus === 'pending' && (() => {
            const approveCmd = `openclaw devices approve ${pairingRequestId || '<request-id>'}`
            const canShare = typeof navigator.share === 'function' && getPlatform() !== 'electron'

            // Derive HTTP(S) URL from WebSocket URL for the /nodes approval page
            let nodesUrl = ''
            try {
              const wsUrl = new URL(serverUrl)
              const protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:'
              nodesUrl = `${protocol}//${wsUrl.host}/nodes`
            } catch {
              // Invalid URL, link won't be shown
            }

            const [copied, setCopied] = useState(false)
            const handleCopy = async () => {
              try {
                await clipboardWrite(approveCmd)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              } catch {
                // Clipboard unavailable
              }
            }

            const handleShare = async () => {
              try {
                await navigator.share({ text: approveCmd })
              } catch {
                // User cancelled or share not available
              }
            }

            return (
              <div className="form-group" style={{ background: 'var(--bg-secondary)', borderRadius: '8px', padding: '12px', border: '1px solid var(--border)' }}>
                <label style={{ fontWeight: 600, marginBottom: '8px', display: 'block' }}>Device Pairing Required</label>
                {nodesUrl ? (
                  <>
                    <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                      This device needs to be approved.{' '}
                      <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); openExternal(nodesUrl) }}
                        style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
                      >
                        Open this link and approve the &quot;ClawControl&quot; device
                      </a>
                    </p>
                    <p style={{ margin: '0 0 8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Or run this command on your OpenClaw server:
                    </p>
                  </>
                ) : (
                  <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    This device needs to be approved on the server. Run this command on your OpenClaw server:
                  </p>
                )}
                <div style={{ position: 'relative' }}>
                  <code style={{ display: 'block', padding: '14px', paddingRight: '56px', background: 'var(--bg-primary)', borderRadius: '10px', fontSize: '12px', wordBreak: 'break-all' }}>
                    {approveCmd}
                  </code>
                  <div style={{ position: 'absolute', top: '50%', right: '8px', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <button
                      onClick={handleCopy}
                      title={copied ? 'Copied!' : 'Copy command'}
                      style={{ width: '36px', height: '36px', borderRadius: '50%', border: '1px solid var(--border)', background: copied ? 'var(--accent)' : 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, transition: 'background 0.15s' }}
                    >
                      {copied ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                    {canShare && (
                      <button
                        onClick={handleShare}
                        title="Share command"
                        style={{ width: '36px', height: '36px', borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                          <polyline points="16 6 12 2 8 6" />
                          <line x1="12" y1="2" x2="12" y2="15" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginTop: '16px' }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleManualRetry}
                    disabled={connecting || connectPhase === 'retrying'}
                  >
                    {connecting || connectPhase === 'retrying' ? 'Connecting...' : 'Retry Connection'}
                  </button>
                  {autoRetryTimer && nextRetryIn > 0 && (
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Auto-retry in {nextRetryIn}s{autoRetryCount > 0 ? ` (attempt ${autoRetryCount}/5)` : ''}
                    </span>
                  )}
                  {!autoRetryTimer && autoRetryCount >= 5 && (
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Auto-retry expired. Click to retry manually.
                    </span>
                  )}
                </div>
              </div>
            )
          })()}

          <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Appearance</span>
              <label className="toggle-switch" style={{ marginLeft: '8px' }}>
                <input
                  type="checkbox"
                  checked={theme === 'dark'}
                  onChange={() => toggleTheme()}
                />
                <span className="toggle-slider"></span>
              </label>
            </label>
            <span className="form-hint">{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
          </div>

          <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Notifications</span>
              <label className="toggle-switch" style={{ marginLeft: '8px' }}>
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  onChange={(e) => setNotificationsEnabled(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </label>
            <span className="form-hint">Get notified when an agent responds</span>
          </div>

          <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Streaming</span>
              <label className="toggle-switch" style={{ marginLeft: '8px' }}>
                <input
                  type="checkbox"
                  checked={!streamingDisabled}
                  onChange={(e) => setStreamingDisabled(!e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </label>
            <span className="form-hint">Show responses as they stream in. When off, the full response appears at once.</span>
          </div>

          <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Node Mode</span>
              <label className="toggle-switch" style={{ marginLeft: '8px' }}>
                <input
                  type="checkbox"
                  checked={nodeEnabled}
                  onChange={(e) => setNodeEnabled(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
            </label>
            <span className="form-hint">Allow the AI agent to invoke commands on this device (clipboard, notifications, device info)</span>
            {nodeEnabled && (
              <button
                className="btn btn-secondary"
                style={{ marginTop: '8px', fontSize: '12px' }}
                onClick={() => setShowNodePermissions(true)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ marginRight: '6px' }}>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                Configure Permissions
              </button>
            )}
          </div>

          <NodePermissionsDialog
            open={showNodePermissions}
            onClose={() => setShowNodePermissions(false)}
          />

          {connected && (
            <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '16px' }}>
              <button
                className="btn btn-secondary server-settings-link"
                onClick={() => { setShowSettings(false); openServerSettings() }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" style={{ marginRight: '8px' }}>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                OpenClaw Server Settings
              </button>
              <span className="form-hint">Configure agent defaults, tools, memory, and channels</span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {connected && (
            <button className="btn btn-danger" onClick={() => disconnect()}>
              Disconnect
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => setShowSettings(false)}>
            {connected ? 'Close' : 'Cancel'}
          </button>
          {!connected && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
              <button className="btn btn-primary" data-testid="settings-connect-btn" onClick={handleSave} disabled={connectPhase !== 'idle'}>
                {connectPhase === 'connecting' ? 'Connecting...'
                  : connectPhase === 'retrying' ? 'Retrying...'
                  : connectPhase === 'failed' ? 'Failed...'
                  : 'Save & Connect'}
              </button>
              {pairingStatus !== 'pending' && autoRetryTimer && nextRetryIn > 0 && (
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  Auto-retry in {nextRetryIn}s{autoRetryCount > 0 ? ` (${autoRetryCount}/5)` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {profileToDelete && (
        <ConfirmDialog
          title="Delete Profile"
          message={`Delete profile "${profileToDelete.name}"? This will remove all saved connection settings for this profile.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            deleteServerProfile(profileToDelete.id)
            showToast('Profile deleted')
            setProfileToDelete(null)
          }}
          onCancel={() => setProfileToDelete(null)}
        />
      )}
    </div>
  )
}
