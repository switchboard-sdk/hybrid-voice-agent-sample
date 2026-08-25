// Jest mock for expo-file-system/legacy, which is where the resumable download
// lives. Installed the same way as its sibling — see `fileSystem.ts` for why it is
// not named after the package.
//
// `createDownloadResumable` returns a task whose `downloadAsync()` calls whatever
// `setDownloadHandler()` last installed. The handler is handed the progress
// reporter and the destination URI, so a test can push progress through and then
// decide what landed on disk — including nothing, or a fragment.

export interface DownloadProgress {
  totalBytesWritten: number
  totalBytesExpectedToWrite: number
}

export interface DownloadResult {
  uri: string
  status: number
  headers: Record<string, string>
  mimeType: string | null
}

export type DownloadHandler = (
  report: (progress: DownloadProgress) => void,
  fileUri: string
) => Promise<DownloadResult | undefined>

const ok = (fileUri: string): DownloadResult => ({
  uri: fileUri,
  status: 200,
  headers: {},
  mimeType: null,
})

let handler: DownloadHandler = async (_report, fileUri) => ok(fileUri)

/** Install what the next `downloadAsync()` does. */
export function setDownloadHandler(next: DownloadHandler): void {
  handler = next
}

/** A result with the status a real download would carry on success. */
export function downloadResult(fileUri: string, status = 200): DownloadResult {
  return { ...ok(fileUri), status }
}

export const createDownloadResumable = jest.fn(
  (
    _url: string,
    fileUri: string,
    _options?: unknown,
    callback?: (progress: DownloadProgress) => void
  ) => ({
    downloadAsync: () => handler((progress) => callback?.(progress), fileUri),
  })
)

export function resetDownloadMock(): void {
  handler = async (_report, fileUri) => ok(fileUri)
  createDownloadResumable.mockClear()
}
