// OpenClaw Client - Server Config API Methods

import type { RpcCaller } from './types'

/**
 * Reads the full server config via config.get.
 * Returns the raw config object and the hash needed for config.patch.
 */
export async function getServerConfig(call: RpcCaller): Promise<{ config: any; hash: string }> {
  const result = await call<any>('config.get', {})
  const config = result?.config ?? null
  const hash = result?.hash ?? ''
  return { config, hash }
}

/**
 * Patches the server config via config.patch.
 * Uses baseHash for optimistic conflict detection.
 * Note: config.patch triggers a server restart via SIGUSR1.
 *
 * v2026.3.28+ accepts a direct `patch` object; earlier servers only accept
 * a stringified `raw` payload and reject unknown root properties.
 */
export async function patchServerConfig(
  call: RpcCaller,
  patch: object,
  baseHash: string,
  useObjectPatch: boolean = false
): Promise<void> {
  const params = useObjectPatch
    ? { patch, baseHash }
    : { raw: JSON.stringify(patch), baseHash }
  await call<any>('config.patch', params)
}

/**
 * Returns true if the given server version string is >= v2026.3.28,
 * which introduced the direct-object `patch` parameter for config.patch.
 */
export function supportsObjectConfigPatch(serverVersion: string | null | undefined): boolean {
  if (!serverVersion) return false
  const m = serverVersion.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (year !== 2026) return year > 2026
  if (month !== 3) return month > 3
  return day >= 28
}

/**
 * Validates a config patch without applying it (v2026.3.22 dry-run).
 * Returns structured validation errors if any.
 */
export async function validateServerConfig(
  call: RpcCaller,
  patch: object,
  baseHash: string
): Promise<{ valid: boolean; errors?: Array<{ path: string; message: string }> }> {
  try {
    const result = await call<any>('config.patch', { raw: JSON.stringify(patch), baseHash, dryRun: true })
    const errors = result?.errors
    if (Array.isArray(errors) && errors.length > 0) {
      return { valid: false, errors }
    }
    return { valid: true }
  } catch (err: any) {
    return { valid: false, errors: [{ path: '', message: err?.message || 'Validation failed' }] }
  }
}
