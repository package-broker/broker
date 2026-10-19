# Fixture corpus provenance

These fixtures are synthetic test data under the repository's AGPL-3.0-only license.
No fixture is downloaded, and no archive is extracted by the fixture service.
`seed.json` defines the two minimal package manifests and the escape marker.
`checksums.json` pins SHA-256 for the seed, every generated response, and every
reused input. Tests rebuild the corpus twice and verify these checksums.

The archive recipe is `../src/fixtures/archives.ts`. ZIP entries are sorted by
name, have a 1980-01-01 midnight DOS timestamp, and use stored entries except for
the bomb, which uses raw DEFLATE at level 9. Tar entries are sorted, use mtime,
uid and gid zero, have mode 0644 (symlinks 0777), and have no owner names. Tar
streams end with two zero blocks and use gzip level 9, mtime zero, OS byte 3.
Checksums pin the output of the Node 24 zlib implementation used by this project.
A zlib upgrade that changes compressed bytes requires review of the checksum file.

| Response name                  | Exact content / provenance                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib.zip`                      | `lib/composer.json`: compact `seed.composer` JSON plus LF.                                                                                                     |
| `lib.tgz`                      | `package/package.json`: compact `seed.npm` JSON plus LF.                                                                                                       |
| `zip-bomb.zip`                 | One DEFLATE entry `bomb.txt`, 8,388,608 ASCII `A` bytes; expansion ratio exceeds 1000. Bounded to 8 MiB.                                                       |
| `tar-traversal.tgz`            | One regular entry `../escape.txt` with `seed.escapePayload`.                                                                                                   |
| `symlink-escape.tgz`           | Symlink `package/escape` targets `../../outside`; the next entry `package/escape/payload.txt` contains `seed.escapePayload`.                                   |
| `oversized-manifest.json`      | Compact JSON with name `fx/oversized` and a padding string of 1,048,576 ASCII `x` bytes, followed by LF.                                                       |
| `oversized-manifest.zip`       | The same oversized JSON at `lib/composer.json`.                                                                                                                |
| `delta.pack`                   | The existing core `src/sources/git/__fixtures__/ofs-delta.pack`, read directly.                                                                                |
| `delta-upload-pack.bin`        | Git v2 `packfile` section, one channel-1 sideband packet containing that delta pack, then flush.                                                               |
| `digest-mismatch.zip`          | Literal ASCII `fixture: deliberately not the advertised archive` followed by LF; advertised digest is the digest of `lib.zip`. Deliberately invalid ZIP bytes. |
| `git-upload-pack.bin`          | Decoded response body of the existing `local-git-http-backend-no-filter.json` recording.                                                                       |
| `git-filtered-upload-pack.bin` | Decoded response body of the existing `local-git-http-backend.json` recording (empty).                                                                         |

All paths above beginning with `src/sources/git/` are relative to `packages/core`.
The original Git recording provenance is in
`../../core/src/sources/git/fixtures/README.md`; these recordings are reused,
not copied. Every `*.body` beneath `../../core/test-fixtures/composer-v1/` is
also read directly and served byte for byte under `/composer-v1/`. Their original
absolute URLs and intentionally hostile metadata are preserved in this replay
namespace. The live `/packages.json` graph derives package versions from the
existing `f07-providers-includes-one` corpus, rebases dist URLs to the current
loopback origin, builds matching archives and recomputes provider hashes. Those
origin-dependent JSON documents are verified through their advertised hashes,
rather than pinned to an ephemeral port in this file.
