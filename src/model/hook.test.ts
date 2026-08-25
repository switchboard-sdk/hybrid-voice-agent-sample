import { renderHook, act, waitFor } from '@testing-library/react-native'
import { useModel } from './hook'
import { downloadModel, findModel } from './download'

// The mechanics are covered in download.test.ts; what matters here is which state
// the screen is shown, and that nothing starts a 773 MB fetch on its own.
jest.mock('./download', () => ({
  findModel: jest.fn(() => null),
  downloadModel: jest.fn(() => Promise.resolve('/documents/model.gguf')),
  EXPECTED_BYTES: 773_025_920,
}))

const foundModel = jest.mocked(findModel)
const fetchModel = jest.mocked(downloadModel)

/** An error tagged the way every layer tags its own. */
const codedError = (code: string, message: string): Error => {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

beforeEach(() => {
  jest.clearAllMocks()
  foundModel.mockReturnValue(null)
  fetchModel.mockResolvedValue('/documents/model.gguf')
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('useModel', () => {
  it('is ready straight away when the model is already on the phone', async () => {
    foundModel.mockReturnValue('/documents/model.gguf')

    const { result } = renderHook(() => useModel())

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.path).toBe('/documents/model.gguf')
    expect(fetchModel).not.toHaveBeenCalled()
  })

  it('waits to be asked on a fresh install', async () => {
    const { result } = renderHook(() => useModel())

    await waitFor(() => expect(result.current.status).toBe('missing'))
    // Someone's data plan, not ours to spend.
    expect(fetchModel).not.toHaveBeenCalled()
  })

  it('reports what the download has and what it is counting against', async () => {
    let report: ((received: number, total: number | null) => void) | undefined
    fetchModel.mockImplementation((onProgress) => {
      report = onProgress
      return new Promise(() => {})
    })

    const { result } = renderHook(() => useModel())
    await waitFor(() => expect(result.current.status).toBe('missing'))

    act(() => result.current.start())
    expect(result.current.status).toBe('downloading')

    act(() => report!(1024, 773_025_920))
    expect(result.current.received).toBe(1024)
    expect(result.current.total).toBe(773_025_920)
  })

  it('lands on ready once the download resolves', async () => {
    const { result } = renderHook(() => useModel())
    await waitFor(() => expect(result.current.status).toBe('missing'))

    await act(async () => result.current.start())

    expect(result.current.status).toBe('ready')
    expect(result.current.path).toBe('/documents/model.gguf')
  })

  it('turns a failure into a sentence and can be asked again', async () => {
    fetchModel.mockRejectedValueOnce(codedError('MODEL_DOWNLOAD_FAILED', 'offline'))

    const { result } = renderHook(() => useModel())
    await waitFor(() => expect(result.current.status).toBe('missing'))

    await act(async () => result.current.start())

    expect(result.current.status).toBe('failed')
    expect(result.current.failure?.message).toMatch(/could not be downloaded/i)

    await act(async () => result.current.start())

    expect(result.current.status).toBe('ready')
    expect(result.current.failure).toBeNull()
  })

  it('ignores a second start while one is already running', async () => {
    fetchModel.mockImplementation(() => new Promise(() => {}))

    const { result } = renderHook(() => useModel())
    await waitFor(() => expect(result.current.status).toBe('missing'))

    act(() => result.current.start())
    act(() => result.current.start())

    expect(fetchModel).toHaveBeenCalledTimes(1)
  })
})
