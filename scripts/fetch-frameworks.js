#!/usr/bin/env node
/**
 * Downloads the Switchboard SDK + extension xcframeworks into the local native
 * module, so a clean clone can build the app.
 *
 * No model weights live in git — they arrive here, packaged inside the
 * frameworks, from the public Switchboard bucket. Roughly 2.3 GB in total.
 *
 * The language model's weights are dropped again straight after extraction: the
 * app fetches them on first launch instead, so they must not reach the build. See
 * `src/model` for the other half of that.
 *
 * Environment:
 *   SWITCHBOARD_SDK_CHANNEL   bucket path to pull from (default: develop)
 *   SWITCHBOARD_SDK_VERSION   SDK version in the archive names (default: 3.2.5)
 */

const fs = require('fs')
const path = require('path')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const { execFileSync } = require('child_process')
const { intro, outro, log, tasks } = require('@clack/prompts')

// `develop` carries the LLM context-eviction fix (SWI-6775); pin to
// `release/x.y.z` once that ships, and this becomes release-only.
const SDK_CHANNEL = process.env.SWITCHBOARD_SDK_CHANNEL ?? 'develop'
const SDK_VERSION = process.env.SWITCHBOARD_SDK_VERSION ?? '3.2.5'

const BUCKET_URL = 'https://switchboard-sdk-public.s3.us-east-1.amazonaws.com'

// Archives are <package>-<platform>-<version>.zip; the version is the SDK
// version, so `develop` serves *-ios-3.2.5.zip until it rolls to the next.
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
 * Weights to delete after extracting a package, per package. The LLM extension
 * ships its GGUF inside each slice of its xcframework and CocoaPods embeds the
 * framework whole, so leaving it here is what put a gigabyte in the built app.
 * `src/model` downloads it to the phone on first launch instead.
 */
const STRIPPED_WEIGHTS = { SwitchboardLLM: /\.gguf$/ }

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

async function isUpToDate(packageName) {
  const stamp = readStamp(packageName)
  if (!stamp || stamp.channel !== SDK_CHANNEL || stamp.version !== SDK_VERSION) {
    return false
  }
  const etag = await remoteETag(packageName)
  // Unreachable bucket: trust what's on disk rather than wiping a good install.
  return etag === null || etag === stamp.etag
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

/** Drop the weights the app downloads at runtime. Returns the bytes freed. */
function stripBundledWeights(packageName, packageDir) {
  const pattern = STRIPPED_WEIGHTS[packageName]
  if (!pattern || !fs.existsSync(packageDir)) {
    return 0
  }
  let freed = 0
  for (const file of files(packageDir)) {
    if (!pattern.test(file)) {
      continue
    }
    freed += fs.statSync(file).size
    fs.rmSync(file)
  }
  return freed
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

/** Fetch and extract one package. Resolves to the bytes of weights stripped. */
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

  const freed = stripBundledWeights(packageName, packageDir)

  fs.writeFileSync(
    stampPath(packageName),
    JSON.stringify({ channel: SDK_CHANNEL, version: SDK_VERSION, etag })
  )

  return freed
}

/** Fetch every framework that is missing or out of date. Resolves to an exit code. */
async function fetchFrameworks() {
  intro(`Switchboard SDK ${SDK_VERSION} (${SDK_CHANNEL})`)

  const upToDate = await Promise.all(PACKAGES.map(isUpToDate))
  const stale = PACKAGES.filter((_, index) => !upToDate[index])

  // A framework that landed before the app fetched its own weights still has them
  // sitting inside it, and its stamp is current so nothing would re-download it.
  // Sweep those here; the stale ones are stripped as they extract.
  const swept = PACKAGES.filter((_, index) => upToDate[index]).reduce(
    (total, packageName) =>
      total + stripBundledWeights(packageName, path.join(FRAMEWORKS_DIR, packageName, 'ios')),
    0
  )
  if (swept > 0) {
    log.info(`Dropped ${megabytes(swept)} of weights the app fetches at runtime`)
  }

  if (stale.length === 0) {
    log.warn(`Frameworks already up to date (${SDK_VERSION}, ${SDK_CHANNEL})`)
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
            ? `Downloaded ${packageName} ${progress} — dropped ${megabytes(freed)} of weights the app fetches at runtime`
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
