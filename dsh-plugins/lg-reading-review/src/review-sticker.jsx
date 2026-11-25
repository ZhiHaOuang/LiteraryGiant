import React from 'react'

// The supplied sticker drawings contain only shapes. Their labels and numbers
// stay outside the manuscript text used for copying and annotation offsets.
const stickers = [
  ['bubbles', 7, <>
    <g stroke="white" strokeWidth="7" strokeLinejoin="round">
      <path d="M6 7Q6 2 12 3L37 5Q44 5 43 12L41 32Q41 38 34 37L22 36 11 44 13 34Q3 34 4 27Z" fill="#ffd334"/>
      <path d="M28 25 51 27Q58 28 57 35L56 51Q55 57 48 56L44 56 43 63 34 55 28 54Q22 54 23 48L24 32Q24 25 28 25Z" fill="#289cf3"/>
    </g>
    <path d="m13 15 21 2m-22 7 14 1" stroke="#b08616" strokeWidth="3.5" strokeLinecap="round"/>
    <circle cx="34" cy="39" r="3.8" fill="white"/><path d="m46 36 5 8-10-1Z" fill="white"/>
  </>],
  ['ruler', -13, <g transform="rotate(-30 32 32)">
    <rect x="6" y="20" width="52" height="24" rx="6" fill="#ffcf3d" stroke="white" strokeWidth="7.5" paintOrder="stroke fill"/>
    <path d="M16 21v10m8-10v6m8-6v10m8-10v6m8-6v10" fill="none" stroke="#c18112" strokeWidth="2.5" strokeLinecap="round"/>
  </g>],
  ['stars', -8, <g stroke="white" strokeLinejoin="round">
    <path d="M14 17C4 9-1 25 7 33L23 47 37 31C45 22 32 11 25 20L21 24Z" fill="#f38bb3" strokeWidth="5"/>
    <path d="M32 7 36 17 47 19 38 26 40 37 30 31 21 37 23 26 15 18 26 17Z" fill="#ffd95a" strokeWidth="4"/>
    <path d="m41 34 4 8 9 1-7 6 2 10-8-5-8 4 2-9-7-6 10-1Z" fill="#73c9ee" strokeWidth="4"/>
  </g>],
  ['curve', -8, <>
    <rect x="6" y="2" width="50" height="59" rx="10" fill="#f0e6fb" stroke="white" strokeWidth="7"/>
    <path d="M15 13v37m13-38v38m13-38v38M13 23h36M13 37h36M13 50h36" stroke="#ded2e9" strokeWidth="1.2"/>
    <path d="M14 51C14 26 29 10 49 10" fill="none" stroke="#8d2ae8" strokeWidth="4"/>
    <path d="M14 51V18M49 10H29" fill="none" stroke="#b673ef" strokeWidth="1.5"/>
    <g fill="#62d4ef" stroke="white" strokeWidth="2"><circle cx="14" cy="18" r="3.7"/><circle cx="29" cy="10" r="3.7"/></g>
    <g fill="white" stroke="#8d2ae8" strokeWidth="3"><rect x="10" y="47" width="7" height="7" rx="1.5"/><rect x="46" y="6" width="7" height="7" rx="1.5"/></g>
  </>],
  ['drops', 8, <g stroke="white">
    <path d="M31 6C21 13 13 24 16 35S26 52 37 52 55 42 53 32 40 13 31 6Z" fill="#ffdc77" strokeWidth="6"/>
    <path d="M20 9C8 17 1 30 8 42S28 53 31 41 26 18 20 9Z" fill="#f393b0" fillOpacity=".8" strokeWidth="5"/>
    <path d="M41 21C30 28 26 43 34 53S53 56 57 45 48 26 41 21Z" fill="#a9cffa" fillOpacity=".8" strokeWidth="5"/>
  </g>],
  ['check', -9, <>
    <rect x="10" y="12" width="43" height="42" rx="10" fill="#ab75ed" stroke="white" strokeWidth="7"/>
    <path d="m21 33 8 8 14-17" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
  </>],
]

export function NoteSticker({number,action,onClick,disabled}) {
  const [shape,angle,art] = stickers[(number - 1) % stickers.length]
  const label = action + ' note ' + number
  return <button type="button" className="lgrv-sticker" data-sticker={shape} data-note-number={number}
    aria-label={label} title={label} disabled={disabled}
    onClick={event=>{event.stopPropagation();onClick()}}>
    <svg aria-hidden="true" focusable="false" viewBox="-4 -4 72 72" style={{transform:'rotate('+angle+'deg)'}}>{art}</svg>
  </button>
}
