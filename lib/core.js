/**
 * Pure, dependency-free helpers for dsh-rtk-bridge.
 *
 * Everything in this module is deterministic and side-effect free so it can be
 * unit-tested with plain `node --test` without booting a Harness profile.
 */

import { join } from 'node:path'

/** @typedef {typeof DEFAULT_CONFIG} RtkOptimizerConfig */

export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch. */
  enabled: true,
  /**
   * `rewrite` wraps the live shell tool and executes the rtk-rewritten command.
   * `suggest` never patches a tool: it denies one call per command and returns
   * the rewritten command as corrective feedback (fallback for hosts whose tool
   * definitions are not writable).
   */
  mode: 'rewrite',
  /**
   * `auto` wraps the tool definition and falls back to a `tools/execute`
   * short-circuit when wrapping is impossible. `patch` never falls back.
   * `dispatch` always uses the short-circuit (no definition mutation).
   */
  intercept: 'auto',
  /** Shell tool names to intercept. Windows compositions expose `pwsh`; POSIX expose `bash`. */
  tools: Object.freeze(['pwsh', 'bash']),
  /** Explicit rtk executable. Empty means "discover from PATH and common install dirs". */
  rtkPath: '',
  /** Timeout for one `rtk rewrite` call. */
  timeoutMs: 2000,
  /** Timeout for the `rtk --version` probe. */
  probeTimeoutMs: 3000,
  /** Oldest rtk release that provides `rtk rewrite` (0.23.0). */
  minVersion: '0.23.0',
  /** Version used by `/rtk install`; `latest` or an exact `X.Y.Z`. */
  installVersion: 'latest',
  /** Release base used by `/rtk install`; override for a mirror. */
  downloadBase: 'https://github.com/rtk-ai/rtk/releases',
  /** Commands longer than this are passed through untouched (here-docs, generated scripts). */
  maxCommandChars: 8000,
  /** Extra rtk subcommands allowed on Windows beyond WINDOWS_SAFE_SUBCOMMANDS. */
  extraAllowedSubcommands: Object.freeze([]),
  /** rtk subcommands never to rewrite on any platform. */
  excludedSubcommands: Object.freeze([]),
  /** How long a "binary missing" probe result is trusted before retrying. */
  refreshMissingMs: 60000,
  /**
   * Windows only. Under DSH's confined sandbox (read-only / workspace-write) a
   * child process cannot capture another program's output through pipes, and
   * rtk captures every command it filters. Leave this off so rewritten commands
   * fail open instead of breaking; danger-full-access sessions rewrite normally.
   */
  rewriteWhenConfined: false,
  /** Verbose diagnostics through the host logger. */
  debug: false,
})

/**
 * rtk subcommands that work on Windows without a POSIX userland.
 * `rtk ls`, `rtk tree`, `rtk read`, `rtk grep`, `rtk rg`, `rtk find`, `rtk wc`,
 * `rtk stat`, `rtk du` proxy Unix binaries that do not exist on stock Windows,
 * so rewriting them would turn a working PowerShell alias into an error.
 */
export const WINDOWS_SAFE_SUBCOMMANDS = new Set([
  'aws', 'bun', 'bunx', 'cargo', 'ctest', 'curl', 'deps', 'diff', 'docker',
  'dotnet', 'env', 'err', 'format', 'gh', 'git', 'glab', 'jest', 'json',
  'kubectl', 'lint', 'log', 'next', 'npm', 'npx', 'oc', 'playwright', 'pnpm',
  'prettier', 'prisma', 'psql', 'test', 'tsc', 'vitest',
])

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/
const ENV_ASSIGNMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/
const RTK_SUBCOMMAND_RE = /\brtk\s+([A-Za-z0-9_-]+)/g

/**
 * Parse the first `X.Y.Z` in a version string.
 * @param {unknown} raw - e.g. `rtk 1.0.1`.
 * @returns {{ major: number, minor: number, patch: number, raw: string } | null}
 */
export function parseVersion(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const match = SEMVER_RE.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: match[0],
  }
}

/**
 * Compare two parsed versions.
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number} negative when a < b, zero when equal, positive when a > b.
 */
export function compareVersions(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch)
}

/**
 * Whether the command already targets rtk (optionally behind env assignments).
 * `rtk rewrite` happily returns `rtk git status` for `rtk git status`, so this
 * guard is what prevents an infinite/prefixed-twice rewrite.
 * @param {string} command
 * @returns {boolean}
 */
export function isAlreadyRtk(command) {
  const trimmed = String(command ?? '').trimStart()
  if (trimmed === '' || trimmed.startsWith('#')) return false
  if (/^rtk(?:\.exe|\.cmd)?(?:\s|$)/i.test(trimmed)) return true
  const envPrefix = ENV_ASSIGNMENT_RE.exec(trimmed)
  if (envPrefix === null) return false
  const rest = trimmed.slice(envPrefix[0].length)
  return /^rtk(?:\.exe|\.cmd)?(?:\s|$)/i.test(rest)
}

/**
 * Whether this command is worth asking rtk about.
 * Everything here is a cheap pre-filter; `rtk rewrite` remains the source of truth.
 * @param {string} command
 * @param {RtkOptimizerConfig} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function shouldAttempt(command, config, env = globalThis.process?.env ?? {}) {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (trimmed.length > config.maxCommandChars) return false
  if (env.RTK_DISABLED === '1') return false
  if (trimmed.startsWith('#')) return false
  return !isAlreadyRtk(trimmed)
}

/**
 * Extract every `rtk <subcommand>` occurrence from a rewritten command line.
 * @param {string} command
 * @returns {string[]}
 */
export function extractRtkSubcommands(command) {
  const subcommands = []
  RTK_SUBCOMMAND_RE.lastIndex = 0
  let match
  while ((match = RTK_SUBCOMMAND_RE.exec(String(command ?? ''))) !== null) {
    subcommands.push(match[1].toLowerCase())
  }
  return subcommands
}

/**
 * Validate an `rtk rewrite` result before it is allowed to replace the model's command.
 * @param {string} rewritten
 * @param {RtkOptimizerConfig} config
 * @param {string} [platform]
 * @returns {boolean}
 */
export function rewriteAllowed(rewritten, config, platform = globalThis.process?.platform) {
  if (typeof rewritten !== 'string') return false
  const text = rewritten.trim()
  if (text === '') return false
  // Reject control characters except tab/newline (rtk may return one line per input line).
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return false
  const subcommands = extractRtkSubcommands(text)
  if (subcommands.length === 0) return false
  const excluded = new Set(config.excludedSubcommands)
  const extra = new Set(config.extraAllowedSubcommands)
  for (const subcommand of subcommands) {
    if (excluded.has(subcommand)) return false
    if (platform === 'win32' && !WINDOWS_SAFE_SUBCOMMANDS.has(subcommand) && !extra.has(subcommand)) return false
  }
  return true
}

/**
 * Normalize a raw loader config object into a complete config.
 * Unknown fields are ignored; invalid values fall back to defaults instead of
 * failing the whole profile at boot.
 * @param {unknown} raw
 * @returns {RtkOptimizerConfig}
 */
export function normalizeConfig(raw) {
  const base = DEFAULT_CONFIG
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const stringList = (value, fallback) => {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    const out = list.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    return out.length > 0 ? out : [...fallback]
  }
  const positiveInt = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }
  return {
    enabled: input.enabled !== false,
    mode: input.mode === 'suggest' ? 'suggest' : 'rewrite',
    intercept: input.intercept === 'patch' || input.intercept === 'dispatch' ? input.intercept : 'auto',
    tools: stringList(input.tools, base.tools),
    rtkPath: typeof input.rtkPath === 'string' ? input.rtkPath.trim() : base.rtkPath,
    timeoutMs: positiveInt(input.timeoutMs, base.timeoutMs, 100, 30000),
    probeTimeoutMs: positiveInt(input.probeTimeoutMs, base.probeTimeoutMs, 500, 30000),
    minVersion: typeof input.minVersion === 'string' && SEMVER_RE.test(input.minVersion) ? input.minVersion : base.minVersion,
    installVersion:
      typeof input.installVersion === 'string' && (input.installVersion === 'latest' || SEMVER_RE.test(input.installVersion))
        ? input.installVersion.replace(/^v/, '')
        : base.installVersion,
    downloadBase:
      typeof input.downloadBase === 'string' && /^https:\/\//.test(input.downloadBase.trim())
        ? input.downloadBase.trim().replace(/\/+$/, '')
        : base.downloadBase,
    maxCommandChars: positiveInt(input.maxCommandChars, base.maxCommandChars, 100, 1_000_000),
    extraAllowedSubcommands: stringList(input.extraAllowedSubcommands, []).map((item) => item.toLowerCase()),
    excludedSubcommands: stringList(input.excludedSubcommands, []).map((item) => item.toLowerCase()),
    refreshMissingMs: positiveInt(input.refreshMissingMs, base.refreshMissingMs, 1000, 3_600_000),
    rewriteWhenConfined: input.rewriteWhenConfined === true,
    debug: input.debug === true,
  }
}

/** Lines rtk prints on stderr that are not command output. */
const RTK_NOISE_FRAGMENTS = [
  'No hook installed',
  'RTK_TRUST_PROJECT_FILTERS',
  'RTK_DISABLED=1 detected',
]

/**
 * Whether one stderr line is rtk's own advisory noise.
 * @param {string} line
 * @returns {boolean}
 */
export function isRtkNoiseLine(line) {
  if (!line.startsWith('[rtk]')) return false
  return RTK_NOISE_FRAGMENTS.some((fragment) => line.includes(fragment))
}

/**
 * Remove rtk's own advisory lines from one text blob.
 * @param {string} text
 * @returns {string}
 */
export function stripRtkNoiseText(text) {
  if (typeof text !== 'string' || text === '') return text
  const lines = text.split(/\r?\n/)
  const kept = lines.filter((line) => !isRtkNoiseLine(line))
  if (kept.length === lines.length) return text
  const cleaned = kept.join('\n')
  return cleaned.trim() === '' ? '' : cleaned
}

/**
 * Remove rtk's own advisory lines from the result of a shell tool. Handles the
 * canonical one-shot result object (`{ kind: 'foreground', stderr: { text } }`)
 * and the plain-string result of the persistent pwsh tool.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cleanRtkOutput(value) {
  if (typeof value === 'string') return /** @type {T} */ (stripRtkNoiseText(value))
  if (!value || typeof value !== 'object') return value
  if (value.kind !== 'foreground') return value
  const stderr = value.stderr
  if (!stderr || typeof stderr.text !== 'string' || stderr.text === '') return value
  const text = stripRtkNoiseText(stderr.text)
  if (text === stderr.text) return value
  return { ...value, stderr: { ...stderr, text } }
}

/**
 * Detect the specific failure where rtk could not create the child process at
 * all (confined Windows token, missing target binary). In that case the
 * command never ran, so the plugin can safely retry the original command once.
 * @param {any} value - canonical shell-tool result.
 * @returns {boolean}
 */
export function isRtkSpawnFailure(value) {
  const text =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && value.kind === 'foreground'
        ? [value.stderr?.text, value.stdout?.text]
            .filter((part) => typeof part === 'string' && part !== '')
            .join('\n')
        : ''
  if (text === '') return false
  if (!/rtk: (?:Failed to run|search failed|Failed to resolve)/.test(text)) return false
  return /Failed to execute command|program not found|os error 5|Access is denied|拒绝访问|EPERM|ENOENT/i.test(text)
}

/**
 * Session working directory for a tool execution, when the host exposes one.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } } } | undefined} exec
 * @returns {string | undefined}
 */
export function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Path of the rtk binary installed by `/rtk install`.
 * @param {{ platform?: string, dshHome: string }} options
 * @returns {string}
 */
export function managedRtkPath(options) {
  const platform = options.platform ?? process.platform
  return join(options.dshHome, 'rtk-bridge', 'bin', platform === 'win32' ? 'rtk.exe' : 'rtk')
}
