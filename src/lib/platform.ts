// Platform abstraction layer
// Provides a unified API across Electron, Capacitor (iOS/Android), and web browsers

import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { Browser } from '@capacitor/browser'
import { StatusBar, Style } from '@capacitor/status-bar'
import { Keyboard } from '@capacitor/keyboard'
import { App } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Haptics, ImpactStyle } from '@capacitor/haptics'

// NOTE: iOS WKWebView doesn't provide CommonJS `require`, so this must be an ESM import.
// We still gate usage to iOS in createWebSocketFactory().
import { NativeWebSocketWrapper } from './native-websocket'

export type PlatformType = 'electron' | 'ios' | 'android' | 'web'

export function getPlatform(): PlatformType {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    return 'electron'
  }
  const native = Capacitor.getPlatform()
  if (native === 'ios') return 'ios'
  if (native === 'android') return 'android'
  return 'web'
}

export function isNativeMobile(): boolean {
  return Capacitor.isNativePlatform()
}

export function isMobile(): boolean {
  const p = getPlatform()
  return p === 'ios' || p === 'android'
}

// Token storage
const TOKEN_KEY = 'clawcontrol-auth-token'

export async function saveToken(token: string): Promise<void> {
  const platform = getPlatform()

  if (platform === 'electron' && (window as any).electronAPI?.saveToken) {
    await (window as any).electronAPI.saveToken(token)
    return
  }

  if (isNativeMobile()) {
    await Preferences.set({ key: TOKEN_KEY, value: token })
    return
  }

  // Web fallback - localStorage (not ideal for security but functional)
  localStorage.setItem(TOKEN_KEY, token)
}

export async function getToken(): Promise<string> {
  const platform = getPlatform()

  if (platform === 'electron' && (window as any).electronAPI?.getToken) {
    return await (window as any).electronAPI.getToken()
  }

  if (isNativeMobile()) {
    const result = await Preferences.get({ key: TOKEN_KEY })
    return result.value || ''
  }

  return localStorage.getItem(TOKEN_KEY) || ''
}

export async function clearToken(): Promise<void> {
  if (isNativeMobile()) {
    await Preferences.remove({ key: TOKEN_KEY })
    return
  }
  localStorage.removeItem(TOKEN_KEY)
}

// External link handling
export async function openExternal(url: string): Promise<void> {
  const platform = getPlatform()

  if (platform === 'electron' && (window as any).electronAPI?.openExternal) {
    await (window as any).electronAPI.openExternal(url)
    return
  }

  if (isNativeMobile()) {
    await Browser.open({ url })
    return
  }

  window.open(url, '_blank')
}

// Certificate trust (only available on Electron)
export async function trustHost(hostname: string): Promise<{ trusted: boolean; hostname: string }> {
  if ((window as any).electronAPI?.trustHost) {
    return await (window as any).electronAPI.trustHost(hostname)
  }
  // On mobile/web, certificate trust is handled by the OS
  return { trusted: false, hostname }
}

// Native WebSocket factory for iOS (TLS certificate handling)
export interface TLSFactoryOptions {
  required?: boolean
  expectedFingerprint?: string
  allowTOFU?: boolean
  storeKey?: string
}

/**
 * Returns a WebSocket factory that uses the native plugin on iOS (for TLS cert handling),
 * or undefined on all other platforms (client falls back to browser WebSocket).
 */
export function createWebSocketFactory(tlsOptions?: TLSFactoryOptions): ((url: string) => any) | undefined {
  const platform = getPlatform()
  if (platform !== 'ios') return undefined

  // Gate usage to iOS (other platforms fall back to browser WebSocket).
  return (url: string) => {
    return new NativeWebSocketWrapper(url, tlsOptions)
  }
}

/** Clear a stored TLS fingerprint (iOS only). */
export async function clearTLSFingerprint(storeKey: string): Promise<void> {
  const platform = getPlatform()
  if (platform !== 'ios') return

  try {
    const { NativeWebSocket } = await import('capacitor-native-websocket')
    await NativeWebSocket.clearStoredFingerprint({ storeKey })
  } catch {
    // Plugin not available
  }
}

// Haptic feedback (mobile only)
const HAPTIC_STYLES = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
} as const

export async function triggerHaptic(style: 'light' | 'medium' | 'heavy' = 'medium'): Promise<void> {
  if (!isNativeMobile()) return
  try {
    await Haptics.impact({ style: HAPTIC_STYLES[style] })
  } catch {
    // Haptics not available
  }
}

// Status bar management (mobile only)
export async function setStatusBarStyle(isDark: boolean): Promise<void> {
  if (!isNativeMobile()) return

  try {
    await StatusBar.setStyle({
      style: isDark ? Style.Dark : Style.Light
    })

    const platform = getPlatform()
    if (platform === 'android') {
      await StatusBar.setBackgroundColor({
        color: isDark ? '#06080a' : '#f0f3f6'
      })
    }
  } catch {
    // StatusBar not available
  }
}

// Keyboard handling (mobile only)
export function setupKeyboardListeners(
  onShow?: (height: number) => void,
  onHide?: () => void
): () => void {
  if (!isNativeMobile()) return () => {}

  const showListener = Keyboard.addListener('keyboardWillShow', (info) => {
    onShow?.(info.keyboardHeight)
  })
  const hideListener = Keyboard.addListener('keyboardWillHide', () => {
    onHide?.()
  })

  return () => {
    showListener.then(l => l.remove())
    hideListener.then(l => l.remove())
  }
}

// App lifecycle (mobile only)
export function setupAppListeners(
  onResume?: () => void,
  onPause?: () => void
): () => void {
  if (!isNativeMobile()) return () => {}

  const resumeListener = App.addListener('resume', () => {
    onResume?.()
  })
  const pauseListener = App.addListener('pause', () => {
    onPause?.()
  })

  return () => {
    resumeListener.then(l => l.remove())
    pauseListener.then(l => l.remove())
  }
}

// Handle Android back button
export function setupBackButton(handler: () => void): () => void {
  if (getPlatform() !== 'android') return () => {}

  const listener = App.addListener('backButton', ({ canGoBack }) => {
    if (!canGoBack) {
      App.exitApp()
    } else {
      handler()
    }
  })

  return () => {
    listener.then(l => l.remove())
  }
}

// Get config (replaces electronAPI.getConfig)
export async function getConfig(): Promise<{ defaultUrl?: string; theme?: string }> {
  const platform = getPlatform()

  if (platform === 'electron' && (window as any).electronAPI?.getConfig) {
    return await (window as any).electronAPI.getConfig()
  }

  // On mobile/web, config comes from Preferences
  if (isNativeMobile()) {
    const url = await Preferences.get({ key: 'clawcontrol-default-url' })
    const theme = await Preferences.get({ key: 'clawcontrol-theme' })
    return {
      defaultUrl: url.value || undefined,
      theme: theme.value || undefined
    }
  }

  return {}
}

export async function isEncryptionAvailable(): Promise<boolean> {
  if ((window as any).electronAPI?.isEncryptionAvailable) {
    return await (window as any).electronAPI.isEncryptionAvailable()
  }
  // On mobile, Preferences uses UserDefaults (iOS) / SharedPreferences (Android)
  // which are sandboxed but not encrypted. Returns false to reflect this.
  if (isNativeMobile()) return false
  return false
}

// Notifications
export async function requestNotificationPermission(): Promise<boolean> {
  const platform = getPlatform()

  if (platform === 'electron') {
    return true
  }

  if (isNativeMobile()) {
    try {
      let perms = await LocalNotifications.checkPermissions()
      if (perms.display === 'granted') return true
      if (perms.display === 'denied') return false
      perms = await LocalNotifications.requestPermissions()
      return perms.display === 'granted'
    } catch {
      return false
    }
  }

  // Web
  if (typeof Notification !== 'undefined') {
    const result = await Notification.requestPermission()
    return result === 'granted'
  }
  return false
}

let _notificationIdCounter = 1

export async function showNotification(title: string, body: string): Promise<void> {
  const platform = getPlatform()

  if (platform === 'electron') {
    await (window as any).electronAPI?.showNotification(title, body)
    return
  }

  if (isNativeMobile()) {
    await LocalNotifications.schedule({
      notifications: [{
        title,
        body,
        id: _notificationIdCounter++
      }]
    })
    return
  }

  // Web
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, { body })
  }
}

// Subagent popout window
export interface SubagentPopoutParams {
  sessionKey: string
  serverUrl: string
  authToken: string
  authMode: string
  label: string
}

export async function openSubagentPopout(params: SubagentPopoutParams): Promise<void> {
  const platform = getPlatform()

  if (platform === 'electron' && (window as any).electronAPI?.openSubagentPopout) {
    await (window as any).electronAPI.openSubagentPopout(params)
    return
  }

  // Fallback for web/mobile: open in new tab with hash params
  const hash = `#subagent?sessionKey=${encodeURIComponent(params.sessionKey)}&serverUrl=${encodeURIComponent(params.serverUrl)}&authToken=${encodeURIComponent(params.authToken)}&authMode=${encodeURIComponent(params.authMode)}`
  window.open(`${window.location.origin}${window.location.pathname}${hash}`, '_blank')
}

// Tool call popout window
export interface ToolCallPopoutParams {
  toolCallId: string
  name: string
}

export async function openToolCallPopout(params: ToolCallPopoutParams): Promise<void> {
  const platform = getPlatform()

  if (platform === 'electron' && (window as any).electronAPI?.openToolCallPopout) {
    await (window as any).electronAPI.openToolCallPopout(params)
    return
  }

  // Fallback for web/mobile: open in new tab with hash params
  const hash = `#toolcall?id=${encodeURIComponent(params.toolCallId)}`
  window.open(`${window.location.origin}${window.location.pathname}${hash}`, '_blank')
}

// CORS-safe fetch (proxied through Electron main process, direct fetch elsewhere)
export async function corsFetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<string> {
  const platform = getPlatform()

  if (platform === 'electron' && (window as any).electronAPI?.fetchUrl) {
    return await (window as any).electronAPI.fetchUrl(url, options)
  }

  // Fallback: direct fetch (works on mobile / web if CORS is allowed)
  const res = await fetch(url, {
    method: options?.method,
    headers: options?.headers,
    body: options?.body
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

// App visibility tracking
let _appIsActive = true

export function isAppActive(): boolean {
  return _appIsActive
}

export function setupAppVisibilityTracking(): () => void {
  if (isNativeMobile()) {
    const resumeListener = App.addListener('resume', () => {
      _appIsActive = true
    })
    const pauseListener = App.addListener('pause', () => {
      _appIsActive = false
    })
    return () => {
      resumeListener.then(l => l.remove())
      pauseListener.then(l => l.remove())
    }
  }

  // Desktop / Web: use visibilitychange
  const handler = () => {
    _appIsActive = document.visibilityState === 'visible'
  }
  document.addEventListener('visibilitychange', handler)
  return () => {
    document.removeEventListener('visibilitychange', handler)
  }
}
