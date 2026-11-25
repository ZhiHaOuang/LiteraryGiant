# Reading review

Replaces the retired literary workbench. Provides chapter navigation, reading typography, version selection, passage and chapter notes, and author edits or candidates with preview and explicit confirmation. The interface is English; book titles and manuscript text remain unchanged.

The page title is always **Reading Review**. The toolbar shows the book, version, font, font size, line height and paragraph spacing as button groups. Table of Contents, the manuscript and the review sit side by side on wide screens. In narrower panes the directory can be expanded and the review moves below the manuscript when needed.

Passage notes appear as inline capsules. The same numbered sticker links a passage to its review card in either direction. A chapter note has its sticker beside the chapter heading. When opening another chapter or version, the current manuscript and notes stay visible until their replacements are ready.

`literaryReading.openVersion(path, document, version)` opens the requested version using the native DSH page workspace. `/api/lg/reading-notes` and the `lg_reading_notes` table remain unchanged, preserving saved notes. Drafts lock the current page until saved or discarded.

Manuscript operations remain owned by lg-books. Existing planning/workflow selectors and acceptance review helpers moved to lg-review; those features remain accessible from More. The old editor, document/file management UI and reader-comparison experiments are retired. Their underlying book data and backend capabilities are retained.

Build: `node scripts/build.mjs lg-reading-review` from dsh-plugins. Tests: `node --test lg-reading-review/tests/*.test.mjs`. Desktop tests require an isolated LitIsLand home and synthetic books; they never call a model.
