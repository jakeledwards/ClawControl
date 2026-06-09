import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

// Capacitor modules are only used on mobile; provide lightweight stubs for Electron builds
// so the production bundle resolves all imports (externals leave bare specifiers that the
// Electron renderer cannot resolve, causing a blank window).
const capacitorModules = [
  '@capacitor/core',
  '@capacitor/preferences',
  '@capacitor/browser',
  '@capacitor/app-launcher',
  '@capacitor/status-bar',
  '@capacitor/keyboard',
  '@capacitor/app',
  '@capacitor/local-notifications',
  '@capacitor/haptics',
  '@capacitor/splash-screen',
  '@capacitor-community/speech-recognition',
  'capacitor-native-websocket',
]

const STUB_PREFIX = '\0capacitor-stub:'

/** Vite plugin that resolves Capacitor imports to no-op stubs in the Electron renderer build. */
function capacitorStubPlugin(): Plugin {
  return {
    name: 'capacitor-stub',
    resolveId(id) {
      if (capacitorModules.includes(id)) {
        return STUB_PREFIX + id
      }
    },
    load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null
      const mod = id.slice(STUB_PREFIX.length)
      if (mod === '@capacitor/core') {
        return `export const Capacitor = { getPlatform: () => 'web', isNativePlatform: () => false, isPluginAvailable: () => false };`
      }
      if (mod === '@capacitor/haptics') {
        return `export const Haptics = { impact: async () => {} }; export const ImpactStyle = { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' };`
      }
      if (mod === '@capacitor/status-bar') {
        return `export const StatusBar = { setStyle: async () => {} }; export const Style = { Dark: 'DARK', Light: 'LIGHT' };`
      }
      if (mod === '@capacitor/splash-screen') {
        return `export const SplashScreen = { hide: async () => {} };`
      }
      if (mod === '@capacitor-community/speech-recognition') {
        return `export const SpeechRecognition = new Proxy({}, { get: () => async () => ({}) });`
      }
      if (mod === 'capacitor-native-websocket') {
        return `export const NativeWebSocket = new Proxy({}, { get: () => async () => ({}) });`
      }
      // Generic stub: derive PascalCase export name from the module's last path segment
      const name = mod.split('/').pop()!.replace(/-./g, m => m[1].toUpperCase())
      const pascalName = name.charAt(0).toUpperCase() + name.slice(1)
      return [
        `const handler = { get: () => async () => ({}) };`,
        `export const ${pascalName} = new Proxy({}, handler);`,
        `export default ${pascalName};`,
      ].join('\n')
    },
  }
}

const isVitest = process.env.VITEST === 'true' || !!process.env.VITEST_WORKER_ID

export default defineConfig({
  plugins: [
    capacitorStubPlugin(),
    react(),
    // Skip Electron plugins under Vitest so Node built-ins (fs, path, child_process)
    // aren't rewritten to the electron-renderer CJS shim, which breaks test imports.
    ...(isVitest
      ? []
      : [
          electron([
            {
              entry: 'electron/main.ts',
              onstart(options) {
                options.startup()
              },
              vite: {
                build: {
                  outDir: 'dist-electron',
                  rollupOptions: {
                    external: ['electron']
                  }
                }
              }
            },
            {
              entry: 'electron/preload.ts',
              onstart(options) {
                options.reload()
              },
              vite: {
                build: {
                  outDir: 'dist-electron'
                }
              }
            }
          ]),
          renderer()
        ])
  ],
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: [
      'src/**/*.{test,spec}.{js,ts,jsx,tsx}',
      'scripts/**/*.test.{js,ts}'
    ]
  }
})
