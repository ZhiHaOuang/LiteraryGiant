import { partRegions } from '@dsh-claude-style/engine/parts-table'
import type { PartsVocabulary } from '@dsh-claude-style/engine/parts'

/**
 * One region of the part tables, read the way a spec needs it: `box(local)`
 * builds the host's element for a local class name the region names (the hash
 * is the fixture's), and `part(local)` is the part it becomes. A spec never
 * spells a host class name itself (D3), and a rename in the tables moves every
 * spec that reads the region with it.
 *
 * @param within - the selector the region is walked within.
 * @param vocabulary - the spec's own vocabulary, so the tables are read with it.
 */
export function partRegion(within: string, vocabulary: PartsVocabulary) {
  const found = partRegions(vocabulary).find(candidate => candidate.within === within)
  if (found === undefined) throw new Error(`no part region walked within ${within}`)
  const table: Record<string, string> = { ...found.parts, ...found.rootParts }
  const known = (local: string) => {
    if (!(local in table)) throw new Error(`the region within ${within} names no class "${local}"`)
    return local
  }
  return {
    /** One host element of the region, carrying the class name and its children. */
    box(local: string, ...children: Node[]) {
      const element = document.createElement('div')
      element.className = `_${known(local)}_ab`
      element.append(...children)
      return element
    },
    /** The part name the region gives one of its local class names. */
    part: (local: string) => table[known(local)]!,
  }
}
