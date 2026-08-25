/**
 * The on-device model, and how it gets onto the phone.
 *
 * The GGUF weighs 773 MB. Shipping it inside the app would put a gigabyte
 * download in front of anyone cloning this repo, so it arrives on first launch
 * and stays in Documents from then on — every launch after that needs no
 * connection, which is the whole point of the on-device path.
 *
 * The fetch runs on a background `URLSession`, which is what makes it survive the
 * app being backgrounded and keeps it retrying through a connection that comes and
 * goes. What it does not survive is the app being killed: the partial file is not
 * reachable from here afterwards, so the next launch starts again.
 */

import { File, Paths } from 'expo-file-system'
import { createDownloadResumable } from 'expo-file-system/legacy'

/** The file name the model is stored under, and the one the node is pointed at. */
const MODEL_FILE = 'Llama-3.2-1B-Instruct-Q4_0.gguf'

/**
 * Where the model comes from. The default is a public mirror of the build the SDK's
 * LLM extension carries, byte for byte.
 */
const DEFAULT_MODEL_URL =
  'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'

/** The default model's size, to the byte, so a file that arrived short is caught. */
const DEFAULT_MODEL_BYTES = 773_025_920

/** Free space wanted on top of the model itself before starting. */
const DISK_SLACK_BYTES = 200 * 1024 * 1024

export const MODEL_URL = process.env.EXPO_PUBLIC_LLM_MODEL_URL || DEFAULT_MODEL_URL

/**
 * What the model should weigh, or `null` when the URL was overridden and only the
 * server can say. Used both to tell the user what they are about to download and
 * to check that all of it arrived.
 */
export const EXPECTED_BYTES: number | null =
  MODEL_URL === DEFAULT_MODEL_URL ? DEFAULT_MODEL_BYTES : null

/** Build an Error carrying a machine `code`, matching the other layers' convention. */
function modelError(code: string, message: string): Error {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

function modelFile(): File {
  return new File(Paths.document, MODEL_FILE)
}

/** The absolute path behind a `file://` URI — what the language-model node takes. */
function pathOf(file: File): string {
  return decodeURIComponent(file.uri.replace(/^file:\/\//, ''))
}

/** True when the file on disk is the whole model rather than a fragment of one. */
function isComplete(file: File): boolean {
  if (!file.exists || file.size <= 0) {
    return false
  }
  return EXPECTED_BYTES === null || file.size === EXPECTED_BYTES
}

/**
 * The model's path if it is already on the phone, `null` if it is not.
 *
 * A file that is present but the wrong size is deleted rather than reported: it
 * would fail to load, and the node says nothing when it does.
 */
export function findModel(): string | null {
  const file = modelFile()
  if (isComplete(file)) {
    return pathOf(file)
  }
  if (file.exists) {
    console.log(`[model] discarding a ${file.size}-byte model file`)
    file.delete()
  }
  return null
}

export type ProgressCallback = (received: number, total: number | null) => void

/**
 * Fetch the model and resolve with its path.
 *
 * `onProgress` reports the total the server declared, which is what the screen
 * counts against — `EXPECTED_BYTES` only says what it should be.
 */
export async function downloadModel(onProgress: ProgressCallback): Promise<string> {
  if (EXPECTED_BYTES !== null && Paths.availableDiskSpace < EXPECTED_BYTES + DISK_SLACK_BYTES) {
    throw modelError(
      'MODEL_NO_SPACE',
      `The model needs ${Math.round(EXPECTED_BYTES / 1e6)} MB and there is not that much free.`
    )
  }

  const file = modelFile()
  let declared: number | null = null

  const task = createDownloadResumable(
    MODEL_URL,
    file.uri,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      // -1 means the server sent no Content-Length, so there is no total to show.
      if (totalBytesExpectedToWrite > 0) {
        declared = totalBytesExpectedToWrite
      }
      onProgress(totalBytesWritten, declared)
    }
  )

  console.log(`[model] downloading from ${MODEL_URL}`)
  const result = await task.downloadAsync().catch((error: unknown) => {
    throw modelError('MODEL_DOWNLOAD_FAILED', (error as Error)?.message ?? String(error))
  })

  if (!result) {
    throw modelError('MODEL_DOWNLOAD_FAILED', 'The download ended without producing a file.')
  }
  if (result.status >= 400) {
    throw modelError('MODEL_DOWNLOAD_FAILED', `The model host answered HTTP ${result.status}.`)
  }

  const downloaded = modelFile()
  if (!isComplete(downloaded)) {
    // Only ever a fragment: nothing loads it, and leaving it would make the next
    // launch look like it already has a model.
    if (downloaded.exists) {
      downloaded.delete()
    }
    throw modelError(
      'MODEL_INCOMPLETE',
      'The model arrived incomplete. Check the connection and try again.'
    )
  }

  console.log(`[model] ready at ${pathOf(downloaded)} (${downloaded.size} bytes)`)
  return pathOf(downloaded)
}
