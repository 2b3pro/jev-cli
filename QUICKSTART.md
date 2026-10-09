# jev quick start

**Setup**

```bash
bun install && bun link
export TYPESAFE_API_KEY=...        # or store it in macOS Keychain, see README
```

**The five calls you'll use most**

```bash
jev ask "Is this a complaint?" --raw < msg.txt                      # 0.93
jev choose "Which team?" billing technical sales --raw < msg.txt    # billing
jev score "How urgent?" low medium high critical --raw < msg.txt    # 2.4
jev gate "Needs a reply?" --min 0.7 -q < msg.txt && echo reply      # exit 0/1
jev run examples/presets/email-triage.yaml --raw < msg.txt          # {"needs_reply": 0.9, ...}
```

**Bulk**

```bash
jq -c '.[] | {id, body}' inbox.json | jev batch examples/presets/email-triage.yaml --field body --raw > out.jsonl
jq -c 'select(.answers.needs_reply > 0.7) | .input.id' out.jsonl
```

**Useful jq patterns**

```bash
jev choose "Team?" a b c < t.txt | jq '.answers.answer.probabilities'   # see how close the call was
jev run triage < t.txt | jq '.usage.input_tokens'                         # cost check
```

**Before spending tokens:** add `--dry-run` to see the exact request.

**Exit codes:** 0 ok or gate passed · 1 gate failed · 2 any error.

Full docs: [README.md](README.md) · agent reference: [CLI-REFERENCE.md](CLI-REFERENCE.md)
