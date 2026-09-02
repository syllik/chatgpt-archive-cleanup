# ChatGPT Archive Cleanup

Local TypeScript/Node utility for a manually controlled, discovery-driven ChatGPT/Codex archive workflow.

The default path is read-only. `discover` and `dry-run` execute zero account mutations. `execute` is implemented but requires the `execute` subcommand, `--confirm-archive`, and an explicitly reviewed dry-run manifest. There is no delete operation.

## Requirements

- Node `22.23.2` (the package engine accepts Node 22.23.2 through 22.x)
- A separate Chrome profile connected to ChatGPT by CDP

Install dependencies:

```bash
npm install
```

Start a separate Chrome profile and log in yourself:

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chatgpt-archive-browser"
```

Open `https://chatgpt.com` in that window. The utility never reads Chrome cookies, Keychain data, bearer/session tokens, passwords, or `~/.codex`.

## Read-only workflow

Run discovery after opening ChatGPT history and Projects when prompted:

```bash
npm run archive -- discover
```

Discovery writes only a redacted config to:

```text
~/.local/state/chatgpt-archive-cleanup/discovery-config.json
```

Review the complete dry-run before considering execution:

```bash
npm run archive -- dry-run
```

The metadata-only manifest is written under:

```text
~/.local/state/chatgpt-archive-cleanup/runs/
```

The default cutoff is `2026-06-02T18:10:00+07:00`; override it with `--cutoff ISO`. Unknown Project membership is always skipped.

## Execution

Do not run this until you have reviewed a specific dry-run manifest:

```bash
npm run archive -- execute --confirm-archive \
  --dry-run-manifest ~/.local/state/chatgpt-archive-cleanup/runs/<reviewed-dry-run>.json
```

`--confirm-archive` is insufficient by itself. Execution validates the reviewed manifest, cutoff, discovery provenance, and current browser/account context, then re-fetches the complete inventory and requires its safety metadata to match exactly. A CDP session with multiple ChatGPT pages/contexts is rejected. Each archive request is recorded in a metadata-only write-ahead journal before transport; unresolved journal entries block a new execute run. Execution performs one canary archive, verifies it, and then processes candidates serially. Any ambiguity, Project-set change, reviewed-inventory drift, or failed verification stops the batch. Execute manifests retain only IDs, `previousArchived: false`, and timestamps for a future separately reviewed rollback task.

## Development checks

```bash
npm test
npm run typecheck
npm run lint
npm run archive -- --help
```

No live ChatGPT request is required by the test suite.
