import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from './store'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { TopBar } from './components/TopBar'
import { RightPanel } from './components/RightPanel'
import { InputArea } from './components/InputArea'
import { SettingsModal } from './components/SettingsModal'
import { CertErrorModal } from './components/CertErrorModal'
import { SkillDetailView } from './components/SkillDetailView'
import { CronJobDetailView } from './components/CronJobDetailView'
import { CreateCronJobView } from './components/CreateCronJobView'
import { AgentDetailView } from './components/AgentDetailView'
import { CreateAgentView } from './components/CreateAgentView'
import { ClawHubSkillDetailView } from './components/ClawHubSkillDetailView'
import { HookDetailView } from './components/HookDetailView'
import { ServerSettingsView } from './components/ServerSettingsView'
import { ServerProfileTabs } from './components/ServerProfileTabs'
import { UsageView } from './components/UsageView'
import { NodesView } from './components/NodesView'
import { AgentDashboard } from './components/AgentDashboard'
import { CanvasPanel } from './components/CanvasPanel'
import { MobileGestureLayer } from './components/MobileGestureLayer'
import { ToastContainer } from './components/ToastContainer'
import {
  isNativeMobile,
  getPlatform,
  setStatusBarStyle,
  setupKeyboardListeners,
  setupAppListeners,
  setupBackButton,
  setupAppVisibilityTracking
} from './lib/platform'
import { SplashScreen } from '@capacitor/splash-screen'

function App() {
  const { theme, initializeApp, sidebarOpen, rightPanelOpen, mainView } = useStore(useShallow(state => ({
    theme: state.theme,
    initializeApp: state.initializeApp,
    sidebarOpen: state.sidebarOpen,
    rightPanelOpen: state.rightPanelOpen,
    mainView: state.mainView,
  })))

  useEffect(() => {
    initializeApp()
  }, [initializeApp])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)

    // Update mobile status bar to match theme
    if (isNativeMobile()) {
      setStatusBarStyle(theme === 'dark')
    }
  }, [theme])

  // App visibility tracking (all platforms)
  useEffect(() => {
    const cleanup = setupAppVisibilityTracking()
    return cleanup
  }, [])

  // Mobile platform initialization
  useEffect(() => {
    if (!isNativeMobile()) return

    // Hide splash screen now that the app has rendered
    SplashScreen.hide()

    // Add mobile classes for CSS targeting
    document.documentElement.classList.add('capacitor-mobile-html')
    document.body.classList.add('capacitor-mobile')
    if (getPlatform() === 'android') {
      document.body.classList.add('platform-android')
    }

    // Keyboard handling.
    // On Android, the native MainActivity handles keyboard resizing by setting
    // the WebView container's bottom margin, so 100dvh adapts automatically.
    // On iOS, we use JS keyboard listeners to adjust layout manually.
    const isAndroid = getPlatform() === 'android'
    const cleanupKeyboard = isAndroid ? (() => {}) : setupKeyboardListeners(
      (height) => {
        const fullHeight = window.innerHeight
        document.body.classList.add('keyboard-visible')
        document.documentElement.style.setProperty('--keyboard-height', `${height}px`)
        document.documentElement.style.setProperty('--app-height', `${fullHeight - height}px`)
        window.scrollTo(0, 0)
      },
      () => {
        document.body.classList.remove('keyboard-visible')
        document.documentElement.style.setProperty('--keyboard-height', '0px')
        document.documentElement.style.setProperty('--app-height', '')
        window.scrollTo(0, 0)
      }
    )

    // App lifecycle - reconnect on resume
    const cleanupApp = setupAppListeners(
      async () => {
        const { connected, connect, client } = useStore.getState()
        if (!connected) {
          connect()
          return
        }
        // The OS may have killed the socket while backgrounded without
        // firing onclose. Verify with a round-trip; reconnect if it's dead.
        const alive = await client?.probe()
        if (!alive && useStore.getState().client === client) connect()
      }
    )

    // Android back button
    const cleanupBack = setupBackButton(() => {
      const state = useStore.getState()
      if (state.mainView !== 'chat') {
        state.closeDetailView()
        return true
      } else if (state.sidebarOpen) {
        state.setSidebarOpen(false)
        return true
      } else if (state.rightPanelOpen) {
        state.setRightPanelOpen(false)
        return true
      }
      return false
    })

    return () => {
      cleanupKeyboard()
      cleanupApp()
      cleanupBack()
      document.documentElement.classList.remove('capacitor-mobile-html')
      document.body.classList.remove('capacitor-mobile')
    }
  }, [])

  const content = (
    <div className="app">
      <Sidebar />

      <main className="main-content">
        <ServerProfileTabs />
        <TopBar />
        <ErrorBoundary>
          {mainView === 'chat' && (
            <div className="chat-canvas-layout">
              <div className="chat-column">
                <ChatArea />
                <InputArea />
              </div>
              <CanvasPanel />
            </div>
          )}
          {mainView === 'skill-detail' && <SkillDetailView />}
          {mainView === 'cron-detail' && <CronJobDetailView />}
          {mainView === 'create-cron' && <CreateCronJobView />}
          {mainView === 'agent-detail' && <AgentDetailView />}
          {mainView === 'create-agent' && <CreateAgentView />}
          {mainView === 'clawhub-skill-detail' && <ClawHubSkillDetailView />}
          {mainView === 'hook-detail' && <HookDetailView />}
          {mainView === 'server-settings' && <ServerSettingsView />}
          {mainView === 'usage' && <UsageView />}
          {mainView === 'nodes' && <NodesView />}
          {mainView === 'pixel-dashboard' && <AgentDashboard />}
        </ErrorBoundary>
      </main>

      <RightPanel />

      {/* Overlay for mobile */}
      <div
        className={`overlay ${sidebarOpen || rightPanelOpen ? 'active' : ''}`}
        onClick={() => {
          useStore.getState().setSidebarOpen(false)
          useStore.getState().setRightPanelOpen(false)
        }}
      />

      {/* Settings Modal */}
      <SettingsModal />

      {/* Certificate Error Modal */}
      <CertErrorModal />

      {/* Toast Notifications */}
      <ToastContainer />
    </div>
  )

  return isNativeMobile() ? (
    <MobileGestureLayer>{content}</MobileGestureLayer>
  ) : content
}

export default App
