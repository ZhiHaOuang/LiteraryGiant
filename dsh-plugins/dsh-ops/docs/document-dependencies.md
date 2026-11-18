# Document parser dependency review

The 15b/16 DOCX worker uses format libraries only after byte/count preflight. It adds no
host dependencies, process execution, external fetches, archive extraction, OCR, or Office
integration. `zip = "=9.0.1"` disables defaults and enables only
`deflate-flate2-zlib-rs`; `quick-xml = "=0.42.0"` disables defaults. These libraries provide
CRC-checked ZIP decompression and namespace-aware XML parsing without implementing those
formats again. Every resolved addition is locked; verification date: 2026-10-19 UTC+08.

| Locked package | Published UTC | Purpose | License |
| --- | --- | --- | --- |
| zip 9.0.1 | 2026-10-10 06:10:55 | Bounded ZIP entry access | MIT |
| quick-xml 0.42.0 | 2026-08-22 19:22:01 | XML events and namespaces | MIT |
| crc32fast 1.5.2 | 2026-09-12 18:41:46 | ZIP CRC validation | MIT OR Apache-2.0 |
| flate2 1.1.10 | 2026-08-28 04:35:22 | Deflate decoding | MIT OR Apache-2.0 |
| zlib-rs 0.6.8 | 2026-09-15 13:10:00 | Rust deflate implementation | Zlib |
| indexmap 2.14.2 | 2026-09-05 01:53:48 | ZIP metadata index | Apache-2.0 OR MIT |
| hashbrown 0.17.1 | 2026-05-09 04:35:04 | Index storage | MIT OR Apache-2.0 |
| equivalent 1.0.2 | 2025-02-14 22:14:18 | Index key comparison | Apache-2.0 OR MIT |
| typed-path 0.12.3 | 2026-02-11 02:30:37 | ZIP path representation | MIT OR Apache-2.0 |
| nix 0.31.3 | 2026-05-11 07:01:18 | ZIP macOS/BSD target dependency | MIT |
| cfg_aliases 0.2.2 | 2026-07-16 14:57:16 | nix build configuration | MIT |

Publication dates and non-yanked status were checked against the publisher's
[crates.io version API](https://crates.io/api/v1/crates/zip/9.0.1) for each exact version;
replace the final name/version in that URL to reproduce another row. All are at least seven
days old. Cargo first selected equivalent 1.0.3 (2026-10-13); the lockfile deliberately uses
1.0.2 because 1.0.3 had not reached seven days. Do not update that lock entry casually.
Original license texts are in `licenses/documents/THIRD-PARTY-NOTICES.txt`; MIT is selected
where an alternative license is offered. Existing dependencies are unchanged.

The checked upstream security fixes include quick-xml namespace allocation/attribute parsing
fixes present since 0.41 and ZIP extraction fixes present since 9.0.0. See the primary
[RustSec XML allocation advisory](https://rustsec.org/advisories/RUSTSEC-2026-0195.html),
[XML attribute advisory](https://rustsec.org/advisories/RUSTSEC-2026-0194.html), and
[ZIP advisory](https://rustsec.org/advisories/RUSTSEC-2026-0367.html). This is a targeted
source/version review, not a claim that a full dependency audit has found no vulnerabilities.
This reader never calls archive extraction APIs.

The worker rejects ZIP64/multi-disk/encrypted archives; validates exact central-directory
bounds/counts, unique names, local-header agreement and nonoverlapping payloads before
the ZIP constructor; alternate EOCD/ZIP64 footer signatures are refused anywhere in the archive
(including coincidental payload bytes) because constructor recovery could reinterpret them.
The archive offset is fixed at zero. The reader then reads only fixed OPC metadata and word/document.xml into capped
buffers. Deflate output is stopped at the actual decoded limit plus one byte, independent
of advertised sizes; complete reads verify CRC. XML disables DTD/custom entities, checks
UTF-8 or BOM-marked UTF-16 without replacement, and bounds depth, attributes and namespace
bindings. Unsupported content yields explicit errors or partial observations.

PDF parsing has a separate follow-up review. This slice neither adds a PDF dependency nor
claims PDF support; the table/DOCX readers are not substitutes for the PDF benchmark.

## PDF foundation review (15c/16, 2026-10-19)

The original bounded container grammar adds a direct exact dependency on flate2 1.1.10
with defaults disabled and zlib-rs selected. Both versions were already locked, licensed
and reviewed above; this adds no resolved package or version. The low-level decoder
checks actual decoded bytes, the zlib checksum/terminator and trailing input.

A general parser was evaluated and declined for this narrow slice. lopdf 0.42 predates
the configurable stream limits added in 0.44; newer releases also bring a mandatory
crypto dependency tree despite disabled default features. The reviewed crypto buffer
conversion required the [upstream inout correction](https://github.com/RustCrypto/utils/pull/1556),
whose follow-up 0.2.4 release was younger than seven days at review. No affected older
version or vendored patch was selected to evade the age rule. None of the evaluated
lopdf/crypto packages remains in this lockfile. See the publisher's
[lopdf changelog](https://github.com/J-F-Liu/lopdf/blob/main/CHANGELOG.md) and
[inout 0.2.4 release metadata](https://crates.io/api/v1/crates/inout/0.2.4).
This is a targeted source review, not a general PDF compliance or security-audit claim.
