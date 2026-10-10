# Performance checks

Measured on the development Mac on October 10, 2026, using Bun 1.3.14. The baseline is commit `8a324f5`, before the streaming/client-reuse changes. These measurements use synthetic input and a local fake API; they do not measure live Jev inference or actual OCR/model speed.

| Workload | Before | After |
|---|---:|---:|
| Batch dry run: 50,000 JSON lines, 48.9 MiB input, peak RSS | 320.4 MiB | 112.8 MiB |
| Same batch, elapsed time | 0.170 s | 0.202 s |
| Sort 24 fixture PDFs, 40 ms local API delay per request | 2.403 s | 0.683 s |
| Same sort, shared client with concurrency 1 | 2.403 s | 1.332 s |
| Single-question dry run, source vs standalone executable | 23.68 ms | 21.48 ms |

Batch and sorting numbers are medians of three runs. Startup numbers are medians of 30 runs after three warmups, including process launch/exit with stdout discarded. Standalone results use `bun run build`, without bytecode compilation.

The streaming batch uses about 65% less peak memory in this fixture, at a small cost in pure local dry-run throughput. Its input and pending results no longer grow with total input size: it keeps a bounded concurrency window plus the current input chunk and unfinished line. Runtime allocation and garbage collection still contribute to peak RSS. A single exceptionally large line still needs to fit in memory.

Sorting is about 3.5 times faster in the controlled fixture. The new default prepares two PDFs at once and shares the API client; moves, destination reservations, and output remain ordered. Real improvement depends on network latency, OCR cost, and on-device model behavior. The fixture used fake `pdftotext` output, an HTTP server on localhost, an environment-provided fake key, and no file moves.

## Reproduction outline

- Build with `bun run build`; compare `bun src/cli.ts ask 'Relevant?' --state 'Example input' --dry-run` with `./dist/jev ask 'Relevant?' --state 'Example input' --dry-run`.
- Generate 50,000 JSONL records containing `{id, body}`, with `body` equal to 1,000 ASCII characters. Run a single-question preset through `batch --dry-run`, redirect stdout to `/dev/null`, and measure peak RSS with macOS `/usr/bin/time -l`.
- Compare an isolated copy of the baseline source (sharing the installed dependencies) with the working source, using identical inputs.
- For sorting, use 24 fixture filenames, two category directories, deterministic text extraction, and a localhost API returning valid SDK responses after 40 ms. Compare baseline, `--concurrency 1`, and the default concurrency of 2.

## Behavioral checks

Automated tests cover output before stdin closes, UTF-8 split across input chunks, physical line numbering, bounded read-ahead behind a slow first result, output backpressure, input failures, out-of-order PDF completion, deterministic collision suffixes, per-file failures, and one credential lookup across parallel API calls.

The compiled `jev-sort` was also run from a temporary directory with no Bun or `jev` on PATH. All 24 rename plans passed using fake external tools and the local API, verifying that the embedded naming schema is materialized for the external `fm` process and that name checks use the shared client.
