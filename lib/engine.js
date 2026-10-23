/**
 * rtk process adapter: discover the binary, probe its version, and call
 * `rtk rewrite`. All host I/O is injected so the module is unit-testable.
 */

import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync as nodeExistsSync } from 'node:fs'
import { homedir as nodeHomedir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { compareVersions, parseVersion } from './core.js'

const VERSION_CACHE_MS = 5 * 60_000

/**
 * @typedef {{ code: number | null, stdout: string, stderr: string, error?: any }} ExecResult
 * @typedef {{ status: 'unknown' | 'ok' | 'missing' | 'too-old' | 'error', path: string | null, version: string | null, reason: string | null, checkedAt: number }} RtkStatus
 */

/**
 * Promisified `execFile` that never rejects on non-zero exits.
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} options
 * @returns {Promise<ExecResult>}
 */
export function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve) => {
    nodeExecFile(
      file,
      args,
      { windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024, ...options },
      (error, stdout, stderr) => {
        let code = 0
        if (error) {
          code = typeof error.code === 'number' ? error.code : typeof error.exitCode === 'number' ? error.exitCode : null
        }
        resolve({
          code,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          ...(error ? { error } : {}),
        })
      },
    )
  })
}

/**
 * Candidate rtk executables in preference order. `rtk` (PATH) always comes
 * after an explicit config path, then the install locations used by the
 * official installer, cargo, and WinGet.
 * @param {{ config: { rtkPath: string }, platform?: string, env?: NodeJS.ProcessEnv, exists?: (path: string) => boolean, home?: string }} options
 * @returns {string[]}
 */
export function candidateExecutables(options) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? nodeExistsSync
  const home = options.home ?? env.USERPROFILE ?? env.HOME ?? nodeHomedir()
  const candidates = []
  const push = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  if (options.config.rtkPath) push(options.config.rtkPath)
  const envBin =
    [env.DSH_RTK_BIN, env.RTK_BIN]
      .find((value) => typeof value === 'string' && value.trim() !== '')
      ?.trim() ?? ''
  if (envBin !== '') push(envBin)
  push('rtk')
  if (platform === 'win32') {
    push(pathJoin(home, '.local', 'bin', 'rtk.exe'))
    push(pathJoin(home, '.cargo', 'bin', 'rtk.exe'))
    if (env.LOCALAPPDATA) push(pathJoin(env.LOCALAPPDATA, 'Programs', 'rtk', 'rtk.exe'))
    if (env.LOCALAPPDATA) push(pathJoin(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'rtk.exe'))
  } else {
    push(pathJoin(home, '.local', 'bin', 'rtk'))
    push(pathJoin(home, '.cargo', 'bin', 'rtk'))
    push('/usr/local/bin/rtk')
    push('/opt/homebrew/bin/rtk')
  }
  return candidates.filter(
    (candidate) =>
      candidate === 'rtk' ||
      candidate === envBin ||
      candidate === options.config.rtkPath ||
      !exists ||
      exists(candidate),
  )
}

/**
 * Create the rtk engine used by the plugin (and by its tests).
 *
 * @param {{
 *   config: import('./core.js').RtkOptimizerConfig,
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   exec?: (file: string, args: string[], options?: any) => Promise<ExecResult>,
 *   exists?: (path: string) => boolean,
 *   home?: string,
 *   now?: () => number,
 *   logger?: { debug?: Function, warn?: Function },
 * }} options
 */
export function createRtkEngine(options) {
  const config = options.config
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exec = options.exec ?? defaultExecFile
  const exists = options.exists ?? nodeExistsSync
  const home = options.home
  const now = options.now ?? Date.now
  const logger = options.logger ?? {}

  /** @type {RtkStatus} */
  let state = { status: 'unknown', path: null, version: null, reason: null, checkedAt: 0 }
  let probing = null

  function reset() {
    state = { status: 'unknown', path: null, version: null, reason: null, checkedAt: 0 }
  }

  /** @returns {RtkStatus} */
  function status() {
    return { ...state }
  }

  function cacheFresh() {
    if (state.status === 'unknown' || state.checkedAt === 0) return false
    const ttl = state.status === 'ok' ? VERSION_CACHE_MS : config.refreshMissingMs
    return now() - state.checkedAt < ttl
  }

  async function probeOnce() {
    const candidates = candidateExecutables({ config, platform, env, exists, home })
    const minVersion = parseVersion(config.minVersion) ?? { major: 0, minor: 23, patch: 0 }
    let lastReason = null
    for (const candidate of candidates) {
      const result = await exec(candidate, ['--version'], {
        timeout: config.probeTimeoutMs,
        env,
      })
      if (result.error?.code === 'ENOENT' || result.error?.code === 'EACCES') {
        continue
      }
      if (result.code !== 0) {
        lastReason = result.stderr.trim() || result.error?.message || `exit ${result.code ?? 'unknown'}`
        continue
      }
      const parsed = parseVersion(result.stdout)
      if (parsed === null) {
        lastReason = `cannot parse version from ${JSON.stringify(result.stdout.trim())}`
        continue
      }
      if (compareVersions(parsed, minVersion) < 0) {
        state = {
          status: 'too-old',
          path: candidate,
          version: parsed.raw,
          reason: `rtk ${parsed.raw} is older than ${config.minVersion} (no \`rtk rewrite\`)`,
          checkedAt: now(),
        }
        return state
      }
      state = { status: 'ok', path: candidate, version: parsed.raw, reason: null, checkedAt: now() }
      return state
    }
    state = {
      status: lastReason === null ? 'missing' : 'error',
      path: null,
      version: null,
      reason: lastReason,
      checkedAt: now(),
    }
    return state
  }

  /**
   * Probe once and cache. Concurrent callers share one probe.
   * @param {boolean} [force]
   * @returns {Promise<RtkStatus>}
   */
  async function probe(force = false) {
    if (!force && cacheFresh()) return status()
    if (probing !== null) return probing
    probing = (async () => {
      try {
        return await probeOnce()
      } catch (error) {
        state = {
          status: 'error',
          path: null,
          version: null,
          reason: error instanceof Error ? error.message : String(error),
          checkedAt: now(),
        }
        return state
      } finally {
        probing = null
      }
    })()
    return probing
  }

  /**
   * Rewrite one command through rtk. Returns the trimmed rewritten command, or
   * null for "no equivalent / rtk unavailable / rtk error". Never throws.
   * @param {string} command
   * @param {{ cwd?: string, signal?: AbortSignal }} [context]
   * @returns {Promise<string | null>}
   */
  async function rewrite(command, context = {}) {
    const current = await probe(false)
    if (current.status !== 'ok' || current.path === null) return null
    const result = await exec(current.path, ['rewrite', command], {
      timeout: config.timeoutMs,
      cwd: context.cwd,
      signal: context.signal,
      env: { ...env, NO_COLOR: '1', RTK_TELEMETRY_DISABLED: '1' },
    })
    if (context.signal?.aborted || result.error?.name === 'AbortError') return null
    if (result.code !== 0 && result.code !== 3) {
      if (config.debug && result.error) {
        logger.warn?.(`[rtk-bridge] rtk rewrite failed for ${JSON.stringify(command)}: ${result.error.message ?? result.error}`)
      }
      return null
    }
    const rewritten = result.stdout.trim()
    return rewritten === '' ? null : rewritten
  }

  /** Force a fresh probe, e.g. from `/rtk verify`. */
  function verify() {
    return probe(true)
  }

  /**
   * Read rtk's own global savings summary (`rtk gain --format json`). This is
   * an independent, cross-tool view from rtk's history database — useful to
   * verify that rewriting really happened. Returns null when the installed rtk
   * has no JSON output or the call fails.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function gain() {
    const current = await probe(false)
    if (current.status !== 'ok' || current.path === null) return null
    try {
      const result = await exec(current.path, ['gain', '--format', 'json'], {
        timeout: config.probeTimeoutMs,
        env,
      })
      if (result.code !== 0) return null
      const parsed = JSON.parse(result.stdout)
      const summary = parsed?.summary
      return summary !== null && typeof summary === 'object' ? summary : null
    } catch {
      return null
    }
  }

  return { status, probe, verify, rewrite, gain, reset }
}
