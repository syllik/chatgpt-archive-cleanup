# ChatGPT Archive Cleanup Security Hardening Design

## Goal

Close the three reproducible High-severity safety failures in the archive execution path while preserving the existing read-only default, exact ChatGPT origin, Project protection, serial canary workflow, and fixture-only test boundary.

## Scope and invariants

- `discover` and `dry-run` perform zero account mutations.
- `execute` requires both `--confirm-archive` and an explicitly named reviewed dry-run manifest.
- No live ChatGPT discovery, dry-run, archive, cleanup, or mutation is used during development or verification.
- No HTTP `DELETE`, bulk mutation, Project/membership/move/title/content mutation, credential access, cookie/token/header persistence, `~/.codex` access, default-cutoff change, dependency upgrade, CI change, or unrelated refactor.
- All potentially mutating execution is serial and fails closed on ambiguity.

## High-1: shared conservative duplicate classification

`filter.ts` will expose the smallest pure reusable helper needed by both initial classification and execute-time revalidation. The helper will group records by `(kind, id)` and merge each group with commutative, conservative rules:

- `archived` is true if any record is archived.
- `UNKNOWN` Project status dominates `CONFIRMED_PROJECT`, which dominates `CONFIRMED_NON_PROJECT`.
- Any missing or invalid activity timestamp makes the merged timestamp invalid.
- Otherwise the latest activity instant wins; equal instants use a deterministic string tie-breaker.
- Non-safety metadata is selected deterministically without affecting eligibility.

`classifyConversations()` will use this helper. `findEligibleItem()` will gather every refreshed record matching the target `(kind, id)` and classify the group through the same helper, never using the first raw record. Duplicate order therefore cannot make an item more eligible.

## High-2: metadata-only write-ahead journal

`manifest.ts` will provide an explicit `ExecutionJournal` interface and a filesystem implementation. The journal is created before the first archive request and is stored below the configured state directory in a restrictive directory with a private file. Journal entries contain only:

```ts
type JournalEntry = {
  id: string;
  kind: ConversationKind;
  state: "pending" | "awaiting-verification" | "verified" | "ambiguous";
  at: string;
};
```

The journal writer uses a temporary file, private mode `0600`, atomic rename, and `fsync`/directory sync where the platform supports it without making the implementation non-portable. It serializes no titles, dates, bodies, headers, cookies, tokens, response data, or remote error text.

The archive workflow:

1. Creates or opens a new journal only after confirming no prior journal has an unresolved entry.
2. Persists `pending` before invoking the transport.
3. Persists `awaiting-verification` if the transport returns, before verification starts.
4. Persists `verified` only after verification succeeds.
5. Persists `ambiguous` for a transport throw after the request may have been sent or for verification failure, then aborts before any later mutation.

Any failed journal creation or transition aborts before the next mutation. A prior `pending`, `awaiting-verification`, or `ambiguous` entry blocks a new execute run; a corrupted or unreadable journal also fails closed. The existing execute manifest remains a metadata-only summary of verified results; the journal is the durable record for uncertain attempts.

## High-3: reviewed dry-run and browser-context binding

The dry-run manifest will be extended to a new schema version with an explicit read-only marker and provenance containing the exact origin, a one-way discovery-config fingerprint, and an optional one-way account/workspace fingerprint. The manifest retains the complete classified entry set, not only candidates, so safety-relevant metadata can be compared.

The CLI will add `--dry-run-manifest PATH` to `execute`. It will reject execution before connecting when the option is absent, the manifest is not a valid read-only dry-run, the cutoff differs, or the manifest provenance is invalid. After connecting, it will:

1. Require one and only one viable `https://chatgpt.com` page across all CDP contexts.
2. Validate the current client against the reviewed discovery config.
3. Recompute the complete fresh conversation and Project inventory.
4. Compare the fresh classified entry set and safety metadata with the reviewed manifest exactly, including candidate IDs, additions/removals, duplicate-conflict outcomes, archive state, activity timestamp, and Project status.
5. Compare an available non-secret account/workspace fingerprint when the authenticated page can provide one. If no reliable fingerprint is available, no identity value is invented or persisted; the exact-origin, single-page/context, config, and complete-inventory guards remain mandatory.
6. Only then enter `executeArchive()`, which repeats its normal canary and per-item revalidation before each mutation.

The dry-run is an approval constraint, never authoritative execution data. A fresh addition, conflict, cutoff change, Project-status change, account fingerprint mismatch, multiple viable pages/contexts, or any other comparison failure aborts with zero mutation.

## Components and interfaces

- `src/filter.ts`: pure conservative deduplication/merge helper shared by classification and revalidation.
- `src/manifest.ts`: versioned dry-run validation/fingerprinting, metadata-only atomic writes, and `ExecutionJournal` implementation.
- `src/archive.ts`: journal transitions, ambiguity handling, reviewed-snapshot comparison support, and duplicate-safe revalidation.
- `src/browser.ts`: fail-closed single viable page/context selection and optional non-secret identity fingerprint extraction only from already available authenticated page data.
- `src/cli.ts`: explicit reviewed-manifest argument, pre-connect guards, fresh-inventory reconciliation, journal lifecycle, and safe partial-error reporting.
- `src/types.ts`: schema/version/provenance and journal contracts without sensitive fields.

## Error handling

Errors exposed to the CLI identify the safety guard that stopped execution and may identify a conversation only by `(kind, id)`. No raw transport exception, response body, request body, cookie, token, header, title, or message content is copied into a manifest or journal. Any uncertain state stops the batch and leaves the journal for diagnosis/recovery.

## Testing strategy

Vitest tests use only normalized fixtures, fake inventory sources, fake transports, fake journals, and fake CLI/browser sessions. New regression coverage will prove:

- both duplicate orderings and every required conflict type yield zero mutation in canary and later batch revalidation;
- unambiguous serial execution remains functional;
- journal pending is written before transport, pre-write failures make zero transport calls, post-send throws become ambiguous, verification failures are recorded, successful canary/batch entries become verified, unresolved journals block, and serialized data is metadata-only/private;
- execute without a reviewed manifest, cutoff mismatch, candidate/safety-metadata mismatch, and multiple viable browser pages all make zero mutation;
- an exact reviewed manifest with matching fresh inventory preserves canary and serial execution behavior.

The complete required verification remains `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run archive -- --help`, `npm audit --json`, `git diff --check`, and a fresh manual security review of the full execution path. No live browser or ChatGPT endpoint is contacted.

## Non-goals

Automatic rollback, deletion, bulk archive, new identity endpoints, credential discovery, account switching, dependency upgrades, CI changes, and changes outside this repository are out of scope.
