/**
 * Tool-execution interception.
 *
 * DSH deliberately keeps `exec.arguments` immutable (`tools/pre-execute` may
 * only allow/deny/ask), so a plugin cannot rewrite the logged call. There are
 * two seams that can still change what runs:
 *
 * 1. `execute` wrapping (primary): replace the writable `execute` function of
 *    the registered tool definition. The whole `tools/execute` chain — timeout,
 *    retry, metrics — stays intact.
 * 2. `tools/execute` short-circuit (fallback): if the definition is frozen or
 *    the registry stops returning the dispatched object, resolve the tool and
 *    call its body with a rewritten argument object. This is used only for
 *    tools where wrapping failed, because not calling `next()` skips any later
 *    `tools/execute` wrappers.
 *
 * Both paths fail open to the original command.
 */

import { cleanRtkOutput, isRtkSpawnFailure, rewriteAllowed, sessionCwd, shouldAttempt } from './core.js'

/**
 * Decide whether one call should be rewritten and build the effective args.
 * Shared by the execute wrapper and the dispatch fallback.
 *
 * @param {{
 *   toolName: string,
 *   args: any,
 *   exec: any,
 *   config: import('./core.js').RtkOptimizerConfig,
 *   engine: { rewrite: (command: string, context?: { cwd?: string, signal?: AbortSignal }) => Promise<string | null> },
 *   stats: any,
 *   logger?: { debug?: Function, info?: Function, warn?: Function },
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   resolveConfinement?: (exec: any) => 'confined' | 'unconfined' | 'unknown',
 * }} options
 * @returns {Promise<{ rewritten: string | null, originalCommand: string | null, effectiveArgs: any }>}
 */
export async function planRewrite(options) {
  const { toolName, args, exec, config, engine, stats } = options
  const logger = options.logger ?? {}
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const resolveConfinement = options.resolveConfinement

  let rewritten = null
  let originalCommand = null

  try {
    const command = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : null
    const confinement = resolveConfinement === undefined ? 'unknown' : resolveConfinement(exec)
    const confinedWindows = platform === 'win32' && confinement === 'confined'
    const aborted = exec?.signal?.aborted === true

    if (aborted) {
      // The call is already cancelled; do not spend a process on rewriting.
    } else if (confinedWindows && !config.rewriteWhenConfined) {
      stats.confinedSkips = (stats.confinedSkips ?? 0) + 1
      if (config.debug && stats.confinedSkips === 1) {
        logger.info?.(
          '[rtk-bridge] confined Windows sandbox detected; rewriting is paused ' +
            '(rtk cannot capture child output through the restricted token). ' +
            'Use a danger-full-access session, or set rewriteWhenConfined: true.',
        )
      }
    } else if (command !== null && config.enabled && shouldAttempt(command, config, env)) {
      const candidate = await engine.rewrite(command, {
        cwd: sessionCwd(exec),
        signal: exec?.signal,
      })
      if (candidate !== null && candidate !== command && rewriteAllowed(candidate, config, platform)) {
        rewritten = candidate
        originalCommand = command
      }
    }
  } catch (error) {
    stats.failures = (stats.failures ?? 0) + 1
    stats.lastError = error instanceof Error ? error.message : String(error)
    if (config.debug) logger.warn?.(`[rtk-bridge] rewrite failed on ${toolName}: ${stats.lastError}`)
  }

  return {
    rewritten,
    originalCommand,
    effectiveArgs: rewritten === null ? args : { ...args, command: rewritten },
  }
}

/**
 * Record a successful rewrite for status reporting.
 * @param {any} stats
 * @param {string | null} originalCommand
 * @param {string} rewritten
 */
function recordRewrite(stats, originalCommand, rewritten) {
  stats.rewrites = (stats.rewrites ?? 0) + 1
  stats.lastRewrite = { from: originalCommand, to: rewritten, at: Date.now() }
}

/**
 * Build the function that replaces `definition.execute` for one shell tool.
 *
 * @param {{
 *   toolName: string,
 *   originalExecute: (args: any, exec: any) => any,
 *   config: import('./core.js').RtkOptimizerConfig,
 *   engine: { rewrite: Function },
 *   stats: any,
 *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   resolveConfinement?: (exec: any) => 'confined' | 'unconfined' | 'unknown',
 * }} options
 * @returns {(this: unknown, args: any, exec: any) => Promise<any>}
 */
export function createExecuteWrapper(options) {
  const { toolName, originalExecute, config, engine, stats } = options
  const logger = options.logger ?? {}

  return async function rtkOptimizerExecute(args, exec) {
    stats.wrappedCalls = (stats.wrappedCalls ?? 0) + 1
    const plan = await planRewrite({ ...options, toolName, args, exec })

    const value = await originalExecute.call(this, plan.effectiveArgs, exec)
    if (plan.rewritten === null) return value

    // rtk never started the target command (confined token, missing binary):
    // the original command is still safe to run once, so fail open instead of
    // surfacing an rtk-internal error.
    if (isRtkSpawnFailure(value)) {
      stats.fallbacks = (stats.fallbacks ?? 0) + 1
      stats.lastError = 'rtk could not start the command; re-ran the original'
      if (config.debug) logger.warn?.(`[rtk-bridge] rtk could not start ${plan.originalCommand}; falling back`)
      return originalExecute.call(this, args, exec)
    }

    recordRewrite(stats, plan.originalCommand, plan.rewritten)
    if (config.debug) logger.info?.(`[rtk-bridge] ${plan.originalCommand} -> ${plan.rewritten}`)
    return cleanRtkOutput(value)
  }
}

/**
 * Build an error envelope the tool registry accepts from a `tools/execute`
 * wrapper (same shape the documented dispatch path normalizes).
 * @param {unknown} error
 */
function errorEnvelope(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

/**
 * Fallback for tools whose `execute` cannot be wrapped: intercept at
 * `tools/execute`, call the tool body with rewritten arguments, and return a
 * canonical-enough envelope for the registry to render.
 *
 * Tradeoff: not calling `next()` skips later `tools/execute` wrappers
 * (notably the tool-call timeout policy). This path is therefore used only
 * when the primary wrapping seam is unavailable.
 *
 * @param {{
 *   getTool: (name: string, scope?: unknown) => { execute?: Function } | undefined,
 *   config: import('./core.js').RtkOptimizerConfig,
 *   engine: { rewrite: Function },
 *   stats: any,
 *   logger?: { debug?: Function, info?: Function, warn?: Function },
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   resolveConfinement?: (exec: any) => 'confined' | 'unconfined' | 'unknown',
 * }} options
 * @returns {(exec: any, next: () => Promise<any>) => Promise<any>}
 */
export function createDispatchHandler(options) {
  const { getTool, config, engine, stats } = options
  const logger = options.logger ?? {}

  return async function rtkDispatchFallback(exec, next) {
    if (!config.enabled || config.mode !== 'rewrite') return next()
    stats.dispatchCalls = (stats.dispatchCalls ?? 0) + 1

    const plan = await planRewrite({
      ...options,
      toolName: exec?.name ?? 'shell',
      args: exec?.arguments,
      exec,
    })
    if (plan.rewritten === null) return next()

    let definition
    try {
      definition = getTool(exec.name, exec.agent)
    } catch {
      definition = undefined
    }
    if (definition === undefined || definition === null || typeof definition.execute !== 'function') {
      return next()
    }

    let value
    try {
      value = await definition.execute(plan.effectiveArgs, exec)
    } catch (error) {
      // The body was invoked; do not retry it. Surface the same error the
      // normal dispatch path would have produced.
      return errorEnvelope(error)
    }

    if (isRtkSpawnFailure(value)) {
      stats.fallbacks = (stats.fallbacks ?? 0) + 1
      stats.lastError = 'rtk could not start the command; fell back to normal dispatch'
      if (config.debug) logger.warn?.(`[rtk-bridge] rtk could not start ${plan.originalCommand}; falling back`)
      return next()
    }

    recordRewrite(stats, plan.originalCommand, plan.rewritten)
    if (config.debug) logger.info?.(`[rtk-bridge] (dispatch) ${plan.originalCommand} -> ${plan.rewritten}`)
    return { isError: false, value: cleanRtkOutput(value) }
  }
}

/**
 * Fallback for `mode: "suggest"`: deny one call per command and hand the model
 * the rewritten command. Used when the host's tool definitions are not
 * writable, and offered as an explicit config choice.
 *
 * @param {{
 *   config: import('./core.js').RtkOptimizerConfig,
 *   engine: { rewrite: Function },
 *   stats: { denies: number, lastDeny: null | { from: string, to: string, at: number }, failures: number, lastError: string | null },
 *   logger?: { warn?: Function },
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   deniedAt?: Map<string, number>,
 *   cooldownMs?: number,
 * }} options
 * @returns {(exec: any) => Promise<{ kind: 'deny', reason: string } | null>}
 */
export function createSuggestDenier(options) {
  const { config, engine, stats } = options
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const deniedAt = options.deniedAt ?? new Map()
  const cooldownMs = options.cooldownMs ?? 30_000

  return async function suggestRewrite(exec) {
    const command = exec?.arguments?.command
    if (typeof command !== 'string' || !config.enabled || !shouldAttempt(command, config, env)) return null
    let candidate = null
    try {
      candidate = await engine.rewrite(command, { cwd: sessionCwd(exec), signal: exec?.signal })
    } catch (error) {
      stats.failures += 1
      stats.lastError = error instanceof Error ? error.message : String(error)
      return null
    }
    if (candidate === null || candidate === command || !rewriteAllowed(candidate, config, platform)) return null
    const last = deniedAt.get(command) ?? 0
    if (Date.now() - last < cooldownMs) return null
    deniedAt.set(command, Date.now())
    if (deniedAt.size > 64) {
      const oldest = deniedAt.keys().next().value
      if (oldest !== undefined) deniedAt.delete(oldest)
    }
    stats.denies += 1
    stats.lastDeny = { from: command, to: candidate, at: Date.now() }
    return {
      kind: 'deny',
      reason: `[rtk-bridge] Run the rtk-rewritten command instead:\n${candidate}`,
    }
  }
}
