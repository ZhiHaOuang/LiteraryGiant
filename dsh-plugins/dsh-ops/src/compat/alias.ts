/** Backward-compatible alias mapping for tool names renamed in 0.4.0.
 *  Old raw names in saved profiles are silently migrated to new names at load time. */
export const RENAMED_TOOLS = Object.freeze({
  read_many: 'read_files',
  edit_many: 'edit_file',
  table_read: 'read_table',
  doc_read: 'read_docx',
  pdf_read: 'read_pdf',
  sdk: 'load_sdk',
  discover: 'discover_tools',
} as const)
export type OldRawName = keyof typeof RENAMED_TOOLS
export type NewRawName = typeof RENAMED_TOOLS[OldRawName]

/** Map a raw name through the rename table; unknown names pass through unchanged. */
export function migrateRawName(name: string): string {
  return (RENAMED_TOOLS as Record<string, string>)[name] ?? name
}

/** Migrate an array of raw names, deduplicating after rename. */
export function migrateRawNames(names: readonly string[]): string[] {
  return [...new Set(names.map(migrateRawName))]
}
