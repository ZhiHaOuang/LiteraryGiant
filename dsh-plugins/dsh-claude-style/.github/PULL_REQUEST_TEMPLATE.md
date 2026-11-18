<!-- Describe the symptom, the cause, and — when the page's look changes — attach a before-and-after screenshot. CI runs the whole matrix on this pull request; a draft gets the same run while the code is still being written. -->

## What changes

## Checks

- [ ] The change is described in a file under `docs/changes/`, or it changes nothing a reader can see.
- [ ] The two READMEs are either both untouched, or both changed in this pull request only to re-shoot a stale screenshot or to correct the install instructions; an explanation of a feature lives in `docs/changes/`.
- [ ] `npm run build` passes, and `lib/` is left out of this pull request.
- [ ] A visible change was checked in light and dark, and both screenshots are attached above.
