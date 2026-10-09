# Helper scripts

Ready-made workflows built on `jev`. Each one runs as a dry run and prints its plan unless you pass `--apply`.

| Script | What it does |
|---|---|
| [`jev-sort`](jev-sort.ts) | Files scanned PDFs from an inbox folder into category folders. It can also rename, tag, comment, and make PDFs searchable. |

`bun link` in the repo root installs these alongside `jev`.

---

## jev-sort

You scan paper into one inbox folder. `jev-sort` reads each PDF, asks jev which of your folders it belongs in, and moves it there. Files jev isn't sure about go to a review folder for you to handle.

```bash
jev-sort ~/Scans/Inbox --into ~/Documents/Filed                               # print the plan
jev-sort ~/Scans/Inbox --into ~/Documents/Filed --apply                       # move the files
jev-sort ~/Scans/Inbox --into ~/Documents/Filed --by-year --rename --tag --apply
```

```
  file    scan_0412.pdf
          → Medical/2026/2026-03-05 Quest Diagnostics Lab Results.pdf (0.88)  [date verified]
  review  scan_0413.pdf
          → _Review/Cable Tester Manual.pdf  confidence 0.40; odds: Personal 0.55, Business 0.24, Taxes 0.21
```

### How it decides

**Categories:** these are the subfolders of `--into`. jev-sort skips folders starting with `.` or `_` (your inbox and review folders) and folders named like a year. Use `--categories a,b` to pick specific folders.

**Learning from your filing:** each category is described to jev using the names of up to 15 documents you've already filed there. A well-stocked folder needs no setup. For an empty or sparse folder, add a line in a `--describe` file:

```yaml
# categories.yaml
Taxes: Tax returns, 1099s, W-2s, IRS and state tax letters
Trust: Family trust deeds, trustee minutes, trust bank statements
```

**Confidence:** a file is filed only when jev's confidence reaches `--min` (default 0.6). Anything below that, and any page with no readable text, goes to `--review-dir` (default `<into>/_Review`).

**Reading the PDF:** jev-sort reads the first two pages with `pdftotext`. Bare scans with no text layer are OCR'd with `ocrmypdf` (pages 1-2 only, so it stays quick).

### Options

| Option | Effect |
|---|---|
| `--rename` | Renames to `<date> <sender> <title>` using Apple's on-device `fm` model. A date is kept only if it's printed in the document; otherwise just the year, if that's printed, or no date at all. If jev judges a proposed name garbled, the original name is kept. |
| `--by-year` | Files into `<category>/<year>/`, using the document's verified year, or else the file's creation year. |
| `--tag` | Adds the category as a Finder tag, keeping existing tags (macOS). |
| `--comment` | Adds jev's decision to the Finder comment, e.g. `jev-sort 2026-10-09: Medical (88%); next Taxes 7%`. Unsure files get their best guesses, which helps when you work through the review folder in Finder's list view with the Comments column on (macOS). |
| `--searchable` | Adds an OCR text layer to scanned PDFs before filing them so Spotlight can find their text. This modifies the PDF. |
| `--json` | Prints one JSON object per file instead of the table. |

### Safety

- It changes nothing without `--apply`.
- It never overwrites a file: a name clash becomes `name (2).pdf`.
- It never deletes anything. Moves across disks copy, check the size, then remove the original.
- Finder tags are only ever added, never removed.

### Requirements

`jev` and `pdftotext` (poppler). Add `ocrmypdf` for scanned PDFs and `--searchable`. `fm` (macOS with Apple Intelligence) is needed for `--rename`.

### Using a different OCR engine

The OCR step is a single function, so a small wrapper can swap it, for example for Apple's Vision framework:

```ts
#!/usr/bin/env bun
import { main, run, type Ocr } from "/path/to/jev-cli/scripts/jev-sort.ts";

const myOcr: Ocr = async (pdf, runner) => (await runner(["my-ocr-tool", pdf])).out;

process.exitCode = await main(process.argv.slice(2), { runner: run, ocr: myOcr, log: console.error }, {
  into: "/path/to/Filed",            // defaults; any command-line option overrides them
  "review-dir": "/path/to/Filed/_Review",
  rename: true,
});
```
