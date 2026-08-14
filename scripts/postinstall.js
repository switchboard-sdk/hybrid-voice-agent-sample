#!/usr/bin/env node
/**
 * Runs on `npm install`: sets up .env, then fetches the Switchboard frameworks.
 *
 * Environment:
 *   SKIP_FRAMEWORK_DOWNLOAD   skip the framework fetch (CI lint/test jobs)
 */

const fs = require('fs')
const path = require('path')
const { log, note } = require('@clack/prompts')
const { fetchFrameworks } = require('./fetch-frameworks')

const PROJECT_ROOT = path.dirname(__dirname)

function setupEnv() {
  const envExample = path.join(PROJECT_ROOT, '.env.example')
  const envFile = path.join(PROJECT_ROOT, '.env')

  if (!fs.existsSync(envExample) || fs.existsSync(envFile)) {
    return
  }

  fs.copyFileSync(envExample, envFile)
  note(
    'Update .env with your credentials\nGet credentials at https://console.switchboard.audio/register',
    'Action Required'
  )
}

async function main() {
  setupEnv()

  if (process.env.SKIP_FRAMEWORK_DOWNLOAD) {
    log.info('SKIP_FRAMEWORK_DOWNLOAD set — skipping framework download')
    return 0
  }

  return fetchFrameworks()
}

main()
  .then(process.exit)
  .catch((err) => {
    log.error(err.message)
    process.exit(1)
  })
