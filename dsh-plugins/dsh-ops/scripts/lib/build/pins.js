/**
 * The upstream pins, and the measurements this pipeline adds to them.
 *
 * PIN VALUES FOR A SHELL LIVE WITH ITS NAME, in `lib/shells.js`: the upstream
 * repository, release tag, version, asset file, URL, digest, byte count,
 * licence, extractor, and executable digest all come from that module's
 * `SHELL_UPSTREAM_PINS` (`shellUpstreamPin()` is the lookup), so a version, a
 * URL, or a digest is edited in one place and the pipeline holds no copy.
 * What is left here is measurement plus the one defensive reader that fails
 * loudly when the module exports a pin this pipeline cannot read.
 *
 * @module dsh-ops/build/lib/pins
 */

import * as shellsModule from '../../../lib/shells.js'

/**
 * The per-shell annotations this pipeline measured, which no pin table carries:
 * the copyright line, the executable's size, the launcher's PATH behaviour, and
 * the unpacked footprint of the upstream asset.
 *
 * PIN VALUES ARE NOT HERE. The upstream repository, release tag, version, asset
 * file, URL, digest, byte count, licence, extractor, and executable digest all
 * come from `lib/shells.js`'s `SHELL_UPSTREAM_PINS` (`shellUpstreamPin()` is the
 * lookup), so a version, a URL, or a digest is edited in one place and this file
 * holds no copy of any of them. What is left here is measurement:
 * `unpackedFiles`/`unpackedBytes` came from unpacking each asset and walking the
 * result twice — summing every file, then counting each inode once, which is
 * what `du --apparent-size` and npm's own `unpackedSize` report — `copyright` is
 * the upstream project's own line, and `entryNote` records what the executable
 * does and why the entry point is the file the plugin spawns.
 */
export const SHELL_PIN_ANNOTATIONS = Object.freeze({
  bash: {
    copyright: 'Copyright (C) Linus Torvalds and others (the Git project); packaged for Windows by the Git for Windows project.',
    unpackedLayout: 'The archive root is the package root: bin/, cmd/, dev/, etc/, tmp/, ucrt64/, usr/, git-bash.exe, git-cmd.exe, LICENSE.txt, README.portable.',
    entryBytes: 45_416,
    entryNote: 'bin/bash.exe is upstream\'s launcher for usr/bin/bash.exe; it prepends the tree\'s own usr/bin and ucrt64/bin to PATH inside the shell it starts, which is how git, sed, and cygpath resolve inside the package.',
    // Measured by unpacking the asset and walking the result twice: once
    // summing every file's size, once counting each inode a single time (which
    // is what `du --apparent-size` and npm's own `unpackedSize` report).
    unpackedFiles: 9_611,
    unpackedBytes: 351_211_022,
    unpackedBytesSumOfFileSizes: 411_137_776,
    unpackedNote: 'Upstream\'s tree contains 84 hardlinked paths (a path and its twin share one inode), so summing '
      + 'every file\'s size gives 411,137,776 bytes while the tree occupies 351,211,022 bytes once each inode is '
      + 'counted once. Nothing here was linked, copied, or removed by this pipeline: both figures describe the '
      + 'archive as upstream published it.',
  },
  pwsh: {
    copyright: 'Copyright (c) Microsoft Corporation.',
    unpackedLayout: 'The archive root unpacks under bin/: bin/pwsh.exe, its DLLs, Modules/, and bin/LICENSE.txt.',
    entryBytes: 301_368,
    entryNote: 'bin/pwsh.exe is the shell the plugin\'s bundle patch points the host\'s pwsh-sandbox row at.',
    // Measured by unpacking the archive and walking the result: this tree has
    // no hardlinked paths, so both figures agree.
    unpackedFiles: 658,
    unpackedBytes: 256_625_143,
    unpackedBytesSumOfFileSizes: 256_625_143,
    unpackedNote: 'No two paths in this archive share an inode, so the sum of every file\'s size and the size of the '
      + 'tree are the same number.',
  },
})

/**
 * Read one field from a pin record, accepting the spellings a table of pins
 * might reasonably use for it.
 * @param {object} record - the pin record.
 * @param {string[]} names - the candidate keys.
 * @param {string|undefined} [nested] - a nested object key to look inside first.
 * @returns {any} the first value found.
 */
export function field(record, names, nested) {
  const scopes = nested === undefined ? [record, record?.asset, record?.upstream, record?.payload] : [record?.[nested], record]
  for (const scope of scopes) {
    if (scope === null || typeof scope !== 'object') continue
    for (const name of names) {
      if (scope[name] !== undefined && scope[name] !== null) return scope[name]
    }
  }
  return undefined
}

/**
 * The pin record for one shell, from the module that owns the names.
 *
 * `lib/shells.js` is where a pin belongs: the package name and the payload the
 * package points at are one fact, and the code half owns both. This reads that
 * module defensively because its exact shape is the code half's to define —
 * accepting a `shellUpstreamPin({kind, platform, arch})`-style function or the
 * frozen `SHELL_UPSTREAM_PINS` list — and fails loudly when the module exports
 * a pin this pipeline cannot read. There is deliberately no fallback copy here:
 * a stale duplicate is exactly what one table per shell prevents, and `check`
 * prints the pin it used.
 *
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {string} platform - `process.platform`.
 * @param {string} arch - `process.arch`.
 * @returns {object} the normalized pin record.
 */
export function resolveShellPin(kind, platform, arch) {
  const key = `${platform}-${arch}`
  const candidates = [
    [shellsModule.shellUpstreamPin, 'function'],
    [shellsModule.shellPin, 'function'],
    [shellsModule.opsShellPin, 'function'],
    [shellsModule.SHELL_UPSTREAM_PINS, 'list'],
    [shellsModule.SHELL_PINS, 'table'],
    [shellsModule.OPS_SHELL_PINS, 'table'],
    [shellsModule.SHELL_PAYLOAD_PINS, 'table'],
    [shellsModule.PLATFORM_SHELL_PINS, 'table'],
  ]
  for (const [candidate, form] of candidates) {
    if (candidate === undefined || candidate === null) continue
    let record
    if (form === 'function' && typeof candidate === 'function') {
      // `shellUpstreamPin` reads one options object; the positional shape is
      // still tried because the code half owns that signature.
      record = candidate({ kind, platform, arch }) ?? candidate(kind, platform, arch)
    } else if (form === 'list' && Array.isArray(candidate)) {
      record = candidate.find((entry) => (entry?.name ?? entry?.kind) === kind
        && (entry.platform ?? platform) === platform && (entry.arch ?? arch) === arch)
    } else if (form === 'table' && typeof candidate === 'object') {
      record = candidate[kind]?.[key] ?? candidate[kind]?.[platform]?.[arch] ?? candidate[key]?.[kind] ?? candidate[kind]
      if (record !== undefined && record.kind === undefined && record.package !== undefined) record = { ...record, kind }
    }
    const normalized = record === undefined || record === null ? undefined : normalizePin(record, kind)
    if (normalized !== undefined) return { ...normalized, pinSource: 'lib/shells.js' }
  }
  // No fallback: a pin this pipeline cannot read is a release it cannot
  // describe, and a second copy of the pins here is the drift the table in
  // `lib/shells.js` exists to prevent.
  throw new Error('lib/shells.js exports no shell pin for ' + kind + ' on ' + key
    + ': the release cannot describe an upstream artifact it cannot name.')
}

/**
 * Normalize one pin record into the shape this pipeline uses.
 *
 * A record is usable when it names an upstream location, an asset, and that
 * asset's digest: without those three a pin package would be metadata nobody
 * can act on, so a record missing any of them is treated as absent.
 * @param {object} record - the record, in whatever shape the source used.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @returns {object|undefined} the normalized record, or undefined when unusable.
 */
export function normalizePin(record, kind) {
  const assetUrl = field(record, ['assetUrl', 'url', 'downloadUrl', 'download', 'href'])
  const assetSha256 = field(record, ['assetSha256', 'sha256', 'digest', 'checksum'])
  const assetName = field(record, ['assetName', 'assetFile', 'file', 'fileName', 'asset'])
  if (typeof assetUrl !== 'string' || typeof assetSha256 !== 'string' || typeof assetName !== 'string') return undefined
  const measured = SHELL_PIN_ANNOTATIONS[kind] ?? {}
  return {
    kind,
    package: kind,
    upstream: field(record, ['upstream', 'upstreamRepo', 'repository', 'repo', 'homepage']) ?? measured.upstream,
    upstreamVersion: field(record, ['upstreamVersion', 'version', 'tag']) ?? measured.upstreamVersion,
    releaseTag: field(record, ['releaseTag', 'release', 'tag']) ?? measured.releaseTag,
    assetName,
    assetUrl,
    assetSha256,
    assetBytes: field(record, ['assetBytes', 'bytes', 'size']) ?? measured.assetBytes,
    license: field(record, ['license', 'licence', 'spdx']) ?? measured.license,
    copyright: field(record, ['copyright', 'attribution']) ?? measured.copyright,
    extractor: field(record, ['extractor', 'extractWith']) ?? measured.extractor,
    unpackedLayout: field(record, ['unpackedLayout', 'layout', 'unpacked']) ?? measured.unpackedLayout,
    entryPoint: field(record, ['entryPoint', 'executableRelativePath', 'executable', 'entry']) ?? measured.entryPoint,
    entrySha256: field(record, ['entrySha256', 'payloadSha256', 'executableSha256']) ?? measured.entrySha256,
    entryBytes: field(record, ['entryBytes', 'payloadBytes', 'executableBytes']) ?? measured.entryBytes,
    entryNote: field(record, ['entryNote', 'note']) ?? measured.entryNote,
    unpackedFiles: field(record, ['unpackedFiles', 'files']) ?? measured.unpackedFiles,
    unpackedBytes: field(record, ['unpackedBytes', 'unpackedSize']) ?? measured.unpackedBytes,
    unpackedBytesSumOfFileSizes: field(record, ['unpackedBytesSumOfFileSizes', 'unpackedSum'])
      ?? measured.unpackedBytesSumOfFileSizes,
    unpackedNote: field(record, ['unpackedNote']) ?? measured.unpackedNote,
  }
}
