/**
 * The header's session title is the session's own name. The pointer over it
 * raises a plate under the words and a tip that names the press; a press opens a
 * field over the words, seeded with the title the session list carries; Enter
 * hands the new name to the host and the field goes, while Escape leaves the
 * title as it was.
 *
 * @capability session-title
 * @features session-title
 * @risk A press on the title opens nothing, or a rename reaches the session list while the header keeps the old words, so a reader cannot tell which name the session now carries.
 */
import { spec, surface } from '../../fixtures/behaviour.mjs'

/** The last crumb segment — the session the header shows — and the words inside it. */
const seat = (t) => `${t.host('header.title')} > :last-child`
const words = (t) => `${seat(t)} > span:last-of-type`
/** The web app selects nothing in the chrome until this skin's own plate shows (this feature's stylesheet paints it). */
const FLAT = 'rgba(0, 0, 0, 0)'

export default spec({ page: 'session-title' }, ({ test }) => {
  test('the pointer over the title raises the plate and the tip that names the press', async (t) => {
    const tip = surface('sessionTitle.tip')
    t.expectThat.equal(await t.read.computed(words(t), 'cursor'), 'text', 'the title reads as words the reader can name')
    t.expectThat.equal(await t.read.computed(words(t), 'background-color'), FLAT, 'the title stands flat until the pointer is on it')
    t.expectThat.absent(await t.read.count(tip), 'the tip stands only under the pointer')

    await t.page.hover(words(t))
    // The plate fades in: the colour is read once the transition has run.
    await t.settle()
    t.expectThat.equal(await t.read.count(tip), 1, 'the tip stands under the pointer')
    t.expectThat.equal(await t.read.text(tip), 'Rename session', 'the tip names what a press on the name does')
    const tipBox = await t.read.box(tip)
    const wordBox = await t.read.box(words(t))
    t.expectThat.visible(tipBox, 'the tip is drawn')
    // Under the words, and no further left than the words' own start: the tip
    // is the skin's own element because the host clips the row's overflow.
    t.expectThat.boxWithin(tipBox, { left: wordBox.left - 0.5, right: wordBox.right + 200, top: wordBox.bottom - 0.5, bottom: wordBox.bottom + 40 }, 'the tip stands under the words')
    t.expectThat.equal(await t.read.computed(words(t), 'background-color') === FLAT, false, 'the words take the plate under the pointer')
  })

  test('a press opens a field over the words, seeded with the title the list carries', async (t) => {
    const field = surface('sessionTitle.field')
    await t.page.click(words(t))
    t.expectThat.equal(await t.read.count(field), 1, 'the press opens one field')
    const fieldBox = await t.read.box(field)
    const wordBox = await t.read.box(words(t))
    t.expectThat.visible(fieldBox, 'the field is drawn')
    // Over the words, wide enough for every one of them: the field's own ring and
    // padding stand a little above and below the line, so the vertical slack is
    // that edge rather than a position.
    t.expectThat.boxWithin(fieldBox, { left: wordBox.left - 60, right: wordBox.right + 60, top: wordBox.top - 8, bottom: wordBox.bottom + 8 }, 'the field stands over the words it renames')
    t.expectThat.equal(await t.page.inputValue(field), 'smoke session', 'the field carries the title the session list holds')
    t.expectThat.equal(await t.read.attribute(field, 'aria-label'), 'Rename session', 'the field names what it does')
  })

  test('Enter hands the typed name to the host, and the title follows it', async (t) => {
    const field = surface('sessionTitle.field')
    await t.page.click(words(t))
    await t.page.fill(field, 'a name the reader typed')
    await t.page.press(field, 'Enter')
    await t.settle()
    t.expectThat.absent(await t.read.count(field), 'the field goes once the host accepted the name')
    t.expectThat.equal(await t.page.evaluate(() => window.__renamed.length), 1, 'the host was asked once')
    t.expectThat.equal(await t.page.evaluate(() => window.__renamed[0].title), 'a name the reader typed', 'the host was asked for the words the reader typed')
    t.expectThat.equal(await t.read.text(words(t)), 'a name the reader typed', 'the header carries the name the session now has')
  })

  test('a press on a crumb that opens a session stays the host\'s press', async (t) => {
    await t.page.click(`${t.host('header.title')} > :first-child > button`)
    t.expectThat.absent(await t.read.count(surface('sessionTitle.field')), 'the parent crumb opens no field')
    t.expectThat.equal(await t.read.computed(words(t), 'cursor'), 'text', 'the session\'s own title keeps its own press')
  })

  test('Escape leaves the title as it was', async (t) => {
    const field = surface('sessionTitle.field')
    const before = await t.read.text(words(t))
    await t.page.click(words(t))
    await t.page.fill(field, 'a name the reader did not mean')
    await t.page.press(field, 'Escape')
    await t.settle()
    t.expectThat.absent(await t.read.count(field), 'the field goes')
    t.expectThat.equal(await t.page.evaluate(() => window.__renamed.length), 0, 'the host was asked for nothing')
    t.expectThat.equal(await t.read.text(words(t)), before, 'the title still carries its own name')
  })
})
