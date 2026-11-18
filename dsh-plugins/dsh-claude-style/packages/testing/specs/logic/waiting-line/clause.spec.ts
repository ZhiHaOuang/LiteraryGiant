/**
 * The waiting line quotes the model's own clause about what it is doing: the
 * newest complete "I am …ing" sentence of its reasoning, participle first, and
 * nothing at all where the reasoning states no such clause.
 *
 * @capability waiting-line
 * @features chat-wait, shared
 * @risk The line under a running answer shows half a sentence, a quoted sentence the model was only discussing, a negated plan, or a clause from minutes ago.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { PHRASE_TAIL_CHARS, activityPhrase } from '@dsh-claude-style/client/pure'

test('the model\'s own clause stands without its subject: participle first, to the sentence\'s end', () => {
  expect(activityPhrase('Let me look. I am checking the file is true. ')).toBe('Checking the file is true')
  expect(activityPhrase('The user asked about the row. Now I am reading the row model.')).toBe('Reading the row model')
})

test('a contraction counts as its auxiliary', () => {
  expect(activityPhrase("I'm checking the row model, then I answer.")).toBe('Checking the row model')
  expect(activityPhrase('It’s reading the file now.')).toBe('Reading the file now')
})

test('the newest complete clause wins, and a clause still streaming is left alone', () => {
  expect(activityPhrase('I am reading the first file. Then I am checking')).toBe('Reading the first file')
  expect(activityPhrase('I am checking the file')).toBeNull()
  expect(activityPhrase('')).toBeNull()
})

test('a dot inside a name, a version or an abbreviation does not end the sentence', () => {
  expect(activityPhrase('I am reading app.js now.')).toBe('Reading app.js now')
  expect(activityPhrase('I am checking package.json and the lock.')).toBe('Checking package.json and the lock')
  expect(activityPhrase('I am reading version 1.2.3 of the plugin.')).toBe('Reading version 1.2.3 of the plugin')
  expect(activityPhrase('I am reading e.g. the row model.')).toBe('Reading e.g. the row model')
})

test('the words between the auxiliary and the participle are read, up to two of them', () => {
  expect(activityPhrase('I am now checking the file.')).toBe('Checking the file')
  expect(activityPhrase("I'm currently reviewing the diff.")).toBe('Reviewing the diff')
  expect(activityPhrase('I am still reading the file.')).toBe('Reading the file')
  expect(activityPhrase('I am just verifying the output.')).toBe('Verifying the output')
  expect(activityPhrase("I've been checking the file for a while.")).toBe('Checking the file for a while')
})

test('a negated clause is passed over: the line says what the model is doing', () => {
  expect(activityPhrase('I am not sure about this one.')).toBeNull()
  expect(activityPhrase('I am reading the file. I am not going to guess.')).toBe('Reading the file')
  expect(activityPhrase('I am not currently checking that.')).toBeNull()
})

test('reasoning in another language, or with no clause at all, hands the line nothing', () => {
  expect(activityPhrase('我正在读取 app.js，然后回答。')).toBeNull()
  expect(activityPhrase('先看清工作区，再动手。')).toBeNull()
  expect(activityPhrase('Nothing here at all.')).toBeNull()
})

test('a sentence the model quotes is not the model saying what it is doing', () => {
  expect(activityPhrase('the row reads 「正在思考」 because the *lock* doesn\'t apply to the first write')).toBeNull()
  expect(activityPhrase('The line then says "I am checking the file is true".')).toBeNull()
  // A quotation inside a clause the model states itself is carried as written.
  expect(activityPhrase('I am checking "app.js" now.')).toBe('Checking "app.js" now')
})

test('the markers the reasoning is written with stay out of the line', () => {
  expect(activityPhrase('I am checking `chat-wait.ts` and **the lock** now.')).toBe('Checking chat-wait.ts and the lock now')
})

test('an `-ing` word that is no participle is not read as one', () => {
  expect(activityPhrase('It is morning.')).toBeNull()
  expect(activityPhrase('There is nothing left to do.')).toBeNull()
})

test('a plan the model has not started hands the line nothing', () => {
  expect(activityPhrase('Let me check the file first.')).toBeNull()
  expect(activityPhrase('I am about to check the tests.')).toBeNull()
  expect(activityPhrase('Reading the file now, then I edit the row.')).toBeNull()
})

test('the shape is the rule: an adjective of the same shape reads as a clause too', () => {
  expect(activityPhrase('The file is missing.')).toBe('Missing')
  expect(activityPhrase('The build is running.')).toBe('Running')
})

test('a long clause is carried whole: how much of it shows is the row\'s own width', () => {
  const long = 'I am checking whether the whole row model still reads the same arguments as before.'
  expect(activityPhrase(long)).toBe('Checking whether the whole row model still reads the same arguments as before')
})

test('only the tail of a long reasoning is read', () => {
  const old = `I am reading the old file. ${'x'.repeat(PHRASE_TAIL_CHARS)} `
  expect(activityPhrase(old)).toBeNull()
  expect(activityPhrase(`${old}I am checking the new file.`)).toBe('Checking the new file')
})

test('whatever the reasoning holds, the line is a single line starting in capital, or nothing', () => {
  fc.assert(fc.property(fc.string({ maxLength: 300 }), (text) => {
    const phrase = activityPhrase(text)
    if (phrase === null) return
    expect(phrase).not.toMatch(/[\r\n]/)
    expect(phrase).toBe(phrase.trim())
    expect(phrase.charAt(0)).toBe(phrase.charAt(0).toUpperCase())
  }))
})
