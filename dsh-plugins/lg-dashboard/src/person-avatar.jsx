import React,{memo} from 'react'

// Paths share a 24-pixel grid. Each swatch includes a shadow, midtone and highlight.
const hairColors=[
 ['#473630','#714e3c','#9a7557'],['#332e35','#514553','#786472'],
 ['#4b4140','#80665b','#aa8c76'],['#575052','#918b87','#c7c2b8'],
 ['#523628','#925e3f','#bc8553'],['#49402f','#7e7157','#aa9975'],
]
const clothColors=[
 ['#544a5e','#846f88','#b9a1ad'],['#364953','#607986','#9eafb2'],
 ['#55483a','#917054','#c8a787'],['#414e46','#738477','#b0ba9c'],
 ['#544341','#96675a','#c0957b'],['#463e4e','#736780','#ad9bb0'],
]
const heads=[
 'M6 6h12v7h-1v2h-2v2H9v-1H7v-3H6z',
 'M7 5h10v2h1v5h-1v3h-2v2H9v-2H7v-3H6V8h1z',
 'M6 7h12v6h-1v3h-3v1h-4v-1H7v-3H6z',
]
const haircuts=[
 // Short part, swept fringe, curls, bob, long fringe and high bun.
 ['M6 5h2V3h7v1h3v2h1v5h-2V7h-4V6h-2v2H8v3H6z','M8 5h3V4h4v1h-3v1H8z'],
 ['M5 7h1V5h2V3h8v1h2v2h1v5h-2V7h-4v1h-3v2H7v2H5z','M7 6h2V5h5v1h-4v1H7z'],
 ['M5 6h1V4h2V3h3V2h3v1h3v2h2v2h1v3h-2v2h-2V8h-2V7h-2v2h-2V8H8v3H6V9H5z','M7 5h2V4h2v2H9v1H7z M12 4h2v1h2v1h-3V5h-1z'],
 ['M5 7h1V5h2V3h8v1h2v2h1v10h-3V8h-3V7H8v7H7v2H5z','M8 5h7v1H9v2H7V6h1z'],
 ['M5 7h1V5h1V4h2V3h7v1h2v2h1v12h-3V8h-2V6h-2v2h-2v2H8v7H5z','M7 7V6h1V5h4v1H9v2H7z'],
 ['M4 4h1V2h4v1h2v1h5v1h2v2h1v5h-2V8h-3V7H8v4H6V8H5V6H4z','M5 4h3V3h1v2H6v1H5z M9 6h5v1H9z'],
]
const trims=[
 'M5 21h3v-1h2v1H8v2H5z','M15 18h2v2h2v2h-2v-1h-2z',
 'M6 21h12v1H6z','M9 18h2v2h2v-2h2v2h-1v1h-4v-1H9z',
]
function seedOf(id){
 let n=2166136261
 for(const ch of id)n=Math.imul(n^ch.codePointAt(0),16777619)
 return n>>>0
}
export const PersonAvatar=memo(function PersonAvatar({id,description=''}){
 let seed=seedOf(id)
 function pick(length){const index=seed%length;seed=Math.floor(seed/length);return index}
 const head=heads[pick(heads.length)],randomCut=pick(haircuts.length),randomColor=pick(hairColors.length)
 const hair=hairColors[/(浅灰色?|灰白色?|银色?|白色?)(?:卷|短|长|头)?发/u.test(description)?3:
  /黑色?(?:卷|短|长|头)?发/u.test(description)?1:randomColor]
 const [cut,glint]=haircuts[/卷发/u.test(description)?2:/长发/u.test(description)?4:/短发/u.test(description)?0:randomCut]
 const tint=pick(clothColors.length)
 const cloth=/穿白袍|身着白袍/u.test(description)?['#6b6562','#bbb5a9','#e5dfd2']:clothColors[tint]
 const trim=trims[pick(trims.length)]
 const brooch=/(?:王国.{0,2}王子|首席骑士)/u.test(description)
 return <svg className="lgd-person-avatar" viewBox="0 0 24 24" aria-hidden="true" shapeRendering="crispEdges">
  <path fill={cloth[0]} d="M2 24v-3h2v-2h3v-1h3v-3h4v3h3v1h3v2h2v3z"/>
  <path fill={cloth[1]} d="M4 24v-3h3v-2h3v1h4v-1h3v2h3v3z"/>
  <path fill={cloth[2]} d={trim}/>
  {brooch&&<path fill="#be9a60" d="M6 19h3v1H6z M15 19h3v1h-3z M14 21h2v2h-2z"/>}
  <path fill="#b58e79" d="M10 14h4v4h-1v1h-2v-1h-1z"/>
  <path fill="#d5ad91" d={head}/>
  <path fill="#e7c6a9" d="M8 7h8v5h-1v2h-2v1h-3v-1H8z"/>
  <path fill={hair[0]} d={cut} transform="translate(0 1)"/>
  <path fill={hair[1]} d={cut}/><path fill={hair[2]} d={glint}/>
 </svg>
})
