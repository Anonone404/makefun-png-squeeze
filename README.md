# png-squeeze — make.fun entry

One program, `main.ts`, run on Node 22 with no installs. It reads eight
1280x720 RGBA screenshots from `/input/<id>/image.png` and writes each
back losslessly as the smallest PNG it can to `/output/<id>/image.png`,
inside one 60-second wall budget for the whole set.

## How it works

1. **Decode** each input PNG (all colour types, all filters, PLTE/tRNS).
2. **Reduce the colour form**: palette (type 3) when the image holds at
   most 256 unique colours, grey (type 0) when R=G=B on every pixel,
   RGB (type 2) when every pixel is opaque, RGBA (type 6) otherwise.
   A single fully transparent colour becomes a tRNS key so the exact
   pixel value survives the round trip.
3. **Screen filters**: for every form, try the five fixed filters and
   four adaptive strategies (minimum absolute sum, adjacent-pair
   entropy, per-row entropy, and a per-row brute-force search scored
   with zlib level 4), and keep the smallest result under zlib level 6.
4. **Compress** the filtered bytes with a zopfli-style optimal-parse
   deflate written here from scratch: a hash-chain LZ77 match finder
   (longest match, best match within 1024 bytes, best match within 64
   bytes), a shortest-path parse iterated against the Huffman costs of
   the previous pass, length-limited Huffman trees, and a dynamic
   Huffman block writer. The output is compared against zlib level 6
   and level 9 on the same bytes and the smallest stream wins.
5. **Assemble** a minimal PNG (IHDR, PLTE, tRNS, one IDAT zlib stream,
   IEND) with correct CRCs. The whole run is deterministic: fixed
   work counts, no clock, no randomness.

## Files

- `main.ts` — the entire entry (plain JavaScript in a `.ts` file, Node
  stdlib only: `node:fs`, `node:path`, `node:zlib`).
- `LICENSE` — MIT.
- `README.md` — this file.

## Local test

From the kit directory, with the practice set:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/png-out node main.ts
```

Practice score (kit scorer): **707,770** (house fixed-Paeth baseline:
420,399). All 8 instances answered and exact. Runtime about 27 s for
the set on this machine, inside the 60 s wall.
