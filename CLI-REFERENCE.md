# jev CLI reference (for agents)

Wraps TypeSafe AI Jev (`POST /v1/systemone`): fast calibrated classification of text. It does no text generation. Weak at literal reading, math/dates, multi-hop reasoning, and adversarial state.

## Commands

| Command | Args | Question sent | `--raw` output |
|---|---|---|---|
| `ask <q>` | | noul | P(yes) float |
| `gate <q>` | `--min p` (default .5), `--max p` | noul | P(yes); exit 0 pass / 1 fail |
| `choose <q> <opt>...` | opt = `label` or `label=desc`, 2-255 | choice | label |
| `score <q> <level>...` | 2-10 levels, lowest first | score | expected score float (0 = first level) |
| `run <preset>` | name or path | preset questions | `{name: value}` JSON |
| `batch <preset>` | stdin lines; `--field a.b`, `--concurrency n` (1-32, default 8) | preset questions per line | JSONL `{line, input, answers:{name: value}}` |
| `models` | | | names, one per line |

## State

`--state text` · `--state @file` · `--state -` (stdin) · no flag: piped stdin. `@@x` = literal `@x`. Empty → exit 2. `batch` takes states only from stdin: JSON lines are used as JSON (or `--field` picks a value), other lines as text, and blank lines are skipped.

## Flags

`--raw` · `-q` (no stdout) · `--dry-run` (print request, no key needed) · `--model m` · `--name key` (default `answer`) · `--yes t` / `--no t` (noul outcome descriptions) · `--timeout ms` · `--retries n` · `--verbose`

## Output (default)

`{model, answers: {name: answer}, usage: {input_tokens, output_tokens}, request_id}`. gate adds `gate: {pass, min?, max?}`.
- noul answer: `{type, noul}`
- choice answer: `{type, choice, confidence, probabilities: {label: p}}`
- score answer: `{type, score, confidence, legend: {i: desc}, probabilities: {i: p}}`

batch default line: `{line, input, model, answers, usage, request_id}`; failed line: `{line, input, error: {message, status?, request_id?}}`. Lines come out in input order.

## Exit codes

0 ok / gate pass · 1 gate fail · 2 any error (usage, key, API, network, any failed batch line)

## Preset file (YAML or JSON)

```yaml
model: jev-latest   # optional; --model overrides
questions:
  <name>: {type: noul, instructions: "...", criteria: {true: "...", false: "..."}}   # criteria optional
  <name>: {type: choice, instructions: "...", criteria: {label: "desc or null", ...}}
  <name>: {type: score, instructions: "...", criteria: ["lowest", "...", "highest"]}
```

Lookup by name: `$JEV_PRESETS_DIR` or `~/.config/jev/presets/<name>.{yaml,yml,json}`. An argument containing `/` or ending in an extension is treated as a path.

## Env

`TYPESAFE_API_KEY` (macOS fallback: Keychain service `TYPESAFE_API_KEY`) · `TYPESAFE_BASE_URL` · `TYPESAFE_DEFAULT_MODEL` · `JEV_PRESETS_DIR` · `PAI_DIR` (optional logger)

## Patterns

```bash
jev gate "Q?" --min 0.7 -q < f && do_thing          # branch on a judgment
jev run p.yaml --raw < f | jq -r .kind              # route on a label
cat items.jsonl | jev batch p --field text --raw | jq -c 'select(.answers.x > .8) | .input'
jev choose "Q?" a b --state @f | jq .answers.answer.probabilities   # inspect margin before trusting
```
