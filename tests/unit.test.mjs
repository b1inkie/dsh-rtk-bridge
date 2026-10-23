import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  cleanRtkOutput,
  compareVersions,
  extractRtkSubcommands,
  isAlreadyRtk,
  isRtkNoiseLine,
  isRtkSpawnFailure,
  normalizeConfig,
  parseVersion,
  rewriteAllowed,
  sessionCwd,
  shouldAttempt,
} from '../lib/core.js'
import { candidateExecutables, createRtkEngine } from '../lib/engine.js'
import { createDispatchHandler, createExecuteWrapper, createSuggestDenier } from '../lib/wrap.js'
import { VERSION } from '../lib/version.js'

const here = fileURLToPath(new URL('.', import.meta.url))

test('parseVersion / compareVersions', () => {
  assert.deepEqual(parseVersion('rtk 1.0.1'), { major: 1, minor: 0, patch: 1, raw: '1.0.1' })
  assert.equal(parseVersion('nope'), null)
  assert.ok(compareVersions({ major: 0, minor: 23, patch: 0 }, { major: 0, minor: 23, patch: 0 }) === 0)
  assert.ok(compareVersions({ major: 0, minor: 22, patch: 9 }, { major: 0, minor: 23, patch: 0 }) < 0)
})

test('isAlreadyRtk covers plain and env-prefixed commands', () => {
  assert.equal(isAlreadyRtk('rtk git status'), true)
  assert.equal(isAlreadyRtk('  rtk git status'), true)
  assert.equal(isAlreadyRtk('RTK.EXE git status'), true)
  assert.equal(isAlreadyRtk('FOO=1 BAR="x y" rtk git status'), true)
  assert.equal(isAlreadyRtk('FOO=1 rtk.exe git status'), true)
  assert.equal(isAlreadyRtk('rtkfoo'), false)
  assert.equal(isAlreadyRtk('echo rtk'), false)
  assert.equal(isAlreadyRtk(''), false)
})

test('shouldAttempt skips empty, comments, huge commands, and RTK_DISABLED', () => {
  const config = normalizeConfig({})
  assert.equal(shouldAttempt('git status', config, {}), true)
  assert.equal(shouldAttempt('   ', config, {}), false)
  assert.equal(shouldAttempt('# comment', config, {}), false)
  assert.equal(shouldAttempt('git status', config, { RTK_DISABLED: '1' }), false)
  assert.equal(shouldAttempt('x'.repeat(config.maxCommandChars + 1), config, {}), false)
  assert.equal(shouldAttempt('rtk git status', config, {}), false)
})

test('rewriteAllowed enforces the Windows subcommand allowlist', () => {
  const config = normalizeConfig({})
  assert.equal(rewriteAllowed('rtk git status', config, 'win32'), true)
  assert.equal(rewriteAllowed('rtk ls -la', config, 'win32'), false)
  assert.equal(rewriteAllowed('rtk grep foo a.txt', config, 'win32'), false)
  assert.equal(rewriteAllowed('rtk ls -la', config, 'linux'), true)
  assert.equal(rewriteAllowed('echo hello', config, 'linux'), false)
  assert.equal(rewriteAllowed('cd x; rtk git status; rtk npm run build', config, 'win32'), true)
  assert.equal(rewriteAllowed('cd x; rtk git status; rtk ls', config, 'win32'), false)
  const extra = normalizeConfig({ extraAllowedSubcommands: ['ls'] })
  assert.equal(rewriteAllowed('rtk ls', extra, 'win32'), true)
  const excluded = normalizeConfig({ excludedSubcommands: ['git'] })
  assert.equal(rewriteAllowed('rtk git status', excluded, 'linux'), false)
})

test('extractRtkSubcommands', () => {
  assert.deepEqual(extractRtkSubcommands('rtk git status'), ['git'])
  assert.deepEqual(extractRtkSubcommands('cd x && rtk npm run build'), ['npm'])
  assert.deepEqual(extractRtkSubcommands('echo rtk'), [])
})

test('cleanRtkOutput strips rtk advisory lines from stderr', () => {
  const value = {
    kind: 'foreground',
    exitCode: 0,
    stderr: {
      text: '[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings\nreal error\n',
      truncated: false,
    },
  }
  const cleaned = cleanRtkOutput(value)
  assert.equal(cleaned.stderr.text, 'real error\n')
  const untouched = cleanRtkOutput({ kind: 'background', jobId: 'x' })
  assert.deepEqual(untouched, { kind: 'background', jobId: 'x' })
  assert.equal(isRtkNoiseLine('[rtk] /!\\ No hook installed — run'), true)
  assert.equal(isRtkNoiseLine('[rtk] something useful'), false)
  assert.equal(
    isRtkSpawnFailure({
      kind: 'foreground',
      stderr: { text: 'rtk: Failed to run git status: Failed to execute command: Access is denied. (os error 5)' },
    }),
    true,
  )
  assert.equal(isRtkSpawnFailure({ kind: 'foreground', stderr: { text: 'normal error' } }), false)
  assert.equal(isRtkSpawnFailure('rtk: Failed to run ls: program not found'), true)
  assert.equal(cleanRtkOutput('[rtk] /!\\ No hook installed\nreal line\n'), 'real line\n')
  assert.equal(cleanRtkOutput('plain output'), 'plain output')
})

test('normalizeConfig tolerates junk and clamps values', () => {
  const config = normalizeConfig({
    enabled: 'nope',
    mode: 'weird',
    tools: 'pwsh',
    timeoutMs: 1,
    maxCommandChars: 1e9,
    excludedSubcommands: [' LS '],
    debug: 1,
  })
  assert.equal(config.enabled, true)
  assert.equal(config.mode, 'rewrite')
  assert.equal(config.intercept, 'auto')
  assert.deepEqual(config.tools, ['pwsh'])
  assert.equal(config.timeoutMs, 100)
  assert.equal(config.maxCommandChars, 1_000_000)
  assert.deepEqual(config.excludedSubcommands, ['ls'])
  assert.equal(config.debug, false)
  assert.equal(normalizeConfig({ intercept: 'dispatch' }).intercept, 'dispatch')
  assert.equal(normalizeConfig({ intercept: 'nope' }).intercept, 'auto')
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG)
})

test('candidateExecutables prefers the configured path and skips missing ones', () => {
  const config = normalizeConfig({ rtkPath: 'C:/tools/rtk.exe' })
  const candidates = candidateExecutables({
    config,
    platform: 'win32',
    env: { USERPROFILE: 'C:/Users/me', LOCALAPPDATA: 'C:/Users/me/AppData/Local' },
    exists: (path) => path === 'C:/tools/rtk.exe' || path.replaceAll('\\', '/') === 'C:/Users/me/.local/bin/rtk.exe',
  })
  assert.equal(candidates[0], 'C:/tools/rtk.exe')
  assert.ok(candidates.some((candidate) => candidate.endsWith('rtk.exe') && candidate.includes('.local')))
  assert.ok(candidates.includes('rtk'))
})

test('candidateExecutables honors RTK_BIN and DSH_RTK_BIN', () => {
  const candidates = candidateExecutables({
    config: normalizeConfig({}),
    platform: 'win32',
    env: { RTK_BIN: 'C:/custom/rtk.exe', USERPROFILE: 'C:/Users/me' },
    exists: () => true,
  })
  assert.equal(candidates[0], 'C:/custom/rtk.exe')
  assert.ok(candidates.includes('rtk'))

  const dshPreferred = candidateExecutables({
    config: normalizeConfig({}),
    platform: 'win32',
    env: { DSH_RTK_BIN: 'C:/dsh/rtk.exe', RTK_BIN: 'C:/custom/rtk.exe', USERPROFILE: 'C:/Users/me' },
    exists: () => true,
  })
  assert.equal(dshPreferred[0], 'C:/dsh/rtk.exe')

  const configWins = candidateExecutables({
    config: normalizeConfig({ rtkPath: 'C:/config/rtk.exe' }),
    platform: 'win32',
    env: { DSH_RTK_BIN: 'C:/dsh/rtk.exe' },
    exists: () => true,
  })
  assert.equal(configWins[0], 'C:/config/rtk.exe')
})

test('engine probes rtk and accepts exit code 3 rewrites', async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    if (args[0] === '--version') return { code: 0, stdout: 'rtk 1.0.1\n', stderr: '' }
    if (args[0] === 'rewrite') return { code: 3, stdout: 'rtk git status\n', stderr: '' }
    return { code: 1, stdout: '', stderr: '' }
  }
  const config = normalizeConfig({ rtkPath: 'C:/tools/rtk.exe' })
  const engine = createRtkEngine({ config, platform: 'win32', env: {}, exec, exists: () => true })
  const status = await engine.probe()
  assert.equal(status.status, 'ok')
  assert.equal(status.version, '1.0.1')
  assert.equal(await engine.rewrite('git status', { cwd: 'C:/repo' }), 'rtk git status')
  assert.deepEqual(calls.at(-1), ['C:/tools/rtk.exe', 'rewrite', 'git status'])
})

test('engine reports missing and too-old binaries', async () => {
  const missing = createRtkEngine({
    config: normalizeConfig({ rtkPath: 'C:/nope/rtk.exe' }),
    platform: 'win32',
    env: {},
    exec: async () => ({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
    exists: () => true,
  })
  assert.equal((await missing.probe()).status, 'missing')
  assert.equal(await missing.rewrite('git status'), null)

  const old = createRtkEngine({
    config: normalizeConfig({ rtkPath: 'C:/tools/rtk.exe' }),
    platform: 'win32',
    env: {},
    exec: async () => ({ code: 0, stdout: 'rtk 0.22.1\n', stderr: '' }),
    exists: () => true,
  })
  const oldStatus = await old.probe()
  assert.equal(oldStatus.status, 'too-old')
  assert.match(oldStatus.reason, /0\.23\.0/)
})

test('engine reads rtk gain summary', async () => {
  const engine = createRtkEngine({
    config: normalizeConfig({ rtkPath: 'C:/tools/rtk.exe' }),
    platform: 'win32',
    env: {},
    exists: () => true,
    exec: async (file, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'rtk 1.0.1', stderr: '' }
      if (args[0] === 'gain') {
        assert.deepEqual(args, ['gain', '--format', 'json'])
        return { code: 0, stdout: JSON.stringify({ summary: { total_commands: 12, total_saved: 3456 } }), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    },
  })
  const summary = await engine.gain()
  assert.equal(summary.total_commands, 12)
  assert.equal(summary.total_saved, 3456)
})

test('engine rewrite returns null on no-match and aborts cleanly', async () => {
  const config = normalizeConfig({ rtkPath: 'C:/tools/rtk.exe' })
  let mode = 'nomatch'
  const engine = createRtkEngine({
    config,
    platform: 'win32',
    env: {},
    exists: () => true,
    exec: async (file, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'rtk 1.0.1', stderr: '' }
      if (mode === 'nomatch') return { code: 1, stdout: '', stderr: '' }
      const error = Object.assign(new Error('aborted'), { name: 'AbortError' })
      return { code: null, stdout: '', stderr: '', error }
    },
  })
  assert.equal(await engine.rewrite('echo hi'), null)
  mode = 'abort'
  const controller = new AbortController()
  controller.abort()
  assert.equal(await engine.rewrite('git status', { signal: controller.signal }), null)
})

test('execute wrapper runs the rewritten command and cleans output', async () => {
  const seen = []
  const originalExecute = async function (args) {
    seen.push(args)
    return {
      kind: 'foreground',
      exitCode: 0,
      stdout: { text: '* main\nclean\n', truncated: false },
      stderr: { text: '[rtk] /!\\ No hook installed — run `rtk init -g`\n', truncated: false },
    }
  }
  const stats = { rewrites: 0, failures: 0, fallbacks: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const config = normalizeConfig({})
  const wrapped = createExecuteWrapper({
    toolName: 'pwsh',
    originalExecute,
    config,
    engine: { rewrite: async () => 'rtk git status' },
    stats,
    platform: 'win32',
  })
  const value = await wrapped({ command: 'git status', description: 'status' }, {})
  assert.equal(seen[0].command, 'rtk git status')
  assert.equal(seen[0].description, 'status')
  assert.equal(value.stderr.text, '')
  assert.equal(stats.wrappedCalls, 1)
  assert.equal(stats.rewrites, 1)
  assert.deepEqual(stats.lastRewrite.from, 'git status')
})

test('execute wrapper cleans string results (persistent pwsh)', async () => {
  const stats = { rewrites: 0, failures: 0, fallbacks: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const wrapped = createExecuteWrapper({
    toolName: 'pwsh',
    originalExecute: async () => '[rtk] /!\\ No hook installed — run `rtk init -g`\n* master\n',
    config: normalizeConfig({}),
    engine: { rewrite: async () => 'rtk git status' },
    stats,
    platform: 'win32',
  })
  const value = await wrapped({ command: 'git status' }, {})
  assert.equal(value, '* master\n')
  assert.equal(stats.wrappedCalls, 1)
  assert.equal(stats.rewrites, 1)
})

test('execute wrapper fails open', async () => {
  const seen = []
  const originalExecute = async (args) => {
    seen.push(args)
    return { kind: 'foreground' }
  }
  const config = normalizeConfig({})
  const stats = { rewrites: 0, failures: 0, fallbacks: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const failing = createExecuteWrapper({
    toolName: 'pwsh',
    originalExecute,
    config,
    engine: { rewrite: async () => { throw new Error('boom') } },
    stats,
    platform: 'win32',
  })
  await failing({ command: 'git status' }, {})
  assert.equal(seen[0].command, 'git status')
  assert.equal(stats.failures, 1)

  const disallowed = createExecuteWrapper({
    toolName: 'pwsh',
    originalExecute,
    config,
    engine: { rewrite: async () => 'rtk ls -la' },
    stats,
    platform: 'win32',
  })
  await disallowed({ command: 'ls -la' }, {})
  assert.equal(seen[1].command, 'ls -la')
})

test('execute wrapper pauses under a confined Windows sandbox', async () => {
  const seen = []
  let rewriteCalls = 0
  const originalExecute = async (args) => {
    seen.push(args)
    return { kind: 'foreground' }
  }
  const stats = { rewrites: 0, failures: 0, fallbacks: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const wrapped = createExecuteWrapper({
    toolName: 'pwsh',
    originalExecute,
    config: normalizeConfig({}),
    engine: { rewrite: async () => { rewriteCalls += 1; return 'rtk git status' } },
    stats,
    platform: 'win32',
    resolveConfinement: () => 'confined',
  })
  await wrapped({ command: 'git status' }, {})
  assert.equal(rewriteCalls, 0)
  assert.equal(seen[0].command, 'git status')
  assert.equal(stats.confinedSkips, 1)
})

test('execute wrapper skips rewriting for an already-aborted call', async () => {
  const seen = []
  let rewriteCalls = 0
  const wrapped = createExecuteWrapper({
    toolName: 'pwsh',
    originalExecute: async (args) => {
      seen.push(args.command)
      return { kind: 'foreground' }
    },
    config: normalizeConfig({}),
    engine: { rewrite: async () => { rewriteCalls += 1; return 'rtk git status' } },
    stats: { rewrites: 0, failures: 0, fallbacks: 0, confinedSkips: 0, lastRewrite: null, lastError: null },
    platform: 'win32',
  })
  const controller = new AbortController()
  controller.abort()
  await wrapped({ command: 'git status' }, { signal: controller.signal })
  assert.equal(rewriteCalls, 0)
  assert.deepEqual(seen, ['git status'])
})

test('execute wrapper falls back when rtk cannot spawn the command', async () => {
  const seen = []
  let calls = 0
  const originalExecute = async (args) => {
    seen.push(args.command)
    calls += 1
    if (calls === 1) {
      return {
        kind: 'foreground',
        exitCode: 1,
        stdout: { text: '', truncated: false },
        stderr: {
          text: '[rtk] /!\\ No hook installed\nrtk: Failed to run git status: Failed to execute command: 拒绝访问。 (os error 5)',
          truncated: false,
        },
      }
    }
    return {
      kind: 'foreground',
      exitCode: 0,
      stdout: { text: 'On branch master', truncated: false },
      stderr: { text: '', truncated: false },
    }
  }
  const stats = { rewrites: 0, failures: 0, fallbacks: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const wrapped = createExecuteWrapper({
    toolName: 'pwsh',
    originalExecute,
    config: normalizeConfig({ rewriteWhenConfined: true }),
    engine: { rewrite: async () => 'rtk git status' },
    stats,
    platform: 'win32',
    resolveConfinement: () => 'confined',
  })
  const value = await wrapped({ command: 'git status' }, {})
  assert.deepEqual(seen, ['rtk git status', 'git status'])
  assert.equal(value.stdout.text, 'On branch master')
  assert.equal(stats.fallbacks, 1)
  assert.equal(stats.rewrites, 0)
})

test('dispatch fallback executes the rewritten command and returns an envelope', async () => {
  const calls = []
  const definition = {
    execute: async (args) => {
      calls.push(args.command)
      return { kind: 'foreground', stderr: { text: '[rtk] /!\\ No hook installed\n' } }
    },
  }
  const stats = { dispatchCalls: 0, rewrites: 0, fallbacks: 0, failures: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const handler = createDispatchHandler({
    getTool: () => definition,
    config: normalizeConfig({ intercept: 'dispatch' }),
    engine: { rewrite: async () => 'rtk git status' },
    stats,
    platform: 'win32',
  })
  let nexted = false
  const result = await handler(
    { name: 'pwsh', arguments: { command: 'git status' }, signal: new AbortController().signal },
    async () => {
      nexted = true
      return { isError: false }
    },
  )
  assert.equal(nexted, false)
  assert.deepEqual(calls, ['rtk git status'])
  assert.equal(result.isError, false)
  assert.equal(result.value.stderr.text, '')
  assert.equal(stats.dispatchCalls, 1)
  assert.equal(stats.rewrites, 1)
})

test('dispatch fallback delegates when there is nothing to rewrite', async () => {
  const stats = { dispatchCalls: 0, rewrites: 0, fallbacks: 0, failures: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const handler = createDispatchHandler({
    getTool: () => ({ execute: async () => 'never' }),
    config: normalizeConfig({}),
    engine: { rewrite: async () => null },
    stats,
    platform: 'win32',
  })
  let nexted = false
  const result = await handler(
    { name: 'pwsh', arguments: { command: 'Get-ChildItem' }, signal: new AbortController().signal },
    async () => {
      nexted = true
      return { isError: false, marker: 'next' }
    },
  )
  assert.equal(nexted, true)
  assert.equal(result.marker, 'next')
})

test('dispatch fallback converts a throwing body into an error envelope', async () => {
  const stats = { dispatchCalls: 0, rewrites: 0, fallbacks: 0, failures: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const handler = createDispatchHandler({
    getTool: () => ({ execute: async () => { throw new Error('boom') } }),
    config: normalizeConfig({}),
    engine: { rewrite: async () => 'rtk git status' },
    stats,
    platform: 'win32',
  })
  const result = await handler(
    { name: 'pwsh', arguments: { command: 'git status' }, signal: new AbortController().signal },
    async () => ({ isError: false }),
  )
  assert.equal(result.isError, true)
  assert.equal(result.error.message, 'boom')
  assert.match(result.content[0].text, /Error: boom/)
})

test('dispatch fallback falls back to normal dispatch when rtk cannot spawn', async () => {
  const stats = { dispatchCalls: 0, rewrites: 0, fallbacks: 0, failures: 0, confinedSkips: 0, lastRewrite: null, lastError: null }
  const handler = createDispatchHandler({
    getTool: () => ({
      execute: async () => ({
        kind: 'foreground',
        stderr: { text: 'rtk: Failed to run git status: Failed to execute command: Access is denied. (os error 5)' },
      }),
    }),
    config: normalizeConfig({ rewriteWhenConfined: true }),
    engine: { rewrite: async () => 'rtk git status' },
    stats,
    platform: 'win32',
  })
  let nexted = false
  const result = await handler(
    { name: 'pwsh', arguments: { command: 'git status' }, signal: new AbortController().signal },
    async () => {
      nexted = true
      return { isError: false, marker: 'next' }
    },
  )
  assert.equal(nexted, true)
  assert.equal(result.marker, 'next')
  assert.equal(stats.fallbacks, 1)
  assert.equal(stats.rewrites, 0)
})

test('suggest denier denies once per command and respects the cooldown', async () => {
  const config = normalizeConfig({})
  const stats = { denies: 0, lastDeny: null, failures: 0, lastError: null }
  const deniedAt = new Map()
  const deny = createSuggestDenier({
    config,
    engine: { rewrite: async () => 'rtk git status' },
    stats,
    platform: 'win32',
    deniedAt,
    cooldownMs: 60_000,
  })
  const first = await deny({ name: 'pwsh', arguments: { command: 'git status' } })
  assert.equal(first.kind, 'deny')
  assert.match(first.reason, /rtk git status/)
  assert.equal(await deny({ name: 'pwsh', arguments: { command: 'git status' } }), null)
  assert.equal(stats.denies, 1)
})

test('sessionCwd reads the session header', () => {
  assert.equal(sessionCwd({ agent: { session: { header: { cwd: 'C:/repo' } } } }), 'C:/repo')
  assert.equal(sessionCwd({}), undefined)
})

test('package.json version matches lib/version.js', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-rtk-bridge')
  assert.equal(pkg.version, VERSION)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})
