/** Document schemas describe their bounded observation scope; registration remains catalogue-owned. */
import type { JsonSchemaNode } from '../adapter/dsh/types.js'
import type { ParameterSchema } from './types.js'
import { STORAGE_REFERENCE } from './result.js'
const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const boolean: JsonSchemaNode = { type: 'boolean' }
const strings: JsonSchemaNode = { type: 'array', items: string }
const object = (properties: Record<string, JsonSchemaNode>, required: string[] = []): ParameterSchema => ({ type: 'object', properties, required, additionalProperties: false })
export const DOCUMENT_PARAMETERS = Object.freeze({
  read_pdf: object({
    path: { ...string, description: 'Regular PDF file path relative to the current session cwd.' },
    offset: { type: 'integer', default: 1, description: '1-32 pages, 1-based.' },
    limit: { type: 'integer', default: 10, description: '1-32 pages.' },
  }, ['path']),
  read_docx: object({
    path: { ...string, description: 'Regular DOCX file path relative to the current session cwd. Binary DOC is unsupported.' },
    offset: { type: 'integer', default: 1, description: '1-100000 main-body paragraphs, 1-based.' },
    limit: { type: 'integer', default: 200, description: '1-1000 paragraphs.' },
  }, ['path']),
  read_table: object({
    path: { ...string, description: 'Regular file path relative to the current session cwd.' },
    format: { type: 'string', enum: ['csv', 'tsv'], description: 'Default tsv for .tsv paths, otherwise csv.' },
    encoding: { type: 'string', enum: ['utf-8', 'utf-16le', 'utf-16be'], default: 'utf-8', description: 'Strict decoding; conflicting BOMs fail. No replacement characters.' },
    header: { type: 'boolean', default: true, description: 'First record is columns when true; empty/duplicate column names stay positional.' },
    offset: { type: 'integer', default: 1, description: '1-100000 data rows, 1-based; header is excluded.' },
    limit: { type: 'integer', default: 200, description: '1-1000 data rows.' },
  }, ['path']),
})
export const DOCUMENT_DESCRIPTIONS = Object.freeze({
  read_pdf: 'Read bounded PDF 1.3-1.7 page text and individual runs relative to session cwd. Restricted classic-xref PDFs with standard Helvetica/Courier/Times Type1 fonts and Standard/WinAnsi encoding only. Scope is text-layer content order; excludes rendered reading order, images/OCR, annotations/forms and metadata. Unsupported or malformed later pages retain preceding complete pages with error/nextAction. Check scanComplete versus pageComplete; total/revision require a stable full scan. 16 MiB input and aggregate decoded/processed streams, 1 MiB/page, 32 pages, 30s. Page offsets cannot bypass physical gaps; compare revisions across calls. Failures return status:error|rejected and error.code; never throw.',
  read_table: 'Read bounded CSV/TSV lexical string cells relative to session cwd. Preserves quoted multiline records and physical LF lineStart/lineEnd. Check scanComplete versus pageComplete; total/revision exist only after a stable full scan. Up to 32 MiB, 100000 data records, 1 MiB/record, 1024 columns and 30s; row paging cannot bypass scan gaps. Errors retain safe preceding rows with nextAction. Compare revisions before combining rescanned pages. No spreadsheet formulas or type coercion. Failures return status:error|rejected and error.code; never throw.',
  read_docx: 'Read bounded DOCX main-body paragraphs relative to session cwd, preserving Unicode text and table/row/cell coordinates. Scope excludes layout, headers/footers, notes, comments and metadata; complete applies only to that scope. Standard stored/deflated ZIP, strict UTF-8/BOM UTF-16; unsupported content and parse errors retain safe preceding paragraphs with nextAction. Check scanComplete versus pageComplete; total/revision require a stable full scan. 32 MiB archive, 8 MiB main XML, 1 MiB/paragraph, 100000 paragraphs, 30s. Paging cannot bypass physical gaps; compare revisions across calls. No binary DOC, macros, external fetch or extraction to disk. Failures return status:error|rejected and error.code; never throw.',
})
export const DOCUMENT_FACTS: Record<string, JsonSchemaNode> = {
    scope: string, excludedContent: strings, blocksObserved: integer, pagesObserved: integer, decodedBytes: integer, processedBytes: integer,
    format: string, encoding: string, header: boolean, columns: strings, columnCount: integer,
    bytes: integer, bytesRead: integer, rowsObserved: integer, skipped: integer,
    scanComplete: boolean, pageComplete: boolean, complete: boolean, truncated: boolean,
    truncatedBy: string, nextOffset: integer, total: integer, rowCount: integer, omitted: integer, revision: string,
}
export const DOCUMENT_SOURCE: JsonSchemaNode = { type: 'object', properties: { ...DOCUMENT_FACTS, root: string,
  itemEncoding: string, capturedItems: integer, captureComplete: boolean } }
const TABLE_OUTPUT: JsonSchemaNode = {
  type: 'object', properties: {
    ...DOCUMENT_FACTS, status: string, phase: string, changed: integer, effectState: string, path: string,
    items: { type: 'array', items: object({ row: integer, cells: strings, lineStart: integer, lineEnd: integer }, ['row', 'cells', 'lineStart', 'lineEnd']) },
    error: { type: 'object' }, nextAction: string, reference: STORAGE_REFERENCE, referenceRoot: string,
    source: DOCUMENT_SOURCE, storageError: { type: 'object' },
  },
}
const DOCX_OUTPUT: JsonSchemaNode = { ...TABLE_OUTPUT, properties: { ...TABLE_OUTPUT.properties,
  items: { type: 'array', items: object({ block: integer, type: { type: 'string', enum: ['paragraph'] }, text: string,
    table: integer, row: integer, cell: integer }, ['block', 'type', 'text']) },
} }
const PDF_OUTPUT: JsonSchemaNode = { ...TABLE_OUTPUT, properties: { ...TABLE_OUTPUT.properties,
  items: { type: 'array', items: object({ page: integer, text: string, runs: strings }, ['page', 'text', 'runs']) },
} }
export function isDocumentTool(tool: string): tool is keyof typeof DOCUMENT_PARAMETERS { return Object.hasOwn(DOCUMENT_PARAMETERS, tool) }
export function documentOutput(tool: string): JsonSchemaNode | undefined { return tool === 'read_pdf' ? PDF_OUTPUT : tool === 'read_docx' ? DOCX_OUTPUT : tool === 'read_table' ? TABLE_OUTPUT : undefined }
