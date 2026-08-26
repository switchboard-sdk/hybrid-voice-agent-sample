#!/usr/bin/env node
/**
 * Builds a Release archive and uploads it to TestFlight.
 *
 * Signing is automatic: Xcode creates the distribution certificate and the App
 * Store provisioning profile on first run, and registers the bundle ID, all
 * authenticated by the App Store Connect API key rather than a signed-in Xcode.
 *
 * The build number in app.json bumps at the start of every run, since prebuild
 * bakes it in before anything can fail — App Store Connect rejects a number it has
 * already seen for a version, and only cares that they increase, not that none are
 * skipped. Commit the bump once a build lands.
 *
 * Configuration comes from the environment, or from .env and .env.appstore:
 *
 *   APPLE_TEAM_ID    Apple Developer team, in .env, where prebuild also reads it
 *   ASC_KEY_ID       App Store Connect API key ID, in .env.appstore
 *   ASC_ISSUER_ID    the key's issuer ID, in .env.appstore
 *
 * None of the three is EXPO_PUBLIC_, so none is compiled into the JS bundle.
 *
 * The key itself is read from ~/.appstoreconnect/private_keys/AuthKey_<ID>.p8,
 * which is where altool looks and the only place both tools agree on.
 *
 * Flags:
 *   --skip-prebuild  archive what is already in ios/, without regenerating it
 *   --skip-upload    build and validate, then stop, leaving the .ipa in place
 *   --no-bump        upload under the build number app.json already carries
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { intro, outro, log, note } = require('@clack/prompts')

const PROJECT_ROOT = path.dirname(__dirname)
const IOS_DIR = path.join(PROJECT_ROOT, 'ios')
const BUILD_DIR = path.join(IOS_DIR, 'build', 'testflight')

const FLAGS = new Set(process.argv.slice(2))
const SKIP_PREBUILD = FLAGS.has('--skip-prebuild')
const SKIP_UPLOAD = FLAGS.has('--skip-upload')
const BUMP = !FLAGS.has('--no-bump')

const appJsonPath = path.join(PROJECT_ROOT, 'app.json')
const readAppJson = () => JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))

/**
 * Credentials, from .env and .env.appstore if either exists. Anything already in
 * the environment wins, so a one-off export overrides the files.
 *
 * .env is read the same way Expo reads it, so the team here is the team prebuild
 * will bake into the project.
 */
function loadCredentials() {
  const before = { ...process.env }
  for (const name of ['.env', '.env.appstore']) {
    const envFile = path.join(PROJECT_ROOT, name)
    if (fs.existsSync(envFile)) {
      process.loadEnvFile(envFile)
    }
  }
  Object.assign(process.env, before)

  const keyId = process.env.ASC_KEY_ID
  const issuerId = process.env.ASC_ISSUER_ID
  if (!keyId || !issuerId) {
    throw new Error(
      'Missing ASC_KEY_ID or ASC_ISSUER_ID. Create an App Store Connect API key ' +
        'under Users and Access > Integrations, then put both in .env.appstore.'
    )
  }

  const teamId = process.env.APPLE_TEAM_ID
  if (!teamId) {
    throw new Error('Missing APPLE_TEAM_ID. Put your Apple Developer team ID in .env.')
  }

  // altool takes no path flag — it searches a fixed set of directories, of which
  // this is the canonical one. xcodebuild wants the path, so derive it.
  const keyPath = path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`)
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `No API key at ${keyPath}. Apple lets you download the .p8 once — move it there.`
    )
  }

  return { keyId, issuerId, keyPath, teamId }
}

/** The app target Expo generated, which is also the scheme to archive. */
function resolveScheme() {
  const project = fs.readdirSync(IOS_DIR).find((entry) => entry.endsWith('.xcodeproj'))
  if (!project) {
    throw new Error('No .xcodeproj in ios/. Run without --skip-prebuild.')
  }
  return path.basename(project, '.xcodeproj')
}

/**
 * Run a command, streaming its output to the terminal and to a log file. A
 * failing xcodebuild says why in a line somewhere far above where it stops, so
 * both matter.
 */
function run(command, args, logName) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(BUILD_DIR, { recursive: true })
    const logPath = path.join(BUILD_DIR, `${logName}.log`)
    const logFile = fs.createWriteStream(logPath)

    const child = spawn(command, args, { cwd: PROJECT_ROOT, stdio: ['inherit', 'pipe', 'pipe'] })
    child.stdout.pipe(process.stdout)
    child.stderr.pipe(process.stderr)
    child.stdout.pipe(logFile)
    child.stderr.pipe(logFile)

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited ${code} — full output in ${logPath}`))
    })
  })
}

/** Bump ios.buildNumber in app.json and return the value to build with. */
function nextBuildNumber() {
  const appJson = readAppJson()
  const current = Number(appJson.expo.ios.buildNumber ?? '1')

  if (!BUMP) {
    return String(current)
  }

  const next = String(current + 1)
  appJson.expo.ios.buildNumber = next
  fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`)
  return next
}

/**
 * Written per run rather than committed, since the team it names comes from the
 * environment and a committed copy would drift from it.
 * manageAppVersionAndBuildNumber stays off so Xcode uploads the build number
 * app.json set rather than one of its own.
 */
function writeExportOptions(teamId) {
  const plistPath = path.join(BUILD_DIR, 'ExportOptions.plist')
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>${teamId}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>
  <key>uploadSymbols</key><true/>
  <key>stripSwiftSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`
  )
  return plistPath
}

async function main() {
  const { expo } = readAppJson()
  const { keyId, issuerId, keyPath, teamId } = loadCredentials()

  intro(`TestFlight — ${expo.name} ${expo.version}`)

  if (!fs.existsSync(path.join(PROJECT_ROOT, '.env'))) {
    throw new Error(
      'No .env. Expo inlines EXPO_PUBLIC_* at bundle time, so a build without it ships unconfigured.'
    )
  }

  const buildNumber = nextBuildNumber()
  log.info(`Building ${expo.version} (${buildNumber}) for ${expo.ios.bundleIdentifier}`)

  if (!SKIP_PREBUILD) {
    log.step('Prebuilding the iOS project')
    await run('npx', ['expo', 'prebuild', '--platform', 'ios', '--clean'], 'prebuild')
  }

  const scheme = resolveScheme()
  const archivePath = path.join(BUILD_DIR, `${scheme}.xcarchive`)
  const exportPath = path.join(BUILD_DIR, 'export')
  const auth = [
    '-authenticationKeyPath',
    keyPath,
    '-authenticationKeyID',
    keyId,
    '-authenticationKeyIssuerID',
    issuerId,
    '-allowProvisioningUpdates',
  ]

  log.step('Archiving — the vendored frameworks make this slow')
  fs.rmSync(archivePath, { recursive: true, force: true })
  await run(
    'xcodebuild',
    [
      'archive',
      '-workspace',
      path.join(IOS_DIR, `${scheme}.xcworkspace`),
      '-scheme',
      scheme,
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      archivePath,
      ...auth,
    ],
    'archive'
  )

  log.step('Exporting the .ipa')
  fs.rmSync(exportPath, { recursive: true, force: true })
  await run(
    'xcodebuild',
    [
      '-exportArchive',
      '-archivePath',
      archivePath,
      '-exportPath',
      exportPath,
      '-exportOptionsPlist',
      writeExportOptions(teamId),
      ...auth,
    ],
    'export'
  )

  const ipa = fs.readdirSync(exportPath).find((entry) => entry.endsWith('.ipa'))
  if (!ipa) {
    throw new Error(`Export produced no .ipa in ${exportPath}`)
  }
  const ipaPath = path.join(exportPath, ipa)
  const megabytes = (fs.statSync(ipaPath).size / 1024 / 1024).toFixed(0)
  log.info(`${ipa} — ${megabytes} MB`)

  const ascKey = ['--apiKey', keyId, '--apiIssuer', issuerId]

  // Validation catches the rejections that would otherwise consume this build
  // number and force another archive.
  log.step('Validating against App Store Connect')
  await run(
    'xcrun',
    ['altool', '--validate-app', '-f', ipaPath, '-t', 'ios', ...ascKey],
    'validate'
  )

  if (SKIP_UPLOAD) {
    outro(`Validated, not uploaded — ${ipaPath}`)
    return 0
  }

  log.step('Uploading')
  await run('xcrun', ['altool', '--upload-app', '-f', ipaPath, '-t', 'ios', ...ascKey], 'upload')

  note(
    `Build ${expo.version} (${buildNumber}) is processing — App Store Connect emails when it is ready.\n` +
      'Internal testers get it with no beta review. Commit the app.json bump.',
    'Uploaded'
  )
  outro('Done')
  return 0
}

main()
  .then(process.exit)
  .catch((err) => {
    log.error(err.message)
    process.exit(1)
  })
