# AGENTS.md — makefun-png-squeeze

## Overview

Entry for make.fun competition `png-squeeze-01-run-20261127`
("Squeeze screenshots into the smallest PNG, 27 November 2026", $100,
Code). One program, `main.ts` at the repo root, runs on Node 22 with
no installs: it reads 8 screenshots of 1280x720 RGBA from
`/input/<id>/image.png` and writes each back losslessly as the smallest
PNG it can to `/output/<id>/image.png`, inside one 60-second wall budget
for the whole set. Pure Node stdlib (zlib only to inflate inputs);
the PNG decoder, filter choice, palette/grey reduction and the
optimal-parsing deflate compressor are all written here, in this repo.

## Commands

- Run on the practice set (from the kit dir):
  `MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/png-out node main.ts`
- Score locally (from the kit dir):
  `node cli/makefun.mjs grade-local --kit . --bot <repo> --driver docker`
  (grade-local checks the kit, runs the entry twice on practice/input,
  scores with the kit scorer; `--driver process` runs without docker)
- Check repo size: `du -sb .` — the whole repo must stay under
  1,048,576 bytes.

## Conventions

- `main.ts` is plain JavaScript (erasable syntax only) so Node 22 runs
  it as-is; no TypeScript-only syntax, no imports beyond `node:fs`,
  `node:path`, `node:zlib`.
- The output must be deterministic: same input bytes produce the same
  output bytes on every run. No clock, no randomness, no environment
  reads as a source of variation. Work budgets are fixed counts, never
  time-based cutoffs.
- Output PNG rules (the checker's decoder): bit depth 8, not
  interlaced, colour types 0/2/3/4/6 only, chunks IHDR, PLTE (type 3
  only), tRNS, IDAT, IEND only, correct CRCs, one zlib stream in IDAT.
  A fully transparent pixel's colour must decode exactly as the input.
- Colour handling: palette (type 3) when the image holds at most 256
  unique RGBA colours, grey (type 0) when R=G=B on every pixel, RGB
  (type 2) when every pixel is opaque, RGBA (type 6) otherwise; tRNS
  carries palette alpha when any palette entry is not opaque.

## Boundaries

- **NEVER** read code from an environment secret, the network, git
  history, or any file the repo does not ship. Everything the entry
  runs lives in this repo. The tiny-stack-vm sibling entry was REJECTED
  for eval'ing a program from an env secret; this entry must never do
  that.
- **NEVER** touch Sep's wallets or keys. No keypair, no API key, no
  credentials in this folder. Repo creation, upload, bundling and
  submission are the parent agent's job, not this project's.
- **NEVER** build or submit from `~/workspace/scripts/makefun-watch/`.
- Do not add dependencies, do not fetch anything at runtime, do not
  write outside `/output` (and `/tmp` for local testing only).

## Dependencies

- None. Node 22 stdlib only. No `package.json`, no install step.

## Config

- `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` (local testing only;
  the grader mounts `/input` and `/output`). Defaults `/input`,
  `/output`. No other configuration; no secrets of any kind.

## Error Handling

- A bad input PNG (undecodable, wrong size) throws with the instance
  id in the message; the run fails loudly rather than writing a wrong
  file. Every instance must be answered or the entry ranks below all
  passing entries and takes no reward.
- Output files are written only after the whole image is encoded in
  memory, so a failure never leaves a partial `image.png` behind.

## Troubleshooting

- `grade-local` failing on kit checks: the kit dir must be the fresh
  download for this competition; do not mix files from other kits.
- Score 0 on an instance: check the checker rules first (chunk set,
  colour type, bit depth, exact pixels) — the scorer's `checks.json`
  names the reason.
- Slow runs: the 60 s wall covers all 8 instances on 1 CPU. Keep the
  per-image work fixed; never add a time-based cutoff (it breaks the
  two-runs-must-match determinism rule).
