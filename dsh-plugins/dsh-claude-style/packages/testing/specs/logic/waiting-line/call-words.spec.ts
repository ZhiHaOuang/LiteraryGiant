/**
 * What a running tool call hands the waiting line: the description the model
 * declared for a command, and the file a read, edit or write is touching.
 *
 * @capability waiting-line
 * @features chat-wait, shared
 * @risk The line under a running command shows a half-arrived argument, a multi-line description, or the wrong file name while the model works on another one.
 */
import { expect, test } from 'vitest'
import { callDescription, fileName, fileToolCall, fileToolOperation } from '@dsh-claude-style/client/pure'

/** One running call's block: its phase, its tool name and its argument JSON. */
function running(name: string, args: unknown, phase = 'start') {
  return { phase, name, argsRaw: JSON.stringify(args) }
}

test('a started call hands the line the description it declared, as the model first wrote it', () => {
  expect(callDescription(running('pwsh', { command: 'npm run changelog', description: 'Regenerate the changelog' }))).toBe('Regenerate the changelog')
  expect(callDescription(running('bash', { command: 'ls', description: 'list the workspace' }))).toBe('List the workspace')
})

test('only the first line of a description is carried, with its runs of whitespace read as one space', () => {
  expect(callDescription(running('pwsh', { command: 'ls', description: 'list the workspace\nand its sizes' }))).toBe('List the workspace')
  expect(callDescription(running('pwsh', { command: 'ls', description: '  list\t the  workspace  ' }))).toBe('List the workspace')
})

test('a call with nothing of its own answers no description: no field, a blank one, or arguments still arriving', () => {
  expect(callDescription(running('pwsh', { command: 'ls' }))).toBeNull()
  expect(callDescription(running('pwsh', { command: 'ls', description: '' }))).toBeNull()
  expect(callDescription(running('pwsh', { command: 'ls', description: ' \n ' }))).toBeNull()
  expect(callDescription(running('pwsh', { command: 'ls', description: 'list the workspace' }, 'preparing'))).toBeNull()
  expect(callDescription({ phase: 'start', name: 'pwsh', argsRaw: '{"command":"ls","description":"list' })).toBeNull()
})

test('a long description or file name is carried whole: how much of it shows is the row\'s own width', () => {
  const description = `Regenerate ${'a'.repeat(40)} changelog`
  expect(callDescription(running('pwsh', { command: 'x', description }))).toBe(description)
  const long = `${'a'.repeat(60)}-tail.ts`
  expect(fileToolCall(running('read', { file_path: `/work/${long}` }))?.file).toBe(long)
})

test('the three file tools answer their own operation and every other tool answers none', () => {
  expect(fileToolOperation('read')).toBe('read')
  expect(fileToolOperation('edit')).toBe('edit')
  expect(fileToolOperation('write')).toBe('write')
  expect(fileToolOperation('pwsh')).toBeNull()
  expect(fileToolOperation('')).toBeNull()
})

test('a path answers its own name, whatever separator it uses', () => {
  expect(fileName('C:\\work\\app.js')).toBe('app.js')
  expect(fileName('/home/me/pkg/index.ts')).toBe('index.ts')
  expect(fileName('app.js')).toBe('app.js')
})

test('a call in flight names its file, off either argument the host sends', () => {
  expect(fileToolCall(running('read', { file_path: 'C:\\work\\app.js' }))).toEqual({ operation: 'read', file: 'app.js' })
  expect(fileToolCall(running('edit', { path: '/work/notes.md' }))).toEqual({ operation: 'edit', file: 'notes.md' })
  expect(fileToolCall(running('write', { file_path: 'only.md' }))).toEqual({ operation: 'write', file: 'only.md' })
})

test('a call that names no file answers none: another tool, arguments still arriving, or no path', () => {
  expect(fileToolCall(running('pwsh', { command: 'ls' }))).toBeNull()
  expect(fileToolCall(running('read', { file_path: 'app.js' }, 'preparing'))).toBeNull()
  expect(fileToolCall({ phase: 'start', name: 'read', argsRaw: '{"file_path":"app' })).toBeNull()
  expect(fileToolCall(running('read', { file_path: '' }))).toBeNull()
  expect(fileToolCall(running('read', { file_path: 'C:\\work\\' }))).toBeNull()
})
