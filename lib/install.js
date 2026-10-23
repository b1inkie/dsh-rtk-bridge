/**
 * Download the official rtk release and install it under the DSH home.
 *
 * Only invoked explicitly through `/rtk install`; nothing is downloaded at
 * plugin load. The archive is verified against the release's `checksums.txt`
 * before it is extracted.
 */

import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { compareVersions, managedRtkPath, parseVersion } from './core.js'

const DEFAULT_DOWNLOAD_BASE = 'https://github.com/rtk-ai/rtk/releases'
const MAX_BYTES = 100 * 1024 * 1024

/** Release asset per platform/arch. Windows arm64 is not published. */
const RELEASE_ASSETS = {
  'win32-x64': { asset: 'rtk-x86_64-pc-windows-msvc.zip', kind: 'zip' },
  'linux-x64': { asset: 'rtk-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz' },
  'linux-arm64': { asset: 'rtk-aarch64-unknown-linux-gnu.tar.gz', kind: 'tar.gz' },
  'darwin-x64': { asset: 'rtk-x86_64-apple-darwin.tar.gz', kind: 'tar.gz' },
  'darwin-arm64': { asset: 'rtk-aarch64-apple-darwin.tar.gz', kind: 'tar.gz' },
}

/**
 * Pick the release archive for one platform.
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {{ asset: string, kind: 'zip' | 'tar.gz' }}
 */
export function releaseAsset(platform = process.platform, arch = process.arch) {
  const entry = RELEASE_ASSETS[`${platform}-${arch}`]
  if (entry === undefined) {
    throw new Error(`rtk does not publish a prebuilt binary for ${platform}/${arch}; install rtk manually`)
  }
  return { ...entry }
}

/**
 * Parse `sha256  filename` lines from the release checksums file.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseChecksums(text) {
  const checksums = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (match) checksums.set(match[2], match[1].toLowerCase())
  }
  return checksums
}

/**
 * Run a child process without rejecting.
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} [options]
 */
function run(file, args, options = {}) {
  return new Promise((resolve) => {
    nodeExecFile(
      file,
      args,
      { windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024, ...options },
      (error, stdout, stderr) => {
        let code = 0
        if (error) code = typeof error.code === 'number' ? error.code : typeof error.exitCode === 'number' ? error.exitCode : null
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error ? { error } : {}),
        })
      },
    )
  })
}

async function downloadWithCurl(url, destination) {
  return run('curl', ['-L', '--fail', '--silent', '--show-error', '--max-time', '180', '-o', destination, url], {
    timeout: 200_000,
  })
}

async function downloadWithFetch(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) throw new Error(`download is too large (${declared} bytes)`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > MAX_BYTES) throw new Error(`download is too large (${body.length} bytes)`)
  await writeFile(destination, body)
}

/**
 * Download one HTTPS URL to a file. Prefers curl (system proxy and redirect
 * handling), then falls back to fetch.
 * @param {string} url
 * @param {string} destination
 */
async function download(url, destination) {
  const curl = await downloadWithCurl(url, destination)
  if (curl.code === 0) {
    const size = (await stat(destination)).size
    if (size > MAX_BYTES) throw new Error(`download is too large (${size} bytes)`)
    return
  }
  await rm(destination, { force: true }).catch(() => {})
  try {
    await downloadWithFetch(url, destination)
  } catch (fetchError) {
    const curlDetail = curl.error?.code === 'ENOENT' ? 'curl not found' : curl.stderr.trim() || `curl exit ${curl.code}`
    throw new Error(`download failed: ${curlDetail}; fetch: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`)
  }
}

async function downloadText(url) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-rtk-text-'))
  try {
    const file = join(directory, 'content')
    await download(url, file)
    return await readFile(file, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function extract(archive, destination, kind) {
  const args = kind === 'zip' ? ['-xf', archive, '-C', destination] : ['-xzf', archive, '-C', destination]
  const result = await run('tar', args, { timeout: 60_000 })
  if (result.code !== 0) {
    throw new Error(`could not extract ${archive}: ${result.stderr.trim() || result.error?.message || `tar exit ${result.code}`}`)
  }
}

async function findBinary(root, platform) {
  const target = platform === 'win32' ? 'rtk.exe' : 'rtk'
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.shift()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile() && entry.name.toLowerCase() === target) return full
    }
  }
  return undefined
}

/**
 * Download, verify, extract, and install rtk.
 *
 * @param {{
 *   version?: string,
 *   platform?: string,
 *   arch?: string,
 *   dshHome?: string,
 *   downloadBase?: string,
 *   minVersion?: string,
 *   log?: (message: string) => void,
 * }} [options]
 * @returns {Promise<{ path: string, version: string, asset: string, source: string }>}
 */
export async function installRtk(options = {}) {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const minVersion = options.minVersion ?? '0.23.0'
  const log = options.log ?? (() => {})
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const downloadBase = (options.downloadBase ?? process.env.RTK_BRIDGE_DOWNLOAD_BASE ?? DEFAULT_DOWNLOAD_BASE).replace(/\/+$/, '')

  let version = options.version ?? 'latest'
  if (version !== 'latest') {
    version = version.replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid rtk version: ${options.version}`)
  }

  const { asset, kind } = releaseAsset(platform, arch)
  const base = version === 'latest' ? `${downloadBase}/latest/download` : `${downloadBase}/download/v${version}`
  const assetUrl = `${base}/${asset}`
  const checksumsUrl = `${base}/checksums.txt`
  const target = managedRtkPath({ platform, dshHome })
  const work = await mkdtemp(join(tmpdir(), 'dsh-rtk-install-'))

  try {
    log(`downloading ${assetUrl}`)
    const archive = join(work, asset)
    await download(assetUrl, archive)

    log('verifying checksum')
    const checksums = parseChecksums(await downloadText(checksumsUrl))
    const expected = checksums.get(asset)
    if (expected === undefined) throw new Error(`checksums.txt has no entry for ${asset}`)
    const actual = await sha256(archive)
    if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`)

    log('extracting')
    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked, { recursive: true })
    await extract(archive, unpacked, kind)
    const binary = await findBinary(unpacked, platform)
    if (binary === undefined) throw new Error(`archive ${asset} does not contain ${platform === 'win32' ? 'rtk.exe' : 'rtk'}`)

    await mkdir(dirname(target), { recursive: true })
    const staged = `${target}.${process.pid}.tmp`
    await copyFile(binary, staged)
    await chmod(staged, 0o755).catch(() => {})
    await rm(target, { force: true }).catch(() => {})
    await rename(staged, target)

    const probe = await run(target, ['--version'], { timeout: 10_000 })
    if (probe.code !== 0) throw new Error(`installed rtk cannot run: ${probe.stderr.trim() || probe.error?.message}`)
    const parsed = parseVersion(probe.stdout)
    if (parsed === null) throw new Error(`cannot parse installed rtk version: ${probe.stdout.trim()}`)
    const minimum = parseVersion(minVersion)
    if (minimum !== null && compareVersions(parsed, minimum) < 0) {
      throw new Error(`rtk ${parsed.raw} is older than the required ${minVersion}`)
    }

    log(`installed rtk ${parsed.raw} at ${target}`)
    return { path: target, version: parsed.raw, asset, source: assetUrl }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
