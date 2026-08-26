#!/usr/bin/env node
/**
 * Downloads the Switchboard SDK + extension xcframeworks into the local native
 * module, so a clean clone can build the app.
 *
 * No model weights live in git — they arrive here, packaged inside the
 * frameworks, from the public Switchboard bucket. Roughly 2.3 GB in total.
 *
 * Assets the app never reads are dropped straight after extraction, so they cannot
 * reach the build. See STRIPPED_ASSETS for what goes and why.
 *
 * Environment:
 *   SWITCHBOARD_SDK_CHANNEL   bucket path to pull from (default: develop)
 *   SWITCHBOARD_SDK_VERSION   SDK version in the archive names (default: 3.2.6)
 *   SWITCHBOARD_KEEP_ASSETS   keep everything the packages ship
 *   SWITCHBOARD_UPDATE_LOCK   record what was fetched in frameworks.lock.json
 */

const fs = require('fs')
const path = require('path')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const { execFileSync } = require('child_process')
const { intro, outro, log, tasks } = require('@clack/prompts')

// The app needs the LLM node's cancel action and reply ceiling, which `develop`
// carries and no release does yet. Set this to `release/x.y.z` once one ships:
// `develop` is a moving channel, so it is not what a sample should default to.
const SDK_CHANNEL = process.env.SWITCHBOARD_SDK_CHANNEL ?? 'develop'
const SDK_VERSION = process.env.SWITCHBOARD_SDK_VERSION ?? '3.2.6'

const BUCKET_URL = 'https://switchboard-sdk-public.s3.us-east-1.amazonaws.com'

// Archives are <package>-<platform>-<version>.zip; the version is the SDK
// version, so `develop` serves *-ios-3.2.6.zip until it rolls to the next.
const objectUrl = (packageName) =>
  `${BUCKET_URL}/builds/${SDK_CHANNEL}/ios/${packageName}-ios-${SDK_VERSION}.zip`

const PACKAGES = [
  'SwitchboardSDK',
  'SwitchboardOnnx',
  'SwitchboardSileroVAD',
  'SwitchboardWhisper',
  'SwitchboardSherpa',
  'SwitchboardLLM',
]

/**
 * Assets to delete after extracting a package, per package. CocoaPods embeds a
 * vendored framework whole, so anything left here ends up in the app whether the
 * graph touches it or not.
 *
 * The LLM's GGUF is fetched to the phone on first launch instead — see `src/model`.
 * Sherpa ships a complete ASR stack alongside its TTS voices, and this app
 * transcribes with `Whisper.STT`: `HLG.fst` and the CTC model are read only by
 * `SherpaSTTNode`, and `de_DE` is a voice nothing selects. Between them those are
 * most of the built app.
 *
 * Set SWITCHBOARD_KEEP_ASSETS to keep the lot, which is what switching the graph to
 * `Sherpa.STT` or the German voice needs.
 */
const STRIPPED_ASSETS = {
  SwitchboardLLM: [/\.gguf$/],
  SwitchboardSherpa: [/\/files\/HLG\.fst$/, /\/files\/ctc-epoch-[^/]*\.ort$/, /\/files\/de_DE\//],
}

const KEEP_ASSETS = Boolean(process.env.SWITCHBOARD_KEEP_ASSETS)
const UPDATE_LOCK = Boolean(process.env.SWITCHBOARD_UPDATE_LOCK)

const ATTEMPTS = 3

const PROJECT_ROOT = path.dirname(__dirname)
const FRAMEWORKS_DIR = path.join(PROJECT_ROOT, 'modules', 'edgespeech-native', 'ios', 'Frameworks')

// Per-package stamp, written only after a successful extract, so a dropped
// download costs one package rather than all 2.3 GB. Records the ETag, not just
// the version — `develop` is a moving channel, so contents change under a
// fixed path.
const stampPath = (packageName) => path.join(FRAMEWORKS_DIR, packageName, '.stamp')

function readStamp(packageName) {
  const stamp = stampPath(packageName)
  if (!fs.existsSync(stamp)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(stamp, 'utf8'))
  } catch {
    return null
  }
}

async function remoteETag(packageName) {
  try {
    const response = await fetch(objectUrl(packageName), { method: 'HEAD' })
    return response.ok ? response.headers.get('etag') : null
  } catch {
    return null
  }
}

function isUpToDate(packageName, etag) {
  const stamp = readStamp(packageName)
  if (!stamp || stamp.channel !== SDK_CHANNEL || stamp.version !== SDK_VERSION) {
    return false
  }
  // Unreachable bucket: trust what's on disk rather than wiping a good install.
  return etag === null || etag === stamp.etag
}

/**
 * The ETags this commit was tested against, per package.
 *
 * The stamps live beside the frameworks, which are not in git, so they say nothing
 * to a fresh clone. This does: `develop` can rebuild a version in place, and
 * without a record of which bytes were tested, a clone would quietly get a
 * different SDK than the code was written for.
 */
const LOCK_PATH = path.join(PROJECT_ROOT, 'frameworks.lock.json')

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'))
  } catch {
    return null
  }
}

function writeLock() {
  const packages = Object.fromEntries(PACKAGES.map((name) => [name, readStamp(name)?.etag ?? null]))
  fs.writeFileSync(
    LOCK_PATH,
    `${JSON.stringify({ channel: SDK_CHANNEL, version: SDK_VERSION, packages }, null, 2)}\n`
  )
}

/**
 * Say so when the bucket no longer serves what the lock records. A warning rather
 * than a stop: a sample nobody can install is worse than one carrying an SDK it
 * was not tested against, so long as it says which it is.
 */
function verifyLock(etags) {
  const lock = readLock()
  if (!lock || lock.channel !== SDK_CHANNEL || lock.version !== SDK_VERSION) {
    return
  }

  const moved = PACKAGES.filter(
    (name) => etags[name] && lock.packages?.[name] && etags[name] !== lock.packages[name]
  )
  if (moved.length === 0) {
    return
  }

  log.warn(
    `${SDK_CHANNEL} has rebuilt ${SDK_VERSION} since this commit was pinned: ${moved.join(', ')}.\n` +
      'You are getting a different SDK than this code was tested against. Run\n' +
      '`SWITCHBOARD_UPDATE_LOCK=1 npm run frameworks` to take the new build and refresh\n' +
      'frameworks.lock.json, or set SWITCHBOARD_SDK_CHANNEL to a release.'
  )
}

async function fetchToFile(packageName, zipPath, message) {
  const response = await fetch(objectUrl(packageName))
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => {
    received += chunk.length
    const mb = (received / 1024 / 1024).toFixed(0)
    message(
      total
        ? `Downloading ${packageName} — ${mb} MB (${Math.round((received / total) * 100)}%)`
        : `Downloading ${packageName} — ${mb} MB`
    )
  })

  await pipeline(body, fs.createWriteStream(zipPath))

  if (total && received !== total) {
    throw new Error(`truncated: got ${received} of ${total} bytes`)
  }

  // ETag of the response we consumed — a second HEAD could race a republish.
  return response.headers.get('etag')
}

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      yield path.join(entry.parentPath, entry.name)
    }
  }
}

/** Drop the assets this app never reads. Returns the bytes freed. */
function stripUnusedAssets(packageName, packageDir) {
  const patterns = STRIPPED_ASSETS[packageName]
  if (KEEP_ASSETS || !patterns || !fs.existsSync(packageDir)) {
    return 0
  }
  let freed = 0
  for (const file of files(packageDir)) {
    if (!patterns.some((pattern) => pattern.test(file))) {
      continue
    }
    freed += fs.statSync(file).size
    fs.rmSync(file)
  }
  return freed
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

/** Fetch and extract one package. Resolves to the bytes of assets stripped. */
async function downloadPackage(packageName, message) {
  const packageRoot = path.join(FRAMEWORKS_DIR, packageName)
  const packageDir = path.join(packageRoot, 'ios')
  const zipPath = path.join(packageDir, `${packageName}.zip`)

  fs.rmSync(packageRoot, { recursive: true, force: true })
  fs.mkdirSync(packageDir, { recursive: true })

  let etag = null

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      etag = await fetchToFile(packageName, zipPath, message)
      break
    } catch (err) {
      fs.rmSync(zipPath, { force: true })
      const cause = err.cause?.message ?? err.message
      if (attempt === ATTEMPTS) {
        throw new Error(cause)
      }
      message(`Retrying ${packageName} after ${cause} (${attempt}/${ATTEMPTS})`)
    }
  }

  message(`Extracting ${packageName}`)
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', packageDir], { stdio: 'pipe' })
  fs.unlinkSync(zipPath)

  const freed = stripUnusedAssets(packageName, packageDir)

  fs.writeFileSync(
    stampPath(packageName),
    JSON.stringify({ channel: SDK_CHANNEL, version: SDK_VERSION, etag })
  )

  return freed
}

/** Fetch every framework that is missing or out of date. Resolves to an exit code. */
async function fetchFrameworks() {
  intro(`Switchboard SDK ${SDK_VERSION} (${SDK_CHANNEL})`)

  // One HEAD per package, serving both the up-to-date check and the lock check.
  const etagList = await Promise.all(PACKAGES.map(remoteETag))
  const etags = Object.fromEntries(PACKAGES.map((name, index) => [name, etagList[index]]))

  verifyLock(etags)

  const upToDate = PACKAGES.map((name) => isUpToDate(name, etags[name]))
  const stale = PACKAGES.filter((_, index) => !upToDate[index])

  // A framework whose stamp is current is never re-downloaded, so anything this list
  // has grown to cover since it landed is still sitting inside it. Sweep those here;
  // the stale ones are stripped as they extract.
  const swept = PACKAGES.filter((_, index) => upToDate[index]).reduce(
    (total, packageName) =>
      total + stripUnusedAssets(packageName, path.join(FRAMEWORKS_DIR, packageName, 'ios')),
    0
  )
  if (swept > 0) {
    log.info(`Dropped ${megabytes(swept)} the app does not use`)
  }

  if (stale.length === 0) {
    log.warn(`Frameworks already up to date (${SDK_VERSION}, ${SDK_CHANNEL})`)
    if (UPDATE_LOCK) {
      writeLock()
      log.info('Refreshed frameworks.lock.json')
    }
    outro('Frameworks ready')
    return 0
  }

  fs.mkdirSync(FRAMEWORKS_DIR, { recursive: true })
  log.info(
    stale.length === PACKAGES.length
      ? 'Downloading frameworks — around 2.3 GB, this takes a while'
      : `Downloading ${stale.length} of ${PACKAGES.length} frameworks: ${stale.join(', ')}`
  )

  const failures = []

  await tasks(
    stale.map((packageName, index) => {
      const progress = `(${index + 1}/${stale.length})`
      return {
        title: `${packageName} ${progress}`,
        task: async (message) => {
          let freed = 0
          try {
            freed = await downloadPackage(packageName, (msg) => message(`${msg} ${progress}`))
          } catch (err) {
            failures.push(packageName)
            return `Failed to download ${packageName}: ${err.message}`
          }
          return freed
            ? `Downloaded ${packageName} ${progress} — dropped ${megabytes(freed)} the app does not use`
            : `Downloaded ${packageName} ${progress}`
        },
      }
    })
  )

  if (failures.length > 0) {
    log.error(
      `Incomplete — ${failures.join(', ')} failed. Re-run \`npm run frameworks\` to fetch just those.`
    )
    return 1
  }

  if (UPDATE_LOCK) {
    writeLock()
    log.info('Refreshed frameworks.lock.json')
  }

  outro('Frameworks ready')
  return 0
}

module.exports = { fetchFrameworks }

if (require.main === module) {
  fetchFrameworks()
    .then(process.exit)
    .catch((err) => {
      log.error(err.message)
      process.exit(1)
    })
}
