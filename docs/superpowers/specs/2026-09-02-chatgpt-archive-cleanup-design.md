# ChatGPT Archive Cleanup Design

## Goal

Build a local TypeScript/Node 22 CLI that can inspect an already-authenticated `chatgpt.com` Chromium session over CDP, produce a metadata-only dry-run for conversations older than the configured cutoff, and archive conversations only after an explicit confirmation. The utility must never delete data, read credentials, or run cleanup during development.

## Safety boundaries

- The browser is opened and authenticated by the user. The utility only connects to an existing page at `https://chatgpt.com`.
- Authenticated API calls run inside the page with `fetch`, so no cookies, bearer tokens, authorization headers, Chrome databases, Keychain data, or passwords are read or persisted.
- Discovery stores only a redacted, normalized operation schema: origin, HTTP method, path templates, query parameter names, pagination mode, field paths, and the safe archive body key.
- `UNKNOWN` project membership is never a candidate.
- A central request firewall is the only route to mutation. It accepts exactly `archive-conversation`; it rejects `DELETE`, bulk operations, project operations, moves, and content/title changes.
- No code reads or deletes `~/.codex`.
- Development and verification use fixtures and fake browser/API adapters. No live ChatGPT cleanup is run.

## Architecture

The CLI is split into small, testable layers:

1. `browser.ts` owns CDP connection, exact origin validation, page-context authenticated fetch, resource observation, and safe bundle inspection. Disconnecting must leave the user's Chrome running.
2. `discovery.ts` performs bounded read-only discovery. It derives candidate list/project/archive operations from current resource requests and current frontend bundle strings, validates response shapes, redacts values, and writes a safe config. Missing or ambiguous evidence returns `BLOCKED`.
3. `inventory.ts` performs complete cursor/offset pagination and normalizes ChatGPT/Codex records separately. Repeated cursors, malformed pages, and unsupported schemas fail closed.
4. `projects.ts` creates a protected conversation-ID set from the discovered project inventory. A complete project scan is required before unrelated conversations can be classified as confirmed non-project.
5. `filter.ts` deduplicates conservatively and applies the strict cutoff predicate. Any conflicting duplicate metadata becomes less eligible, never more eligible.
6. `safety.ts` enforces the mutation firewall.
7. `archive.ts` implements execute mode: fresh inventory, project-set snapshot, deterministic canary, re-fetch/revalidation, single archive, verification, then serial batch processing with stop-on-ambiguity.
8. `manifest.ts` writes only conversation metadata and execute rollback IDs to `~/.local/state/chatgpt-archive-cleanup/`.
9. `cli.ts` keeps the default/no-subcommand path read-only and wires the three commands.

## Normalized data contracts

The discovery config is schema versioned and contains no response bodies or headers:

```ts
type Operation = {
  method: "GET" | "PATCH" | "POST" | "PUT";
  pathTemplate: string;
  queryKeys: string[];
  pagination: "none" | "offset" | "cursor";
  pageSize: number;
  response: ResponseSchema;
};

type DiscoveryConfig = {
  schema: 1;
  discoveredAt: string;
  origin: "https://chatgpt.com";
  operations: {
    listConversations: Operation[];
    listProjects: Operation;
    listProjectConversations: Operation;
    archiveConversation: Operation;
    listArchivedConversations?: Operation;
  };
};
```

The normalized conversation record is `{ id, kind, title, archived, lastActivity, projectStatus }`. A candidate requires `archived === false`, `CONFIRMED_NON_PROJECT`, a valid timestamp, and `lastActivity < 2026-06-02T18:10:00+07:00` by default. Equality is skipped.

## Data flow

`discover` observes current same-origin requests, asks the user to open history/projects if evidence is missing, validates representative response schemas, derives a redacted config, and exits without mutation.

`dry-run` validates the config against the current page, paginates every active conversation operation, scans the complete project inventory, classifies and deduplicates records, prints counts, and saves a manifest with no bodies. It reports `Mutations executed: 0`.

`execute --confirm-archive` repeats the inventory from scratch. It never treats an older dry-run manifest as authoritative. It snapshots the protected project set, re-fetches the first deterministic candidate, checks all safety predicates and that the project set is unchanged, archives exactly one item, and verifies it is no longer active and is reliably archived. Only then does it process the remaining candidates one at a time. Any failed verification, project-set change, schema/auth anomaly, or ambiguous record aborts the batch.

## Testing strategy

Vitest tests use fixture payloads and fake browser/API adapters. They cover the strict date boundary, project/unknown/archived skips, malformed and duplicate records, full pagination, firewall rejection, dry-run zero mutation, confirmation guard, canary failure, project-set drift, and execute-time revalidation. No test contacts `chatgpt.com`.

## Non-goals

Automatic rollback, deletion, project mutation, bulk archive, history cleanup outside the discovered ChatGPT/Codex inventory, and any changes to existing repositories are out of scope.
