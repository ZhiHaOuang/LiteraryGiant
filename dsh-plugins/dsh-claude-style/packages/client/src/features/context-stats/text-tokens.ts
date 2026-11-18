/**
 * The tokens a piece of the page's text is worth, priced by the shape of its runs.
 *
 * A run is a stretch of one character class: CJK characters, CJK marks, a Latin
 * word, a group of digits, whitespace, punctuation. Each shape carries the price the
 * provider's own tokenizer charges for it, so the written-back figure follows a real
 * count: the wide/narrow split this replaces charged every narrow character alike and
 * every wide one a whole token, so the figure drifted with the language an answer was
 * written in.
 *
 * One pass, constant state: a character either extends the run it belongs to or
 * closes that run and opens the next. A word split across two text nodes is read in
 * the same stream, so it is priced once.
 */

/** A Latin word's price by length; the tenth entry stands for ten letters and up. */
const WORD = [0, 0.496, 0.496, 0.62, 0.62, 0.62, 0.636, 0.636, 0.776, 0.776, 1.593]
const CJK = 0.5235
const CJK_MARK = 2.6312
const DIGIT_GROUP = 1
const NEWLINE = 1.5161
/**
 * A lone space and a run of them: the tokenizer keeps one space inside the piece that
 * follows it, so a lone space is nearly free and a longer run costs a whole token.
 */
const LONE_SPACE = 0.3398
const SPACE_RUN = 1.421
const PUNCT_RUN = 0.8153
const PUNCT_CHAR = 0.1941

/** The classes a run can hold. */
const NONE = 0
const WIDE = 1
const WIDE_MARK = 2
const LETTER = 3
const DIGIT = 4
const SPACE = 5
const PUNCT = 6

/**
 * Whether a wide code point is a mark rather than a character: the tokenizer splits
 * its marks from the text around them, and a run of them costs more.
 */
const WIDE_MARK_TEST = /[\p{P}\p{S}]/u

function classOf(code: number) {
  if (code >= 0x2e80) return WIDE_MARK_TEST.test(String.fromCodePoint(code)) ? WIDE_MARK : WIDE
  if (code >= 0x30 && code <= 0x39) return DIGIT
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return LETTER
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return SPACE
  return PUNCT
}

/**
 * The tokens `texts` are worth, read as one stream of runs.
 *
 * @param texts - the text nodes of one container, in page order; a run crossing a
 *   node boundary is priced once, which is why the strings go in together.
 */
export function textTokens(texts: Iterable<string>) {
  let total = 0
  let kind = NONE
  let length = 0
  let newline = false

  function close() {
    if (kind === WIDE) total += length * CJK
    else if (kind === WIDE_MARK) total += length * CJK_MARK
    else if (kind === LETTER) total += WORD[Math.min(length, 10)]
    else if (kind === DIGIT) total += Math.ceil(length / 3) * DIGIT_GROUP
    else if (kind === SPACE) total += newline ? NEWLINE : length === 1 ? LONE_SPACE : SPACE_RUN
    else if (kind === PUNCT) total += PUNCT_RUN + length * PUNCT_CHAR
    kind = NONE
    length = 0
    newline = false
  }

  for (const text of texts) {
    for (let index = 0; index < text.length; index++) {
      let code = text.charCodeAt(index)
      // A surrogate pair is one character, not two, and its code point is the one that
      // says whether it is an emoji (a mark) or a character.
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        code = text.codePointAt(index) as number
        index += 1
      }
      const next = classOf(code)
      if (next !== kind) {
        close()
        kind = next
      }
      length += 1
      if (next === SPACE && (code === 0x0a || code === 0x0d)) newline = true
    }
  }
  close()
  return total
}
