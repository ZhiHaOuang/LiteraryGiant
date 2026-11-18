import * as React from 'react'
import { BRAND_IMAGE_MAX_BYTES, BRAND_IMAGE_TYPES } from '@dsh-claude-style/contracts/brand'
import type { BrandImageKind } from '@dsh-claude-style/contracts/brand'
import { BRAND_CLAUDE, BRAND_INK_ORIGINAL, BRAND_NAME_MAX } from '../../constants'
import { loadBrandImages, readBrandImages, removeBrandImage, subscribeBrandImages, uploadBrandImage } from '../../shared/custom-brand'
import type { BrandImage } from '../../shared/custom-brand'
import type { Prefs } from '../../constants'
import type { SettingsView } from './settings-controls'
import { copy } from './copy'

/**
 * The brand area as the settings page's own drawn lockup (D30): the mark and
 * the word in the seats the sidebar paints them into, whichever brand is
 * chosen and whatever the reader has supplied. The seats write the same
 * preferences and the same host routes the rows they replace wrote, so a
 * reader's name and images carry over untouched: `brandName` for the typed
 * name, the image routes for the mark and the wordmark, `brandInk` for the ink
 * the brand's own art and the images take.
 *
 * The lockup is drawn here rather than moved from the sidebar: the sidebar's
 * identity is the host's own markup, painted by the theme's attribute
 * selectors, so this page draws a second copy from the same art and the same
 * stored values (theme/sidebar.css, shared/masked.css).
 */

/** Pause after the last keystroke before a typed name is written to the settings store. */
const NAME_SAVE_DEBOUNCE_MS = 600

/**
 * The art each brand draws when the reader supplied no picture, and the
 * proportions of the brand's own word. Each word is an asset whose box is the
 * drawing's own, so `wordRatio` is that box's width over its height and
 * `wordHeight` is how tall the box stands against the cap height: Claude's
 * wordmark is drawn at the cap height itself, while the host draws DeepSeek's
 * word in a 24-unit box beside an 18px whale (theme/sidebar.css).
 */
const BRAND_ART = {
  claude: {
    mark: 'var(--dsh-claude-image-claude-mark)',
    word: 'var(--dsh-claude-image-claude-word)',
    markRatio: 1,
    wordRatio: 512.22 / 121.54,
    wordHeight: 1,
  },
  deepseek: {
    mark: 'var(--dsh-claude-image-deepseek-mark)',
    word: 'var(--dsh-claude-image-deepseek-word)',
    markRatio: 23.16 / 17.04,
    wordRatio: 96 / 24,
    wordHeight: 24 / 18,
  },
}

/** The images in hand, following the shared state, read once the control mounts. */
function useBrandImages() {
  const [images, setImages] = React.useState(readBrandImages())
  React.useEffect(() => {
    const off = subscribeBrandImages(setImages)
    loadBrandImages()
    setImages(readBrandImages())
    return off
  }, [])
  return images
}

/**
 * One seat's own picture: the file it picked, the reply while a change
 * travels and the reason the last one was refused. The file is held to the
 * accepted formats and size here, so a refusal is said before the bytes
 * travel; the host half checks both again.
 */
function useBrandSeat(kind: BrandImageKind) {
  const images = useBrandImages()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const picker = React.useRef<HTMLInputElement>(null)
  const run = (pending: Promise<void>) => {
    setBusy(true)
    setError(null)
    // A refusal from the host half is said on the row; the stored image stays (D12).
    pending.then(() => setBusy(false), (reason: { message?: string }) => {
      setBusy(false)
      setError(copy('brandImageFailed', { detail: reason?.message ?? String(reason) }))
    })
  }
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    if (BRAND_IMAGE_TYPES[file.type] === undefined) {
      setError(copy('brandImageType'))
      return
    }
    if (file.size > BRAND_IMAGE_MAX_BYTES) {
      setError(copy('brandImageSize'))
      return
    }
    run(uploadBrandImage(kind, file))
  }
  return {
    image: images[kind],
    busy,
    error,
    picker,
    pick,
    open: () => picker.current?.click(),
    remove: () => run(removeBrandImage(kind)),
  }
}

type Seat = ReturnType<typeof useBrandSeat>

/** The hidden file input a seat opens. */
function SeatPicker(props: { seat: Seat }) {
  return React.createElement('input', {
    ref: props.seat.picker,
    type: 'file',
    accept: Object.keys(BRAND_IMAGE_TYPES).join(','),
    hidden: true,
    onChange: props.seat.pick,
  })
}

/** The icon a seat draws over itself while the pointer is on it. */
const ICONS = {
  upload: ['M8 10.6V3.4', 'M5.1 6.3 8 3.4l2.9 2.9', 'M3.3 10.4v1.4c0 .5.4.9.9.9h7.6c.5 0 .9-.4.9-.9v-1.4'],
  pencil: ['M11.1 2.9l2 2-7.4 7.4-2.6.6.6-2.6 7.4-7.4Z'],
}

/** The plate one icon button is: a circle of the panel's fill, a hairline and the icon in the accent. */
function Plate(props: { icon: keyof typeof ICONS, className?: string }) {
  return React.createElement(
    'span',
    { className: ['dsh-claude-brand-plate', props.className ?? ''].join(' ').trim(), 'aria-hidden': 'true' },
    React.createElement(
      'svg',
      { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ICONS[props.icon].map((d, at) => React.createElement('path', { key: at, d })),
    ),
  )
}

/** The button that offers the name seat a wordmark image, in the seats' own plate. */
function ImageButton(props: { seat: Seat }) {
  return React.createElement(
    'button',
    {
      type: 'button',
      className: 'dsh-claude-brand-plate dsh-claude-brand-image-button',
      disabled: props.seat.busy,
      'aria-label': copy('brandWordmarkPick'),
      onClick: props.seat.open,
    },
    React.createElement(
      'svg',
      { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      ICONS.upload.map((d, at) => React.createElement('path', { key: at, d })),
    ),
  )
}

/**
 * One seat's art: the reader's picture when there is one, the brand's own art
 * otherwise. A shape is a mask over the brand's ink, which is how the sidebar
 * paints every seat — DeepSeek's whale and word alike take the ink the
 * image-colour choice names (theme/sidebar.css), so a whale drawn as a picture
 * would show a colour the sidebar never puts there. The reader's picture in its
 * own colours is a picture too, and wears that ink once the choice names one.
 */
function SeatArt(props: { kind: 'mark' | 'word', image: BrandImage | null, claude: boolean, inked: boolean }) {
  const art = BRAND_ART[props.claude ? 'claude' : 'deepseek']
  const own = props.image
  const image = own === null ? (props.kind === 'mark' ? art.mark : art.word) : `url("${own.url}")`
  const ratio = own === null ? (props.kind === 'mark' ? art.markRatio : art.wordRatio) : own.ratio
  const height = own === null && props.kind === 'word' ? art.wordHeight : 1
  const shape = own === null || props.inked ? 'mask' : 'picture'
  return React.createElement('span', {
    className: `dsh-claude-brand-art dsh-claude-brand-art-${props.kind}`,
    'data-shape': shape,
    style: {
      '--dsh-claude-brand-art': image,
      '--dsh-claude-brand-ratio': String(ratio),
      '--dsh-claude-brand-height': String(height),
    } as React.CSSProperties,
  })
}

/** The name seat's field: the typed name in the word's own place, in the word's own face and size. */
function NameField(props: { value: string, onChange: (value: string) => void, onDone: () => void, onCancel: () => void }) {
  return React.createElement('input', {
    type: 'text',
    className: 'dsh-claude-brand-name',
    value: props.value,
    maxLength: BRAND_NAME_MAX,
    placeholder: copy('brandNamePlaceholder'),
    spellCheck: false,
    autoComplete: 'off',
    'aria-label': copy('brandNameTitle'),
    autoFocus: true,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value),
    onBlur: props.onDone,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        props.onDone()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        props.onCancel()
      }
    },
  })
}

/**
 * The lockup: the mark seat, the name seat and the image button on one plate.
 * A reader who supplied nothing sees the brand's own art, which is what the
 * sidebar shows them; a seat holding the reader's own picture offers its
 * removal in the corner the action plate leaves free.
 */
export function BrandLockup(props: { prefs: Prefs, write: SettingsView['write'], disabled?: boolean }) {
  const mark = useBrandSeat('mark')
  const word = useBrandSeat('wordmark')
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(props.prefs.brandName)
  const timer = React.useRef<number | null>(null)
  const claude = props.prefs.brand === BRAND_CLAUDE
  const inked = props.prefs.brandInk !== BRAND_INK_ORIGINAL
  const busy = mark.busy || word.busy

  React.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  const save = (value: string) => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (value !== props.prefs.brandName) props.write({ brandName: value })
  }
  const change = (value: string) => {
    setDraft(value)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => save(value.trim().slice(0, BRAND_NAME_MAX)), NAME_SAVE_DEBOUNCE_MS)
  }
  const done = () => {
    setEditing(false)
    save(draft.trim().slice(0, BRAND_NAME_MAX))
  }
  const cancel = () => {
    setEditing(false)
    setDraft(props.prefs.brandName)
  }

  // The word seat holds the reader's wordmark image first, then the name they
  // typed, then the brand's own word where an empty name would be — the
  // precedence the shell paints (features/brand/brand.ts).
  const mode = word.image !== null ? 'image' : props.prefs.brandName === '' ? 'brand' : 'name'
  const remove = (seat: Seat, className: string) => seat.image === null ? null : React.createElement(
    'button',
    {
      type: 'button',
      className: `dsh-claude-brand-clear ${className}`,
      disabled: busy,
      'aria-label': copy('brandImageRemove'),
      onClick: seat.remove,
    },
    React.createElement('span', { 'aria-hidden': 'true' }, '×'),
  )

  return React.createElement(
    'div',
    {
      className: 'dsh-claude-brand-lockup',
      'data-brand': claude ? 'claude' : 'deepseek',
      'data-disabled': props.disabled === true ? '' : undefined,
    },
    SeatPicker({ seat: mark }),
    SeatPicker({ seat: word }),
    React.createElement(
      'div',
      { className: 'dsh-claude-brand-zone dsh-claude-brand-zone-mark' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-claude-brand-seat',
          disabled: busy,
          'aria-label': mark.image === null ? copy('brandMarkUpload') : copy('brandMarkReplace'),
          onClick: mark.open,
        },
        SeatArt({ kind: 'mark', image: mark.image, claude, inked }),
        Plate({ icon: 'upload', className: 'dsh-claude-brand-seat-plate' }),
      ),
      remove(mark, 'dsh-claude-brand-clear-mark'),
    ),
    React.createElement(
      'div',
      { className: 'dsh-claude-brand-zone dsh-claude-brand-zone-word' },
      editing
        ? NameField({ value: draft, onChange: change, onDone: done, onCancel: cancel })
        : React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-claude-brand-seat',
            disabled: busy,
            'aria-label': mode === 'image' ? copy('brandWordmarkReplace') : copy('brandNameEdit'),
            onClick: mode === 'image' ? word.open : () => { setDraft(props.prefs.brandName); setEditing(true) },
          },
          mode === 'name'
            ? React.createElement('span', { className: 'dsh-claude-brand-typed' }, props.prefs.brandName)
            : SeatArt({ kind: 'word', image: word.image, claude, inked }),
          Plate({ icon: mode === 'image' ? 'upload' : 'pencil', className: 'dsh-claude-brand-seat-plate' }),
        ),
      editing ? null : ImageButton({ seat: word }),
      remove(word, 'dsh-claude-brand-clear-word'),
    ),
    mark.error === null && word.error === null
      ? null
      : React.createElement('div', { className: 'dsh-claude-brand-error', role: 'alert' }, mark.error ?? word.error),
  )
}
