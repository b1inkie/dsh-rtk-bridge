/**
 * dsh-rtk-bridge — transparent `rtk` command rewriting for DeepSeek Harness.
 *
 * A port of the `rtk` half of pi-rtk-optimizer, adapted to the DSH tool
 * pipeline. DSH keeps `exec.arguments` immutable, so this plugin wraps the
 * writable `execute` of the registered shell tool (pwsh on Windows, bash on
 * POSIX) and hands the original body a rewritten command. Host behaviour —
 * schema, visibility, restrictions, sandbox policy, rendering, timeouts —
 * stays untouched, and every failure fails open to the original command.
 */

import { VERSION } from './version.js'
import { normalizeConfig } from './core.js'
import { createRtkEngine } from './engine.js'
import { createDispatchHandler, createExecuteWrapper, createSuggestDenier } from './wrap.js'

export const name = 'rtk-bridge'

/** The shell tools live in the `tools` registry; that is the only hard dependency. */
export const inject = ['tools']

/**
 * Build a logger facade from the Cordis logger service, falling back to console.
 * @param {any} ctx
 */
function makeLogger(ctx) {
  let base
  try {
    base = typeof ctx.logger === 'function' ? ctx.logger('dsh-rtk-bridge') : ctx.logger
  } catch {
    base = undefined
  }
  const emit = (level, message) => {
    try {
      if (base && typeof base[level] === 'function') base[level](message)
      else if (level === 'warn' || level === 'error') console.warn(message)
      else if (level === 'info') console.info(message)
    } catch {
      /* logging must never break tool execution */
    }
  }
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  }
}

/**
 * @param {any} ctx - Cordis plugin context.
 * @param {unknown} [rawConfig] - loader config from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = makeLogger(ctx)
  const platform = process.platform
  const stats = {
    wrappedCalls: 0,
    dispatchCalls: 0,
    rewrites: 0,
    failures: 0,
    fallbacks: 0,
    confinedSkips: 0,
    denies: 0,
    lastRewrite: /** @type {null | { from: string, to: string, at: number }} */ (null),
    lastDeny: /** @type {null | { from: string, to: string, at: number }} */ (null),
    lastError: /** @type {null | string} */ (null),
  }
  const engine = createRtkEngine({ config, platform, logger })
  /** @type {Map<any, Function>} definition object -> original execute */
  const originals = new Map()
  /** @type {Set<string>} */
  const patchedTools = new Set()
  /** @type {Set<string>} */
  const fallbackTools = new Set()
  /** @type {Set<string>} */
  const unpatchable = new Set()
  const deniedAt = new Map()
  let disposed = false

  const denier = createSuggestDenier({ config, engine, stats, logger, platform, deniedAt })

  /**
   * Resolve the calling session's sandbox mode. On Windows every confined mode
   * blocks rtk's child-output capture, so the plugin pauses rewriting there.
   * @param {any} exec
   * @returns {'confined' | 'unconfined' | 'unknown'}
   */
  function resolveConfinement(exec) {
    try {
      const policy = ctx.get('sandboxPolicy')
      if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return 'unknown'
      const session = exec?.agent?.session
      const resolved = session === undefined ? policy.resolve() : policy.resolve({ session })
      const mode = resolved?.mode
      if (mode === 'danger-full-access') return 'unconfined'
      if (mode === 'read-only' || mode === 'workspace-write') return 'confined'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Record that a tool cannot be wrapped and decide the fallback.
   * `auto` uses a `tools/execute` short-circuit; `patch` disables rewriting
   * for that tool (no pipeline bypass); `dispatch` handles it separately.
   * @param {string} toolName
   * @param {string} reason
   */
  function markFallback(toolName, reason) {
    if (config.intercept === 'patch') {
      if (!unpatchable.has(toolName)) {
        unpatchable.add(toolName)
        logger.warn(
          `[rtk-bridge] cannot wrap "${toolName}" (${reason}); ` +
            'intercept is "patch", so rewriting is disabled for that tool',
        )
      }
      return
    }
    if (!fallbackTools.has(toolName)) {
      fallbackTools.add(toolName)
      logger.warn(`[rtk-bridge] cannot wrap "${toolName}" (${reason}); using the tools/execute dispatch fallback`)
    }
  }

  /**
   * Wrap one registered shell tool definition in place.
   * @param {string} toolName
   * @param {any} [scope] - calling agent; tools may be registered per agent scope.
   */
  function patchTool(toolName, scope) {
    if (disposed || config.mode !== 'rewrite' || !config.enabled) return
    if (config.intercept === 'dispatch') {
      fallbackTools.add(toolName)
      return
    }
    if (fallbackTools.has(toolName)) return
    let definition
    let sameView
    try {
      definition = ctx.tools.get(toolName, scope)
      sameView = ctx.tools.get(toolName, scope)
    } catch {
      return
    }
    if (definition === undefined || definition === null || typeof definition.execute !== 'function') return
    if (definition !== sameView) {
      markFallback(toolName, 'the tool lookup returns a fresh object each time')
      return
    }
    if (originals.has(definition)) return
    const descriptor = Object.getOwnPropertyDescriptor(definition, 'execute')
    if (descriptor === undefined || descriptor.writable !== true) {
      markFallback(toolName, 'the definition is not writable')
      return
    }
    const original = definition.execute
    const wrapped = createExecuteWrapper({
      toolName,
      originalExecute: original,
      config,
      engine,
      stats,
      logger,
      platform,
      resolveConfinement,
    })
    try {
      definition.execute = wrapped
      // Verify that the view we will dispatch through sees the wrapper. A
      // clone/forwarding registry would otherwise accept the patch and use a
      // different object.
      if (ctx.tools.get(toolName, scope)?.execute !== wrapped) {
        definition.execute = original
        markFallback(toolName, 'the patched definition is not the dispatched view')
        return
      }
      originals.set(definition, original)
      patchedTools.add(toolName)
      if (config.debug) logger.info(`[rtk-bridge] wrapped tool "${toolName}"`)
    } catch (error) {
      try {
        definition.execute = original
      } catch {
        /* best effort */
      }
      markFallback(toolName, error instanceof Error ? error.message : String(error))
    }
  }

  function patchAll(scope) {
    for (const toolName of config.tools) patchTool(toolName, scope)
  }

  const dispatchFallback = createDispatchHandler({
    getTool: (name, scope) => ctx.tools.get(name, scope),
    config,
    engine,
    stats,
    logger,
    platform,
    env: process.env,
    resolveConfinement,
  })

  // Only tools whose primary wrapping seam is unavailable reach this listener.
  ctx.on('tools/execute', async (exec, next) => {
    if (disposed || !fallbackTools.has(exec?.name)) return next()
    return dispatchFallback(exec, next)
  })

  // A first attempt at apply time; the tool may not be registered yet, so the
  // pre-execute hook below is the authoritative lazy patcher.
  patchAll()

  // tools/pre-execute runs before dispatch, so patching here always lands
  // before the body that is about to run.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (disposed) return next()
    if (config.mode === 'rewrite') {
      patchAll(exec?.agent)
      return next()
    }
    if (config.mode === 'suggest' && exec !== null && typeof exec === 'object' && config.tools.includes(exec.name)) {
      const confinedWindows = platform === 'win32' && resolveConfinement(exec) === 'confined'
      if (confinedWindows && !config.rewriteWhenConfined) return next()
      const decision = await denier(exec)
      if (decision !== null) return decision
    }
    return next()
  })

  ctx.effect(() => () => {
    disposed = true
    for (const [definition, original] of originals) {
      try {
        definition.execute = original
      } catch {
        /* the definition was replaced; nothing to restore */
      }
    }
    originals.clear()
    patchedTools.clear()
    fallbackTools.clear()
  })

  // Warm the probe so `/rtk status` has an answer without waiting for a call.
  void engine.probe().catch(() => {})

  function describeBinary() {
    const status = engine.status()
    if (status.status === 'ok') return `${status.version} (${status.path})`
    if (status.status === 'unknown') return 'not probed yet'
    return `${status.status}${status.reason ? `: ${status.reason}` : ''}`
  }

  function formatCompact(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return String(value)
    if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
    if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}K`
    return String(number)
  }

  function describeStats() {
    const lines = [
      `wrapped shell calls: ${stats.wrappedCalls}`,
      `dispatch fallbacks: ${stats.dispatchCalls}`,
      `rewrites: ${stats.rewrites}`,
      `fallbacks: ${stats.fallbacks}`,
      `paused-by-sandbox: ${stats.confinedSkips}`,
      `failures: ${stats.failures}`,
      `suggest-denies: ${stats.denies}`,
    ]
    if (stats.lastRewrite !== null) {
      lines.push(`last rewrite: ${stats.lastRewrite.from} -> ${stats.lastRewrite.to}`)
    }
    if (stats.lastError !== null) lines.push(`last error: ${stats.lastError}`)
    return lines.join('\n')
  }

  function defaultSandboxMode() {
    try {
      const policy = ctx.get('sandboxPolicy')
      if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return 'unconfined'
      return policy.resolve()?.mode ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  function statusText() {
    const tools =
      config.mode === 'suggest'
        ? `${config.tools.join(', ')} (suggest mode, not wrapped)`
        : config.tools
            .map((toolName) => {
              if (fallbackTools.has(toolName)) return `${toolName} (dispatch fallback)`
              if (patchedTools.has(toolName)) return `${toolName} (wrapped)`
              if (unpatchable.has(toolName)) return `${toolName} (not writable)`
              return `${toolName} (not present)`
            })
            .join(', ')
    const sandbox = defaultSandboxMode()
    const paused = platform === 'win32' && sandbox !== 'danger-full-access' && sandbox !== 'unconfined'
    return [
      `dsh-rtk-bridge ${VERSION}`,
      `  enabled: ${config.enabled}`,
      `  mode: ${config.mode}`,
      `  intercept: ${config.intercept}`,
      `  rtk: ${describeBinary()}`,
      `  tools: ${tools}`,
      `  sandbox(default): ${sandbox}${paused && !config.rewriteWhenConfined ? '  [rewriting paused — Windows confined mode cannot pipe child output; use danger-full-access]' : ''}`,
      ...describeStats()
        .split('\n')
        .map((line) => `  ${line}`),
    ].join('\n')
  }

  const commands = (() => {
    try {
      return ctx.get('commands')
    } catch {
      return undefined
    }
  })()

  if (commands !== undefined && commands !== null && typeof commands.register === 'function') {
    let disposeCommand
    try {
      disposeCommand = commands.register({
          name: 'rtk',
          description: 'rtk-bridge status, verification, and runtime switches.',
          input: { hint: 'status | verify | rewrite <command> | gain | on | off | stats | help' },
          handler: async (invocation) => {
            const line = String(invocation?.rawInput ?? '').trim()
            const [verb = 'status', ...rest] = line === '' ? [] : line.split(/\s+/)
            switch (verb) {
              case 'status':
              case 'show':
                return { kind: 'success', text: statusText() }
              case 'verify': {
                const result = await engine.verify()
                if (result.status === 'ok') {
                  return { kind: 'success', text: `rtk ${result.version} at ${result.path}` }
                }
                return {
                  kind: 'error',
                  text: `rtk is not usable: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`,
                }
              }
              case 'rewrite': {
                const command = rest.join(' ').trim()
                if (command === '') return { kind: 'error', text: 'usage: /rtk rewrite <command>' }
                const result = await engine.rewrite(command, {})
                return result === null
                  ? { kind: 'success', text: `no rtk equivalent for: ${command}` }
                  : { kind: 'success', text: `${command}\n  -> ${result}` }
              }
              case 'on':
                config.enabled = true
                patchAll()
                return { kind: 'success', text: 'rtk-bridge enabled.' }
              case 'off':
                config.enabled = false
                for (const [definition, original] of originals) {
                  try {
                    definition.execute = original
                  } catch {
                    /* ignore */
                  }
                }
                originals.clear()
                patchedTools.clear()
                fallbackTools.clear()
                return { kind: 'success', text: 'rtk-bridge disabled; tools restored.' }
              case 'stats':
                return { kind: 'success', text: describeStats() }
              case 'gain': {
                const summary = await engine.gain()
                if (summary === null) {
                  return {
                    kind: 'error',
                    text: 'rtk gain is unavailable (rtk not ready, or this rtk version has no `gain --format json`).',
                  }
                }
                const commands = Number(summary.total_commands ?? 0)
                const input = Number(summary.total_input ?? 0)
                const output = Number(summary.total_output ?? 0)
                const saved = Number(summary.total_saved ?? 0)
                const percent = Number(summary.avg_savings_pct ?? 0)
                return {
                  kind: 'success',
                  text: [
                    "rtk global savings (from rtk's history.db, includes this and other rtk usage):",
                    `  commands: ${commands}`,
                    `  tokens:   ${formatCompact(input)} in -> ${formatCompact(output)} out`,
                    `  saved:    ${formatCompact(saved)} (${Number.isFinite(percent) ? percent.toFixed(1) : '?'}%)`,
                  ].join('\n'),
                }
              }
              case 'help':
              case '':
                return {
                  kind: 'success',
                  text: [
                    'dsh-rtk-bridge:',
                    '  /rtk status              configuration, rtk binary, and counters',
                    '  /rtk verify              re-probe the rtk binary now',
                    '  /rtk rewrite <command>   preview the rewritten command',
                    '  /rtk gain                rtk global savings summary (history.db)',
                    '  /rtk on | off            enable or disable rewriting at runtime',
                    '  /rtk stats               rewrite / failure counters',
                  ].join('\n'),
                }
              default:
                return { kind: 'error', text: `unknown /rtk subcommand "${verb}" (try /rtk help)` }
            }
          },
        })
    } catch (error) {
      logger.warn(`[rtk-bridge] could not register /rtk: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof disposeCommand === 'function') {
      try {
        ctx.effect(() => disposeCommand)
      } catch (error) {
        logger.warn(`[rtk-bridge] could not own /rtk disposal: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (config.debug) {
    logger.info(`[rtk-bridge] applied (mode=${config.mode}, tools=${config.tools.join(',')})`)
  }
}
