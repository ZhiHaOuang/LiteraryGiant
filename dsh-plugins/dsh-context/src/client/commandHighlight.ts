import { commandTool } from '../shared/commands'
import { lruTouch, lruTrim } from './lru'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'

export type ShellGrammar = 'bash' | 'powershell'

const GRAMMARS: Partial<Record<string, ShellGrammar>> = { bash: 'bash', pwsh: 'powershell' }

export function grammarOfTool(tool: string): ShellGrammar | undefined {
  const kind = commandTool(tool)
  return kind === null ? undefined : GRAMMARS[kind]
}

const MAX_LINE_CHARS = 1000
const LONG_LINE = new RegExp(`^.{${MAX_LINE_CHARS + 1},}`, 'm')

const runs = new Map<string, readonly HighlightSpan[][]>()
const RUNS_MAX = 600

export function highlightRuns(highlight: CodeHighlighter, grammar: ShellGrammar, text: string): readonly HighlightSpan[][] | undefined {
  if (LONG_LINE.test(text)) return undefined
  const key = grammar + '\u0000' + text
  const hit = runs.get(key)
  if (hit !== undefined) {
    lruTouch(runs, key)
    return hit
  }
  const value = highlight(text)
  if (value !== undefined) {
    runs.set(key, value)
    lruTrim(runs, RUNS_MAX)
  }
  return value
}
