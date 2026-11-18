/**
 * Loading a feature's own chunk (D72).
 *
 * The build leaves the deferred features out of the bundle and writes each one a
 * script of its own, served by the host half's asset route. A chunk's factory is
 * handed the modules the bundle shares with it, so a module with state keeps one
 * instance; which table those modules come from, and what a refusal names, is
 * the package's own and is handed in here.
 */

/** What a chunk's script sets on its own element: its body, still to be run against the shared modules. */
type ChunkFactory = NonNullable<HTMLScriptElement['__dshChunk']>

/** Where a loader's chunks come from. */
export interface ChunkSource {
  /** The package's own name, as its refusals spell it. */
  packageName: string
  /** The modules the bundle carries, by id, as the chunk's `require` answers them. */
  modules: Record<string, unknown>
}

/** How long one chunk's script may take: a route that accepts and then says nothing is not worth the wait. */
const CHUNK_TIMEOUT_MS = 15_000

/**
 * Fetch one chunk's script and take the factory it sets on its own element.
 *
 * The chunk is a classic script served by the host half's asset route: a script
 * element is what the host page's own loader uses, so it runs wherever the
 * bundle does. The element leaves the page once it has run, failed, or run out
 * of time; a route that never answers must not leave the feature waiting for
 * the life of the page.
 */
function fetchFactory(url: string, packageName: string) {
  return new Promise<ChunkFactory>((resolve, reject) => {
    const script = document.createElement('script')
    let settled = false
    const settle = (answer: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      script.remove()
      answer()
    }
    const deadline = setTimeout(() => {
      settle(() => reject(new Error(`${packageName}: the chunk ${url} did not arrive within ${CHUNK_TIMEOUT_MS} ms`)))
    }, CHUNK_TIMEOUT_MS)
    script.src = url
    script.async = true
    script.onload = () => {
      settle(() => {
        if (script.__dshChunk === undefined) reject(new Error(`${packageName}: the chunk ${url} ran without handing back a factory`))
        else resolve(script.__dshChunk)
      })
    }
    script.onerror = () => {
      settle(() => {
        // The route answers every chunk the build in lib/ wrote. A host still
        // serving the bundle it read at boot asks for the chunks of the build
        // before an update, which the update replaced.
        reject(new Error(`${packageName}: the chunk ${url} failed to load; restart the host if the plugin was updated while it ran`))
      })
    }
    document.head.appendChild(script)
  })
}

/**
 * A loader for one package's chunks: a load that succeeded is kept, so a
 * feature switched off and on again reuses it; a load that failed is forgotten,
 * so the next enable retries instead of inheriting one transient error.
 */
export function createChunkLoader<Install>(source: ChunkSource) {
  const loads = new Map<string, Promise<Install>>()

  /**
   * The `require` a chunk's factory receives (D72): the modules the build left
   * out of the chunk because the bundle carries them, as this generation's own
   * instances. A chunk holding a second copy of a module with state would split
   * that state in two, so the build shares every such module through this table.
   */
  function chunkRequire(id: string) {
    if (!Object.hasOwn(source.modules, id)) throw new Error(`${source.packageName}: a feature chunk asks for "${id}", which the bundle does not share`)
    return source.modules[id]
  }

  /**
   * Load one feature chunk and hand back its feature's `install`.
   *
   * @param url - the chunk's address (the asset route, content-hashed).
   * @returns `install`, or a rejection naming the address when the script fails
   *     to load, carries no factory or throws while it runs.
   */
  function load(url: string): Promise<Install> {
    const known = loads.get(url)
    if (known !== undefined) return known
    const pending = fetchFactory(url, source.packageName).then((factory) => {
      const { install } = factory(chunkRequire)
      if (typeof install !== 'function') throw new Error(`${source.packageName}: the chunk ${url} exports no install`)
      return install as Install
    })
    loads.set(url, pending)
    // A failure is that call's own: forgetting it here lets a later enable ask
    // the route again, rather than carrying one network blip as a permanent
    // refusal for the rest of the page.
    pending.catch(() => {
      if (loads.get(url) === pending) loads.delete(url)
    })
    return pending
  }

  return { load }
}
