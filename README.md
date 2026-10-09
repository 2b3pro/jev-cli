# jev-cli

![jev: fast decisions from your shell](docs/jev-hero.png)

**Fast yes/no, choice and score decisions from your shell, powered by TypeSafe AI's Jev model.**

```bash
$ cat email.txt | jev choose "What kind of email is this?" personal work receipt newsletter --raw
work

$ if jev gate "Does this need a reply from me?" --min 0.7 -q < email.txt; then echo "reply"; fi
reply
```

> Unofficial project. Not affiliated with or endorsed by TypeSafe AI. You need your own API key from [console.typesafe.ai](https://console.typesafe.ai/keys).

---

## What Jev is (and isn't)

[Jev](https://docs.typesafe.ai) is a hosted "System One" model: it makes fast, calibrated snap judgments about text. You give it a **state** (some text) and one or more typed **questions**, and it returns probabilities in around a hundred milliseconds. It never generates text.

| Question type | You give it | You get back |
|---|---|---|
| `noul` (yes/no) | a question | P(yes), from 0 to 1 |
| `choice` | 2 to 255 labeled options | the chosen label plus a probability for each option |
| `score` | 2 to 10 ordered levels | an expected score (it can fall between levels) plus a probability for each level |

**Good fits:** routing, triage, tagging, filtering, gating, and re-ranking. These are the "which bucket does this go in?" calls you'd otherwise hand to a slow, expensive LLM.

**Poor fits:** TypeSafe's docs say it struggles with exact literal reading, math and dates, multi-step reasoning, and adversarial text that tries to steer the answer. Don't make security decisions on its say-so alone.

`jev` turns those calls into shell primitives. Text goes in on stdin, JSON comes out on stdout, and `gate` turns a probability into an exit code.

## Install

Requires [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/2b3pro/jev-cli.git
cd jev-cli
bun install
bun link          # puts `jev` on your PATH
jev --version
```

### API key

`jev` looks for `TYPESAFE_API_KEY` in the environment first, then (on macOS) in the Keychain:

```bash
export TYPESAFE_API_KEY=...                                             # or
security add-generic-password -s TYPESAFE_API_KEY -a "$USER" -w <key>   # macOS Keychain
```

## Commands

### `ask`: a yes/no probability

```bash
jev ask "Is this a complaint?" --state @ticket.txt
jev ask "Is this spam?" --yes "Unsolicited bulk mail" --no "A real person writing to me" --raw < msg.txt
# 0.97
```

### `gate`: yes/no as an exit code

Passes (exit 0) when P(yes) ≥ `--min` (default 0.5). Use `--max` to pass on a *low* probability, or both for a range.

```bash
jev gate "Does this ask me to do something?" --min 0.7 -q < email.txt && add-task "$(head -1 email.txt)"
jev gate "Is this message hostile?" --max 0.2 -q --state "$reply" || echo "rewrite before sending"
```

Exit 1 always means "did not pass". Every error exits 2, so an outage or a bad key can never be mistaken for a "no".

### `choose`: pick one option

Options are `label` or `label=description`. Descriptions noticeably sharpen the answers.

```bash
cat ticket.txt | jev choose "Which team should handle this?" \
  "billing=Payments, refunds, payouts" "technical=Bugs and outages" "sales=Pricing" --raw
# billing
```

### `score`: rate on an ordered scale

Levels go lowest first. `--raw` prints the expected score, where 0 is the first level.

```bash
jev score "How urgent is this?" "can wait a week" "this week" "today" "right now" --raw < alert.txt
# 2.6
```

### `run`: several questions, one call

A preset asks every question about the same state in a single request, which is cheaper and faster than separate calls.

```bash
jev run examples/presets/email-triage.yaml --state @email.txt --raw
# {"needs_reply": 0.95, "kind": "personal", "urgency": 2.6}
```

### `batch`: a preset over a stream

Reads stdin one line at a time. JSON lines become structured state (or use `--field` to pick one field by dot path), and any other line is used as plain text. The output is one JSON object per input line, **in input order**, with the original `input` echoed back so you can join on it.

```bash
jq -c '.[] | {id, body}' inbox.json \
  | jev batch email-triage --field body --raw \
  | jq -c 'select(.answers.needs_reply > 0.7) | .input.id'
```

A failed line becomes an `{"line": n, "input": ..., "error": {...}}` record and the batch keeps going. If any line failed, the exit code is 2. At the default `--concurrency` of 8 the request rate stays under the API's published 80 requests per second. Higher values (max 32) can hit rate limits, which the SDK absorbs by retrying with backoff.

### `models`

```bash
jev models --raw
```

## Getting text into jev

Jev only reads text. Anything you can convert to text on stdout can be piped in:

```bash
# PDF (pdftotext comes with poppler: brew install poppler / apt install poppler-utils)
pdftotext invoice.pdf - | jev choose "What kind of document is this?" invoice receipt contract statement --raw
# invoice

# Scanned PDF with no text layer: OCR only the first two pages (brew/apt install ocrmypdf)
ocrmypdf --pages 1-2 --sidecar - --output-type none -q scan.pdf /dev/null \
  | jev choose "What kind of document is this?" invoice receipt contract statement --raw
# statement

# Web page (textutil is built into macOS; `pandoc -f html -t plain` works anywhere)
curl -sL https://example.com/post | textutil -stdin -stdout -format html -convert txt \
  | jev choose "What kind of page is this?" news tutorial "product=Product announcement" opinion --raw
# product

# GitHub issue
gh issue view 42 --json title,body -q '.title + "\n\n" + .body' \
  | jev choose "Which label fits this issue?" bug feature question docs --raw
# bug

# Clipboard (macOS; in Windows PowerShell use Get-Clipboard instead of pbpaste)
pbpaste | jev choose "What's the tone of this message?" friendly neutral annoyed angry --raw
# annoyed
```

How the OCR recipe works:
- **Flags:** `--sidecar -` sends the recognized text to stdout. `--output-type none`, with `/dev/null` as the output file, skips writing a new PDF.
- **Speed:** OCR runs on pages 1-2 only, so even a long scan takes a second or two.
- **PDFs that already have text:** `ocrmypdf` refuses these (exit 6, "page already has text"). Nothing reaches `jev`, which exits 2 instead of guessing. Use `pdftotext` for those files, or add `--force-ocr` to OCR them anyway.

### Example: sort a folder of PDFs

```bash
for f in ~/Downloads/*.pdf; do
  kind=$(pdftotext -l 2 "$f" - 2>/dev/null | jev choose "What kind of document is this?" \
    invoice receipt contract statement other --raw) || continue
  printf '%s\t%s\n' "$kind" "$f"
done
# contract   /Users/you/Downloads/nda.pdf
# invoice    /Users/you/Downloads/acme-20431.pdf
# receipt    /Users/you/Downloads/cafe.pdf
```

Here's how the loop handles edge cases:
- **Long documents:** `-l 2` reads only the first two pages. The first pages usually identify a document, and Jev accepts about 32k tokens of state per request.
- **Scanned PDFs:** these have no text layer, so `pdftotext` returns nothing. `jev` reports "State is empty" and exits 2, and `|| continue` skips that file instead of filing it under a bogus label. To include scans, swap in the `ocrmypdf` recipe above.
- **Going further:** the loop prints a plan rather than moving anything. Once you trust the labels, swap the `printf` for a `mv`.

For the full version, see [`scripts/jev-sort`](scripts/README.md#jev-sort). It adds a confidence threshold with a review folder, learns your categories from what you've already filed, and can rename files, add Finder tags and comments, and make scans searchable.

### Example: check a draft's tone from the clipboard

Copy a message you're about to send, run the check, and see whether it might read as harsh. This example shows why `gate` uses three exit codes: an empty clipboard or a network error lands in its own branch instead of being reported as "harsh".

**macOS** (as a notification, from a keyboard shortcut):

```zsh
export PATH="$HOME/.bun/bin:$PATH"   # Shortcuts runs scripts with a minimal PATH

pbpaste | jev gate "Could this message come across as rude, curt, or passive-aggressive?" --max 0.3 -q
case $? in
  0) msg="Tone looks fine." ;;
  1) msg="This might read as harsh. Soften it before sending?" ;;
  *) msg="jev couldn't check the clipboard." ;;
esac
osascript -e "display notification \"$msg\" with title \"Tone check\""
```

To bind it to a key:
1. In the Shortcuts app, create a shortcut with a **Run Shell Script** action (shell: zsh) and paste the script into it.
2. Open the shortcut's details and choose **Add Keyboard Shortcut**.
3. If the action won't run, turn on **Allow Running Scripts** in Shortcuts › Settings › Advanced.

You don't need an `export` line for the key, because `jev` reads it from the Keychain.

**Windows** (PowerShell 7):

```powershell
# Windows has no Keychain lookup, so set the key once: setx TYPESAFE_API_KEY "<key>"
Get-Clipboard | jev gate "Could this message come across as rude, curt, or passive-aggressive?" --max 0.3 -q
switch ($LASTEXITCODE) {
  0       { "Tone looks fine." }
  1       { "This might read as harsh. Soften it before sending?" }
  default { "jev couldn't check the clipboard." }
}
```

Use PowerShell 7 (`pwsh`). Windows PowerShell 5.1 pipes text to programs as ASCII, so curly quotes, accents and emoji arrive as `?`.

## Presets

A preset is YAML or JSON whose `questions` use the API's own schema, so anything in TypeSafe's docs works as-is:

```yaml
model: jev-latest        # optional
questions:
  needs_reply:
    type: noul
    instructions: Does this email need a personal reply from me?
    criteria:
      true: A person is asking me something or waiting on me
      false: Automated, informational, or already resolved
  kind:
    type: choice
    instructions: What kind of email is this?
    criteria:
      personal: From a friend or family member
      work: About a client, project, or business matter
      newsletter: null            # labels can go undescribed
  urgency:
    type: score
    instructions: How soon does this need my attention?
    criteria: [Can wait a week, This week, Today, Right now]
```

Pass a path, or save presets as `~/.config/jev/presets/<name>.yaml` (or set `$JEV_PRESETS_DIR`) and use them by name: `jev run email-triage`. See [`examples/presets`](examples/presets).

## Gut checks for personal decisions

Jev can give a snap read on a choice you're facing. Describe the situation and what matters to you as the state, then `choose`:

```bash
jev choose "Given what I said matters most, which option fits better?" \
  "stay=Keep the current plan" "switch=Take the new offer" --state @situation.md
```

Treat the answer as a gut reaction, not advice. Jev doesn't weigh trade-offs or reason through consequences. It's useful for noticing which way something leans, especially when the probabilities come back close.

## Output

| Mode | stdout |
|---|---|
| default | `{model, answers, usage, request_id}`. `gate` adds `gate: {pass, min, max}` |
| `--raw` | `ask`/`gate`: P(yes) · `choose`: label · `score`: expected score · `run`: `{name: value}` · `batch`: `{line, input, answers: {name: value}}` |
| `-q` | nothing; read the exit code |
| `--dry-run` | the request that would be sent (no key needed, no call made) |

Errors and diagnostics go to stderr. The `request_id` is what TypeSafe support will ask for.

## Options

| Option | Applies to | Meaning |
|---|---|---|
| `--state <text\|@file\|->` | ask, gate, choose, score, run | State to evaluate. With no flag, piped stdin is used. `@@text` passes a literal leading `@`. |
| `--raw` | all | Only the answer values |
| `-q`, `--quiet` | all | No stdout |
| `--dry-run` | all except models | Print the request, don't send it |
| `--model <name>` | all | Model; default `$TYPESAFE_DEFAULT_MODEL` or `jev-latest` |
| `--name <key>` | ask, gate, choose, score | Answer key (default `answer`) |
| `--yes <text>`, `--no <text>` | ask, gate | Describe each outcome |
| `--min <p>`, `--max <p>` | gate | Pass thresholds |
| `--field <path>` | batch | Dot path to the state in each JSON line |
| `--concurrency <n>` | batch | Parallel requests, 1-32 (default 8) |
| `--timeout <ms>` | all | Per-attempt timeout (default 10000) |
| `--retries <n>` | all | Retries on 408/429/5xx/connection errors (default 2) |
| `--verbose` | all | Log request summaries to stderr |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; for `gate`, passed |
| 1 | `gate` did not pass |
| 2 | Any error: bad usage, missing key, API or network failure, or a failed `batch` line |

## Configuration

| Variable | Default | |
|---|---|---|
| `TYPESAFE_API_KEY` | (none) | API key. On macOS, falls back to Keychain service `TYPESAFE_API_KEY`. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API root |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Default model |
| `JEV_PRESETS_DIR` | `~/.config/jev/presets` | Named preset directory (respects `XDG_CONFIG_HOME`) |

**Optional PAI logging:** if `PAI_DIR` points at a [Personal AI Infrastructure](https://github.com/danielmiessler/PAI) install with `Infrastructure/Logger/logger.ts`, `jev` writes batch summaries and API failures to that logger. Without it, `jev` logs nothing.

## Cost

As of October 2026, TypeSafe lists Jev at $0.042 per million input tokens, with free output. A typical triage call uses a few hundred tokens. Check [their model docs](https://docs.typesafe.ai/models.md) for current pricing and rate limits.

## Development

```bash
bun test            # runs against a fake API, no key or network needed
bun run typecheck
bun src/cli.ts --help
```

Built on the official [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk), which handles retries and typed errors. Presets parse with Bun's built-in YAML, so the SDK is the only runtime dependency.

---

## Support

jev is free and open source. If it saves you time triaging your inbox or gating your scripts, consider buying me a coffee and croissant! It helps keep the updates coming.

<a href="https://paypal.me/2b3/5">
  <img src="https://img.shields.io/badge/Donate-PayPal-blue.svg" alt="Donate with PayPal" />
</a>

**[Buy me a cup of coffee and croissant!](https://paypal.me/2b3/10)**

---

## License

This project is licensed under the [MIT License](LICENSE).
