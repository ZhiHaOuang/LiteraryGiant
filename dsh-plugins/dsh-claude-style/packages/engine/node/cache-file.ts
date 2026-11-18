/**
 * A host half's derived cache files, under `$DSH_HOME/cache/<package name>/`.
 *
 * Every cache here only saves work: a file that does not parse is reported and
 * read as "no cache", and a write that fails leaves the pass that computed the
 * value still answering (D12). A write goes through a temporary
 * file and a rename, so a reader never sees half a document.
 *
 * The path resolution stays in harness-home.ts, so the cache sits in the same
 * directory as the delete route's and the usage roll-up's reads.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DshContext } from './dsh'
import { harnessPath } from './harness-home'

/** The cache files of the plugin named `packageName`. */
export function createCacheFiles(packageName: string) {
  return {
    /** One path inside this plugin's cache directory in the harness home. */
    cachePath(ctx: DshContext, ...segments: string[]) {
      return join(harnessPath(ctx, 'cache', packageName), ...segments)
    },

    /**
     * One JSON document from disk.
     *
     * @param ctx - host plugin context, for the warning a failure leaves.
     * @param path - the file to read.
     * @param label - what the file is, for the warning.
     * @returns the parsed document, or undefined when it is absent or unreadable.
     */
    readJsonDocument(ctx: DshContext, path: string, label: string): unknown {
      if (!existsSync(path)) return undefined
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        ctx.logger?.warn?.(`${packageName}: ${label} unreadable (${(error as { message?: string }).message})`)
        return undefined
      }
    },

    /**
     * Replace one cache file through a temporary file.
     *
     * @param ctx - host plugin context, for the warning a failure leaves.
     * @param path - the file to write.
     * @param label - what the file is, for the warning.
     * @param document - the value to store.
     * @returns whether the file now holds the document.
     */
    writeJsonDocument(ctx: DshContext, path: string, label: string, document: unknown): boolean {
      const temporary = `${path}.${process.pid}.tmp`
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(temporary, JSON.stringify(document), 'utf8')
        renameSync(temporary, path)
        return true
      } catch (error) {
        ctx.logger?.warn?.(`${packageName}: ${label} not written: ${(error as { message?: string }).message}`)
        return false
      }
    },
  }
}
