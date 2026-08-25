import { EXPECTED_BYTES, MODEL_URL, downloadModel, findModel } from './download'
import * as fs from '../../__mocks__/fileSystem'
import * as legacy from '../../__mocks__/fileSystemDownload'

// jest-expo registers its own expo-file-system mock in its setup file, so these
// have to be installed over the top of it rather than picked up from __mocks__.
jest.mock('expo-file-system', () => require('../../__mocks__/fileSystem'))
jest.mock('expo-file-system/legacy', () => require('../../__mocks__/fileSystemDownload'))

const MODEL_FILE = 'Llama-3.2-1B-Instruct-Q4_0.gguf'
/** The size the default URL serves, which `download.ts` checks against. */
const FULL_SIZE = EXPECTED_BYTES as number

beforeEach(() => {
  fs.resetFileSystemMock()
  legacy.resetDownloadMock()
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('MODEL_URL', () => {
  it('knows what the default model weighs', () => {
    // The byte count is the only check on a file that arrived short, so it has to
    // belong to the URL it is checking.
    expect(MODEL_URL).toContain('Llama-3.2-1B-Instruct-Q4_0.gguf')
    expect(EXPECTED_BYTES).toBe(773_025_920)
  })
})

describe('findModel', () => {
  it('reports nothing on a fresh install', () => {
    expect(findModel()).toBeNull()
  })

  it('returns the path once the whole model is there', () => {
    fs.writeFakeFile(MODEL_FILE, FULL_SIZE)

    expect(findModel()).toContain(MODEL_FILE)
  })

  it('returns a plain path, not a file:// URI', () => {
    // What the LlamaCpp node takes. A URI resolves to nothing and the node says
    // nothing about it.
    fs.writeFakeFile(MODEL_FILE, FULL_SIZE)

    expect(findModel()).toBe(`/var/mobile/Containers/Data/Application/app/Documents/${MODEL_FILE}`)
  })

  it('unescapes a path that arrives percent-encoded', () => {
    fs.setDocumentUri('file:///var/mobile/My%20Phone/Documents')
    fs.writeFakeFile(MODEL_FILE, FULL_SIZE)

    expect(findModel()).toBe(`/var/mobile/My Phone/Documents/${MODEL_FILE}`)
  })

  it('discards a file that is the wrong size rather than loading it', () => {
    // A fragment left by a download that never finished. It would fail to load and
    // the node would abandon every turn in silence, so it goes.
    fs.writeFakeFile(MODEL_FILE, FULL_SIZE - 1024)

    expect(findModel()).toBeNull()
    expect(fs.fakeFileExists(MODEL_FILE)).toBe(false)
  })

  it('discards an empty file', () => {
    fs.writeFakeFile(MODEL_FILE, 0)

    expect(findModel()).toBeNull()
    expect(fs.fakeFileExists(MODEL_FILE)).toBe(false)
  })
})

describe('downloadModel', () => {
  it('resolves with the path and reports progress on the way', async () => {
    const progress: Array<[number, number | null]> = []
    legacy.setDownloadHandler(async (report, fileUri) => {
      report({ totalBytesWritten: 100, totalBytesExpectedToWrite: FULL_SIZE })
      report({ totalBytesWritten: FULL_SIZE, totalBytesExpectedToWrite: FULL_SIZE })
      fs.writeFakeFile(MODEL_FILE, FULL_SIZE)
      return legacy.downloadResult(fileUri)
    })

    await expect(
      downloadModel((received, total) => progress.push([received, total]))
    ).resolves.toContain(MODEL_FILE)
    expect(progress).toEqual([
      [100, FULL_SIZE],
      [FULL_SIZE, FULL_SIZE],
    ])
  })

  it('reports no total while the server has not declared one', async () => {
    const progress: Array<[number, number | null]> = []
    legacy.setDownloadHandler(async (report, fileUri) => {
      // -1 is what the module passes on when there is no Content-Length.
      report({ totalBytesWritten: 512, totalBytesExpectedToWrite: -1 })
      fs.writeFakeFile(MODEL_FILE, FULL_SIZE)
      return legacy.downloadResult(fileUri)
    })

    await downloadModel((received, total) => progress.push([received, total]))

    expect(progress).toEqual([[512, null]])
  })

  it('refuses to start when there is not enough free space', async () => {
    fs.setDiskSpace(FULL_SIZE)

    await expect(downloadModel(() => {})).rejects.toMatchObject({ code: 'MODEL_NO_SPACE' })
    expect(legacy.createDownloadResumable).not.toHaveBeenCalled()
  })

  it('discards a model that arrived short, and says so', async () => {
    legacy.setDownloadHandler(async (_report, fileUri) => {
      fs.writeFakeFile(MODEL_FILE, FULL_SIZE - 1)
      return legacy.downloadResult(fileUri)
    })

    await expect(downloadModel(() => {})).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE' })
    // Left in place, the next launch would take it for a model it already has.
    expect(fs.fakeFileExists(MODEL_FILE)).toBe(false)
  })

  it('reports a model that never landed as incomplete', async () => {
    legacy.setDownloadHandler(async (_report, fileUri) => legacy.downloadResult(fileUri))

    await expect(downloadModel(() => {})).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE' })
  })

  it('reports a refusal from the host', async () => {
    legacy.setDownloadHandler(async (_report, fileUri) => legacy.downloadResult(fileUri, 404))

    await expect(downloadModel(() => {})).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: expect.stringContaining('404'),
    })
  })

  it('reports a download that threw', async () => {
    legacy.setDownloadHandler(async () => {
      throw new Error('The Internet connection appears to be offline.')
    })

    await expect(downloadModel(() => {})).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
    })
  })

  it('reports a download that ended without a result', async () => {
    legacy.setDownloadHandler(async () => undefined)

    await expect(downloadModel(() => {})).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
    })
  })
})

describe('an overridden model URL', () => {
  /**
   * Load `download.ts` afresh with the URL overridden, so the constants it derives
   * at import time are derived again. The mocks are registered outside this and
   * survive it, so the copy above is still the filesystem it reads.
   */
  function withUrl(url: string, body: (model: typeof import('./download')) => void): void {
    const previous = process.env.EXPO_PUBLIC_LLM_MODEL_URL
    process.env.EXPO_PUBLIC_LLM_MODEL_URL = url
    try {
      jest.isolateModules(() => {
        body(require('./download'))
      })
    } finally {
      process.env.EXPO_PUBLIC_LLM_MODEL_URL = previous
    }
  }

  it('is used instead of the default, with no size to check against', () => {
    // Someone else's GGUF will not weigh what ours does, so the byte check has to
    // stand down rather than reject every file it is given.
    withUrl('https://example.test/tiny.gguf', (model) => {
      expect(model.MODEL_URL).toBe('https://example.test/tiny.gguf')
      expect(model.EXPECTED_BYTES).toBeNull()
    })
  })

  it('accepts whatever size arrives', () => {
    fs.writeFakeFile(MODEL_FILE, 42)

    withUrl('https://example.test/tiny.gguf', (model) => {
      expect(model.findModel()).toContain(MODEL_FILE)
    })
  })
})
