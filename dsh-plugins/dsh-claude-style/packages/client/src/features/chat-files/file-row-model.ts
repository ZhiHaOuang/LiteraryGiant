import { callString } from '../../shared/call-args'
import type { CallArgs } from '../../shared/call-args'
import { fileToolOperation } from '../../shared/file-tool'
import type { FileToolOperation } from '../../shared/file-tool'
import type { CopyKey } from './copy'
import type { HostText } from '@dsh-claude-style/engine/host'
import type { HostChatBlock } from '@dsh-claude-style/contracts/services'

/**
 * The file-operation row's derivations, kept apart from its React component
 * (chat-files.ts): what a write or edit call is, which diff it shows, and how
 * a path or a failure reads.
 *
 * The host's own file row draws a diff card for a root call only — its
 * diff-card-model returns null the moment a block carries a parentCallId —
 * so the `+96 -0` tail appears on a directly called write or edit and not on
 * the sub-calls run_code dispatches. The skin wants exactly that other half,
 * so it derives the same model without that exclusion. The cost is stated
 * plainly: a sub-call persists no presentation metadata, so after it settles
 * there is nothing saying what was applied and only the arguments can speak —
 * a write's argument is the whole content (exact), an edit's is that pair of
 * replacements (which `replace_all`, or a write that failed, can put out of
 * step with what really happened). A read's window is therefore taken twice:
 * from the call's own metadata where it has any, which is a root call, and
 * otherwise read back out of the model-facing envelope the read tool writes,
 * which is what a sub-call leaves behind; a text that is neither falls back to
 * the skin's IN/OUT card.
 *
 * The three operations take the host's own row through the keyed seat
 * `tool.call.toolview` under the keys `read`, `edit` and `write`, registered
 * and released together, so every file operation draws in the skin's row.
 *
 * Within one process group the same file's calls read as one row, headed by the
 * earliest call still mounted (file-row-merge.ts keeps the registry). A
 * registration is keyed by call id because the host hands one row element to
 * the file's next call: keyed by element, a read would zero a tail another call
 * wrote. The flipping digits clip with `clip-path`, since `overflow` would move
 * the inline-block's baseline and lift the glyphs. A host that draws one row
 * per file itself replaces this model.
 */

/** One change a file row draws: the file, the text replaced (null for a new file) and the text written. */
export interface FileHunk {
  path: string
  oldText: string | null
  newText: string
}

/** Where a file row's call stands. */
export type FileRowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

/** One line of a read card: its file line number and its text, without its newline. */
export interface FileReadLine {
  number: number
  text: string
}

/** The read window a read row draws, in the shape the read card primitive takes. */
export interface FileReadCard {
  path: string
  lines: FileReadLine[]
  totalLines: number
  lang?: string
}

/** The host's title key for one operation. */
export function chatFileOperationTitle(operation: FileToolOperation) {
  if (operation === 'read') return 'tool.title.read'
  return operation === 'write' ? 'tool.title.write' : 'tool.title.edit'
}

/**
 * The host's own id for one call, which tells a file's calls apart on a row
 * element the host keeps across them. A block that carries none stands for
 * a call nothing can tell from the next, and its element then holds one call.
 */
export function chatFileCallId(block: HostChatBlock) {
  return typeof block.callId === 'string' ? block.callId : ''
}

/** The row root. */
export const CHAT_FILE_ROW_CLASS = 'dsh-claude-file-root'
/** The disclosure row's own element: the hover highlight hangs here. */
export const CHAT_FILE_ROW_LINE_CLASS = 'dsh-claude-file-row'
/** The icon slot. */
export const CHAT_FILE_LEADING_CLASS = 'dsh-claude-file-leading'
/** The open and close chevron. */
export const CHAT_FILE_CHEVRON_CLASS = 'dsh-claude-file-chevron'
/** The title (read, edit or write). */
export const CHAT_FILE_TITLE_CLASS = 'dsh-claude-file-title'
/** The dot between the title and the summary. */
export const CHAT_FILE_SEP_CLASS = 'dsh-claude-file-sep'
/** The summary text. */
export const CHAT_FILE_SUMMARY_CLASS = 'dsh-claude-file-summary'
/** The failure colour on the summary. */
export const CHAT_FILE_ERROR_CLASS = 'dsh-claude-file-error'
/** The stopped colour on the summary. */
export const CHAT_FILE_STOPPED_CLASS = 'dsh-claude-file-stopped'
/** The clickable file path. */
export const CHAT_FILE_LINK_CLASS = 'dsh-claude-file-link'
/** The container of the small statistics tail. */
export const CHAT_FILE_SUFFIX_CLASS = 'dsh-claude-file-suffix'
/** The type size both statistics share. */
export const CHAT_FILE_STAT_CLASS = 'dsh-claude-file-stat'
/** The added count. */
export const CHAT_FILE_ADD_CLASS = 'dsh-claude-file-add'
/** The removed count. */
export const CHAT_FILE_DEL_CLASS = 'dsh-claude-file-del'
/** One figure of the tail, which rolls character by character. */
export const CHAT_FILE_ROLL_CLASS = 'dsh-claude-file-roll'
/** One character of that figure, in its own box. */
export const CHAT_FILE_ROLL_DIGIT_CLASS = 'dsh-claude-file-roll-digit'
/** On the character whose own digit changed: this one travels. */
export const CHAT_FILE_ROLL_MOVING_CLASS = 'dsh-claude-file-roll-moving'
/** The digit leaving upward. */
export const CHAT_FILE_ROLL_OUT_CLASS = 'dsh-claude-file-roll-out'
/** The digit in flow, which the leaving one makes way for. */
export const CHAT_FILE_ROLL_IN_CLASS = 'dsh-claude-file-roll-in'
/**
 * On the row while its file's calls are read together: `head` on the row that
 * stands for the file, `member` on the rows it stands for, `gone` on a merged
 * row's carrier — the host's own call row — whose box comes off the page.
 */
export const CHAT_FILE_MERGE_ATTR = 'data-dsh-claude-file-merge'
export const CHAT_FILE_MERGE_HEAD = 'head'
export const CHAT_FILE_MERGE_MEMBER = 'member'
export const CHAT_FILE_MERGE_GONE = 'gone'
/** The merged row's screen-reader sentence: the calls its file's other rows held. */
export const CHAT_FILE_MERGED_COPY: CopyKey = 'fileRowMergedOperations'
/** The expanded body. */
export const CHAT_FILE_BODY_CLASS = 'dsh-claude-file-body'
/** The diff card inside an expanded body. */
export const CHAT_FILE_DIFF_CLASS = 'dsh-claude-file-diff'
/** The IN/OUT card inside an expanded body. */
export const CHAT_FILE_IO_CLASS = 'dsh-claude-file-io'
/** One section of the IN/OUT card. */
export const CHAT_FILE_IO_SECTION_CLASS = 'dsh-claude-file-io-section'
/** The hairline between IN and OUT. */
export const CHAT_FILE_IO_DIVIDER_CLASS = 'dsh-claude-file-io-divider'
/** The IN and OUT side labels. */
export const CHAT_FILE_IO_LABEL_CLASS = 'dsh-claude-file-io-label'
/** The IN and OUT bodies. */
export const CHAT_FILE_IO_TEXT_CLASS = 'dsh-claude-file-io-text'
/** The trajectory entrance pill. */
export const CHAT_FILE_INSPECT_CLASS = 'dsh-claude-file-inspect'
/** The operation block: the file's icon and title, which swap when its work moves on. */
export const CHAT_FILE_OP_CLASS = 'dsh-claude-file-op'
/** On that block while a swap is in flight. */
export const CHAT_FILE_OP_SWAPPING_CLASS = 'dsh-claude-file-op-swapping'
/** The operation leaving: it holds the block's own cell while the new one rises in. */
export const CHAT_FILE_OP_OUT_CLASS = 'dsh-claude-file-op-out'
/** The operation in flow. */
export const CHAT_FILE_OP_IN_CLASS = 'dsh-claude-file-op-in'
/** The operation this row wears, for the stylesheet and for tests. */
export const CHAT_FILE_OP_ATTR = 'data-dsh-claude-file-op'
/** The disclosure row's own title slot: it stays empty, so the label stands beside it. */
export const CHAT_FILE_TITLE_SLOT_CLASS = 'dsh-claude-file-title-slot'
/** The read card inside an expanded body. */
export const CHAT_FILE_READ_CLASS = 'dsh-claude-file-read'
/** The running state label only a screen reader reads. */
export const CHAT_FILE_HIDDEN_CLASS = 'dsh-claude-file-hidden'
/** The seat the read, write and edit rows render through; the host's own rows sit at priority 0 and a keyed seat renders the lowest. */
export const CHAT_FILE_SEAT = 'tool.call.toolview'

/** A chat row shows this many lines before a diff card folds its middle; the host's own CHAT_DIFF_MAX_LINES. */
export const CHAT_DIFF_MAX_LINES = 9

/** A read card shows this many lines before it folds its middle; the host's own read row cap. */
export const CHAT_READ_MAX_LINES = 8

/**
 * This row's call head: a settled call reads the one its result node brought
 * back, a running one its own arguments.
 */
export function chatFileCallHead(block: HostChatBlock): { name: string, argsRaw: string } | null {
  if ('kind' in block) return block.call ?? null
  if (block.phase !== 'start') return null
  return { name: block.name ?? '', argsRaw: block.argsRaw ?? '' }
}

/**
 * The optional sandbox escalation pair: a file-writing row draws its diff
 * only while the two are together and valid, and otherwise falls back to the
 * IN/OUT card — the host's own test.
 */
export function chatFileValidEscalation(args: CallArgs) {
  const permission = args.sandbox_permissions
  const justification = args.justification
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}

/**
 * Shorten an absolute path into the shape a reader recognises: relative to
 * the session workspace first, then any leftover home prefix as `~`.
 */
export function chatFileShortenPath(path: string, cwd: string | undefined, home: string | undefined) {
  if (cwd !== undefined && cwd !== '' && path.startsWith(cwd)) {
    const rest = path.slice(cwd.length).replace(/^[\\/]+/, '')
    if (rest !== '') return rest
  }
  if (home !== undefined && home !== '' && path.startsWith(home)) {
    const rest = path.slice(home.length)
    if (rest === '' || rest.startsWith('/') || rest.startsWith('\\')) return '~' + rest.replace(/\\/g, '/')
  }
  return path
}

/** The first line of a piece of text. */
export function chatFileFirstLine(text: string) {
  const lineBreakAt = text.indexOf('\n')
  return lineBreakAt === -1 ? text : text.slice(0, lineBreakAt)
}

/**
 * Derive the change from the call's arguments: a write is the whole content,
 * an edit is that pair of replacements.
 */
export function chatFileIntendedHunks(name: string, args: CallArgs | null): FileHunk[] | null {
  if (args === null) return null
  const path = callString(args, ['path', 'file_path'])
  if (path === undefined) return null
  if (!chatFileValidEscalation(args)) return null
  if (name === 'write') {
    const content = args.content
    return typeof content === 'string' ? [{ path, oldText: null, newText: content }] : null
  }
  if (name !== 'edit') return null
  const oldText = args.old_string
  const newText = args.new_string
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  const replaceAll = args.replace_all
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return null
  return [{ path, oldText: oldText === '' ? null : oldText, newText }]
}

/**
 * Read the hunks the result metadata says were really applied.
 * @returns the hunks, `empty` when the metadata says nothing changed, or null when it is unusable.
 */
export function chatFileAppliedHunks(meta: unknown): FileHunk[] | 'empty' | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  // The tool's own metadata: it arrives as JSON, so every field is checked here.
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return 'empty'
  const hunks: FileHunk[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk as { path?: unknown, oldText?: unknown, newText?: unknown }
    if (typeof path !== 'string') return null
    if (oldText !== null && oldText !== undefined && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    hunks.push({ path, oldText: oldText ?? null, newText })
  }
  return hunks
}

/**
 * Derive the change this row shows. One branch differs from the host's own
 * diff-card-model: sub-calls are not excluded. The rest keeps its order —
 * while a call is unsettled only its arguments are available, and once
 * settled the metadata's really-applied hunks win, with the arguments as the
 * fallback.
 * @returns the hunks to draw, or null when this row has none.
 */
export function chatFileDiffHunks(block: HostChatBlock, args: CallArgs | null) {
  if (!('kind' in block)) {
    if (block.phase === 'preparing') return null
    return chatFileIntendedHunks(block.name ?? '', args)
  }
  if (block.isError) return null
  const applied = chatFileAppliedHunks(block.meta)
  if (applied !== null && applied !== 'empty') return applied
  if (block.call === undefined || block.call === null) return null
  return chatFileIntendedHunks(block.call.name, args)
}

/**
 * Everything this row renders from.
 * @returns the row's model.
 */
export function chatFileRowModel(toolName: string, block: HostChatBlock, args: CallArgs | null, cwd: string | undefined, home: string | undefined) {
  const done = 'kind' in block
  const head = chatFileCallHead(block)
  const operation = fileToolOperation(toolName) ?? 'edit'
  const state: FileRowState = !done
    ? block.phase === 'preparing' ? 'preparing' : 'running'
    : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  const path = args === null ? undefined : callString(args, ['path', 'file_path'])
  const output = done ? chatFileResultText(block) || null : null
  return {
    operation,
    titleKey: chatFileOperationTitle(operation),
    variant: operation,
    summary: path === undefined ? '' : chatFileShortenPath(path, cwd, home),
    filePath: path,
    bodyRaw: head === null || head.argsRaw === '' ? null : head.argsRaw,
    output,
    errorSummary: state === 'error' && output !== null ? chatFileFirstLine(output) : null,
    state,
  }
}

/**
 * Flatten a settled result into display text: text blocks as they are, every
 * other block as JSON. A result with no content falls back to its error.
 */
export function chatFileResultText(node: HostChatBlock) {
  const parts: string[] = []
  for (const block of node.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    parts.push(JSON.stringify(block, null, 2))
  }
  if (parts.length === 0 && node.error !== undefined) parts.push(`${node.error.name ?? ''}: ${node.error.code ?? ''}`)
  return parts.join('\n')
}

/**
 * The one text block a first-party card is derived from. The host's own read
 * card takes its material from exactly one, and a result laid out any other way
 * has no window to draw.
 */
function chatFileSingleResultText(node: HostChatBlock) {
  if (node.content?.length !== 1) return null
  const only = node.content[0]
  return only.type === 'text' && typeof only.text === 'string' ? only.text : null
}

/**
 * The read window a settled call's own metadata describes. The shape and the
 * range checks are the host's own (dsh-client-ui-tool's read-card model): a
 * window that misnumbers or overcounts its lines declines here rather than
 * reaching the card.
 */
export function chatFileReadMeta(meta: unknown): FileReadCard | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const { path, offset, lines, totalLines, lang } = meta as { path?: unknown, offset?: unknown, lines?: unknown, totalLines?: unknown, lang?: unknown }
  if (typeof path !== 'string' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1) return null
  if (typeof totalLines !== 'number' || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)) return null
  if (lang !== undefined && typeof lang !== 'string') return null
  const window: FileReadLine[] = []
  let previous = offset - 1
  for (const line of lines) {
    if (typeof line !== 'object' || line === null || Array.isArray(line)) return null
    const { number, text } = line as { number?: unknown, text?: unknown }
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= previous) return null
    if (number > totalLines || typeof text !== 'string') return null
    previous = number
    window.push({ number, text })
  }
  return lang === undefined ? { path, lines: window, totalLines } : { path, lines: window, totalLines, lang }
}

/** One numbered line of the read tool's model-facing envelope: `<number>: <text>`. */
const READ_LINE = /^(\d+): (.*)$/u

/** The envelope's end-of-file footer: `(End of file - total N lines)`. */
const READ_FOOTER_END = /^\(End of file - total (\d+) lines?\)$/u
/** The envelope's window footer: `(Showing lines A-B of N. Use offset=B+1 to continue.)`. */
const READ_FOOTER_WINDOW = /^\(Showing lines \d+-\d+ of (\d+)\. Use offset=\d+ to continue\.\)$/u
/** The envelope's byte-capped footer, which names the window and no total. */
const READ_FOOTER_CAPPED = /^\(Output capped\. Showing lines \d+-\d+\. Use offset=\d+ to continue\.\)$/u

/**
 * The file's total line count as the envelope's own footer names it, or null for
 * the byte-capped footer: it reports its window and stops there.
 */
function readFooterTotal(footer: string) {
  const total = READ_FOOTER_END.exec(footer)?.[1] ?? READ_FOOTER_WINDOW.exec(footer)?.[1]
  if (total === undefined) return null
  const value = Number(total)
  return Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * The read window a call's result text describes. A sub-call persists no
 * presentation metadata, so its window is read back out of the model-facing
 * envelope the read tool writes (dsh-tool-fs's formatReadOutput): numbered
 * lines, a blank line, then a footer naming the file's total. Without a total
 * the last line number stands in, which is what the card needs to leave its
 * "showing N of M" note out.
 *
 * @param text - the settled result's own text.
 * @param path - the file the call read, for a card whose envelope is unusable.
 * @returns the card, or null when this text is not a read envelope.
 */
export function chatFileReadEnvelope(text: string, path: string): FileReadCard | null {
  const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
  if (body === undefined) return null
  const lines: FileReadLine[] = []
  let footer: string | null = null
  for (const row of body.split('\n')) {
    if (footer !== null) {
      // The footer is the envelope's last line: anything else after it is not
      // this shape, and a card drawn from it would show a footer as file text.
      if (row !== '') return null
      continue
    }
    if (row === '') continue
    const numbered = READ_LINE.exec(row)
    if (numbered === null) {
      // Every content line is numbered, so the first other line is the footer —
      // and only one of the three the read tool writes, or this is not an
      // envelope whose window can be read back.
      if (READ_FOOTER_END.exec(row) === null && READ_FOOTER_WINDOW.exec(row) === null && READ_FOOTER_CAPPED.exec(row) === null) return null
      footer = row
      continue
    }
    lines.push({ number: Number(numbered[1]), text: numbered[2] })
  }
  const endLine = lines.length === 0 ? 0 : lines[lines.length - 1].number
  return { path, lines, totalLines: (footer === null ? null : readFooterTotal(footer)) ?? endLine }
}

/**
 * The read card a read row draws: the call's own metadata where it has any (a
 * root call), else the result text's envelope (a sub-call), else null so the
 * row falls back to its IN/OUT card instead of drawing a bare envelope.
 */
export function chatFileReadCard(block: HostChatBlock, path: string | undefined): FileReadCard | null {
  if (!('kind' in block) || block.isError) return null
  const own = chatFileReadMeta(block.meta)
  if (own !== null) return own
  if (path === undefined) return null
  const text = chatFileSingleResultText(block)
  return text === null ? null : chatFileReadEnvelope(text, path)
}

/** The summary's class names: a failure and an interruption each carry their own state colour. */
export function chatFileSummaryClassName(state: FileRowState) {
  if (state === 'error') return CHAT_FILE_SUMMARY_CLASS + ' ' + CHAT_FILE_ERROR_CLASS
  if (state === 'stopped') return CHAT_FILE_SUMMARY_CLASS + ' ' + CHAT_FILE_STOPPED_CLASS
  return CHAT_FILE_SUMMARY_CLASS
}

/**
 * The state text for a screen reader: neither the icon nor the shimmer says
 * anything, so this sentence says it for them.
 * @returns the state text, or null when there is nothing to announce.
 */
export function chatFileStateLabel(state: FileRowState, t: HostText) {
  if (state === 'running') return t('row.running')
  if (state === 'error') return t('row.failed')
  if (state === 'stopped') return t('row.stopped')
  return null
}

/** Assemble the diff card's own chrome copy. */
export function chatFileDiffBlockLabels(t: HostText) {
  return {
    codeLabel: t('codeBlock.title'),
    wrapLabel: t('codeBlock.wrap'),
    unwrapLabel: t('codeBlock.unwrap'),
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('diff.collapseAria'),
    expandAria: (hidden: number) => t('diff.expandAria', { count: hidden }),
    collapse: t('collapse'),
    expand: (hidden: number) => t('diff.expandRest', { count: hidden }),
  }
}

/**
 * Assemble the read card's own chrome copy, on the keys the host's own read card
 * reads, so the skin's card says the same things in the same words.
 */
export function chatFileReadBlockLabels(t: HostText) {
  return {
    codeLabel: t('codeBlock.title'),
    wrapLabel: t('codeBlock.wrap'),
    unwrapLabel: t('codeBlock.unwrap'),
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('read.collapseAria'),
    expandAria: (hidden: number) => t('read.expandAria', { count: hidden }),
    collapse: t('collapse'),
    expand: (hidden: number) => t('read.expandRest', { count: hidden }),
    window: (shown: number, total: number) => t('read.window', { shown, total }),
  }
}
