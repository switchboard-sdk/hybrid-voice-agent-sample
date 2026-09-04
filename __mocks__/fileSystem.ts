// Jest mock for expo-file-system, standing in for the document directory.
//
// Not named after the package: jest-expo already registers a mock for it in its
// setup file, so a suite has to install this one explicitly with
// `jest.mock('expo-file-system', () => require('../../__mocks__/fileSystem'))`.
//
// Backed by two maps of URI → size and URI → text. `src/model/download.ts` only
// ever asks whether the model is there and how big it is, so a size is enough for
// it; `src/profiles.ts` reads and writes a small text file, so that gets real
// contents. Use `writeFakeFile()` for a sized file, `writeFakeText()` for one with
// contents, and `setDiskSpace()` to make the space check fail.

/** Join URI segments with single slashes, keeping the `file://` scheme intact. */
function joinUri(parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .filter((part) => part.length > 0)
    .join('/')
}

const DEFAULT_DOCUMENT_URI = 'file:///var/mobile/Containers/Data/Application/app/Documents'

const files = new Map<string, number>()
const texts = new Map<string, string>()
let documentUri = DEFAULT_DOCUMENT_URI
let diskSpace = 8_000_000_000

export class Directory {
  readonly uri: string

  constructor(...parts: Array<string | Directory | File>) {
    this.uri = joinUri(parts.map((part) => (typeof part === 'string' ? part : part.uri)))
  }
}

export class File {
  readonly uri: string

  constructor(...parts: Array<string | Directory | File>) {
    this.uri = joinUri(parts.map((part) => (typeof part === 'string' ? part : part.uri)))
  }

  get exists(): boolean {
    return files.has(this.uri) || texts.has(this.uri)
  }

  get size(): number {
    const text = texts.get(this.uri)
    return text !== undefined ? text.length : (files.get(this.uri) ?? 0)
  }

  write(contents: string): void {
    texts.set(this.uri, contents)
  }

  textSync(): string {
    const text = texts.get(this.uri)
    if (text === undefined) {
      throw new Error(`no such file: ${this.uri}`)
    }
    return text
  }

  text(): Promise<string> {
    return Promise.resolve(this.textSync())
  }

  delete(): void {
    files.delete(this.uri)
    texts.delete(this.uri)
  }
}

export const Paths = {
  get document(): Directory {
    return new Directory(documentUri)
  },
  get availableDiskSpace(): number {
    return diskSpace
  },
}

/** Put a file of `size` bytes in the document directory. */
export function writeFakeFile(name: string, size: number): void {
  files.set(joinUri([documentUri, name]), size)
}

/** Put a text file in the document directory. */
export function writeFakeText(name: string, contents: string): void {
  texts.set(joinUri([documentUri, name]), contents)
}

/** The contents of a text file in the document directory, or undefined. */
export function fakeFileText(name: string): string | undefined {
  return texts.get(joinUri([documentUri, name]))
}

/** Whether a file of that name is in the document directory. */
export function fakeFileExists(name: string): boolean {
  return files.has(joinUri([documentUri, name]))
}

export function setDiskSpace(bytes: number): void {
  diskSpace = bytes
}

/** Move the document directory, to exercise a path that needs unescaping. */
export function setDocumentUri(uri: string): void {
  documentUri = uri
}

export function resetFileSystemMock(): void {
  files.clear()
  texts.clear()
  documentUri = DEFAULT_DOCUMENT_URI
  diskSpace = 8_000_000_000
}
