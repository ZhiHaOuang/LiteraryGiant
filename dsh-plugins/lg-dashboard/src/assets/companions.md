# Dashboard companions — 2026-11-12

Decorative pairs only; these characters do not represent executable Agents.

| Source | Asset | Display name |
| --- | --- | --- |
| Author's 1.png | lord-transparent.png | 主公 |
| Author's 4.png | frog-transparent.png | 青蛙 |
| Author's 2.png | romeo-transparent.png | 罗密欧 |
| Author's 3.png | juliet-transparent.png | 朱丽叶 |

Processed using the built-in image_gen tool, one edit per source, with
transparent_background=true. Original source files were preserved. All four
outputs have an RGBA alpha channel with transparent corners. Generative
extraction can produce minor differences in texture and edges.

Final prompt (identical for all four inputs):

> Use case: background-extraction. Edit target: the supplied single plush mascot image. Remove only the white background and ground shadow to genuine alpha transparency. Preserve exactly its identity, silhouette, fluffy texture, facial features, accessories, original colors and pose. Center the entire character on a square transparent canvas with about 8% padding, with no cropping, no new elements, no text. This is an app avatar cutout, not a redesign.

Bubble entrance uses the native Claude style Message bubble animation flight
preview's 17-frame trajectory; exit plays it in reverse. Its timing token is
reused, with a local fallback. Source attribution is in companion-motion.css and
LICENSE-dsh-claude-style.

The left two-character group (主公 and 青蛙) converses with the right group
(罗密欧 and 朱丽叶), using one shared controller and at most two bubbles.
All four characters share one transparent rounded frame; the two internal groups
have no border or fill. A random group says the first line in pale theme orange,
and the other replies after 0.8–2.2 seconds in pale sage green. Both stay another
6–10 seconds before exiting. The existing flight/reverse animations remain.

Adjacent speaker "1" / "2" entries in ../companion-lines.json mean first line
and reply, not individual characters. All 14 complete author-supplied dialogues
are retained; the empty pair remains an editable placeholder. A group's bubble
tail points to one member of that group, alternating representatives each round.
Hidden reply text reserves its height before appearing. Offscreen, hidden-window
and reduced-motion pause the entire shared conversation. No model is called.


2026-11-12: two groups of three now read 公主 / 青蛙 / 和摸伐 and 罗密欧 / 与 / 朱丽叶.
The former 主公 avatar is renamed 和摸伐. New princess-transparent.png and
yu-transparent.png were edited with the built-in imagegen tool from the author's
Downloads/公主.png and Downloads/与.png. Prompt: remove only the white background
and floor shadow to true transparent alpha; preserve shape, accessories, colors,
texture and proportions; center full silhouette at 88% of square canvas height.
All are displayed in the same 34px contain box. Bubble tails use measured avatar
centers, clamped bubble boxes, and live resize observation rather than fixed offsets.
Original input files were not changed. See ../companion-lines-guide.txt for 1/2/3 scenes.
