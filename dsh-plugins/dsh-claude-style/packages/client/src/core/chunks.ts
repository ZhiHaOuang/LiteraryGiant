import { CHUNK_MODULES } from 'virtual:dsh-claude-style/chunk-modules'
import { createChunkLoader } from '@dsh-claude-style/engine/chunks'
import { PACKAGE_NAME } from '../constants'
import type { FeatureInstall } from './feature'

/**
 * This package's deferred features, loaded through the engine's loader (D72,
 * D73): the build's shared-module table and this package's own name are what
 * this half hands over.
 */
const chunks = createChunkLoader<FeatureInstall>({ packageName: PACKAGE_NAME, modules: CHUNK_MODULES })

/**
 * Load one feature chunk and hand back its feature's `install` (D72).
 *
 * @param url - the chunk's address (the asset route, content-hashed).
 * @returns `install`, or a rejection naming the address when the script fails
 *     to load, carries no factory or throws while it runs.
 */
export function loadFeatureChunk(url: string): Promise<FeatureInstall> {
  return chunks.load(url)
}
