/**
 * The on-device model: finding it, fetching it, and reporting on the fetch.
 *
 * `download.ts` holds the mechanics, `hook.ts` the state the screen renders.
 */

export { EXPECTED_BYTES, MODEL_URL, downloadModel, findModel } from './download'
export { useModel } from './hook'
export type { ModelDownload, ModelStatus } from './hook'
