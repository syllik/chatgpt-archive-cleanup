# ChatGPT Archive Cleanup Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close HIGH-1 duplicate revalidation, HIGH-2 non-durable execute records, and HIGH-3 unreviewed/account-ambiguous execution without weakening the existing read-only and mutation-firewall guarantees.

**Architecture:** Keep classification pure and shared by initial inventory and every execute-time lookup. Add an injected metadata-only execution journal with atomic filesystem persistence, then require a reviewed dry-run manifest and fresh-inventory reconciliation before the existing serial canary workflow can mutate. Make CDP page selection fail closed when more than one viable ChatGPT page is present.

**Tech Stack:** Node `22.23.2`, TypeScript, Vitest, `playwright-core`, Node `fs/promises`/`crypto` primitives, ESLint.

**Spec:** `docs/superpowers/specs/2026-09-02-chatgpt-archive-cleanup-security-hardening-design.md`

## Global Constraints

- Runtime target: exactly Node `22.23.2`.
- `discover` and `dry-run` perform zero account mutations.
- `execute` requires `--confirm-archive` and `--dry-run-manifest PATH`.
- Only exact origin `https://chatgpt.com` is accepted.
- No HTTP `DELETE`, bulk mutation, Project/membership/move/title/content mutation, credential access, cookie/token/header persistence, `~/.codex` access, default cutoff change, dependency upgrade, CI change, or unrelated refactor.
- All mutations are serial, guarded by `assertSafeMutation`, and stop on ambiguity.
- Journal and manifests contain only non-sensitive metadata; journal files are `0600` and containing directories are restrictive.
- Tests use fixtures and fake adapters only; never connect to a live ChatGPT session.

---

### Task 1: Extract order-independent conservative deduplication

**Files:**
- Modify: `src/filter.ts`
- Modify: `src/archive.ts`
- Test: `test/filter.test.ts`
- Test: `test/archive.test.ts`

**Interfaces:**
- `src/filter.ts` produces the exported pure helper `deduplicateConversations(items: NormalizedConversation[]): NormalizedConversation[]` and keeps `classifyConversations()` based on that helper.
- `src/archive.ts` consumes the helper indirectly through `classifyConversations()` or directly, but never reimplements merge rules.

- [ ] **Step 1: Add the failing filter test for duplicate-order invariance.**

Add two duplicate records with the same `(kind, id)` and assert that classifying `[old, newer]` and `[newer, old]` produces the same safety-relevant entry and neither ordering produces a candidate when the newer record is at/after the cutoff. Assert that the merged activity is the newest valid activity, `archived` is conservative, and Project status uses the most restrictive status.

- [ ] **Step 2: Run the focused filter test and verify the expected failure.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test -- --run test/filter.test.ts
```

Expected: the new order-invariance assertion fails against the current left-biased merge behavior or the requested exported helper is absent; existing filter tests remain green.

- [ ] **Step 3: Implement the pure commutative merge helper.**

Make duplicate merging deterministic for all fields. Preserve the existing strict timestamp validation, use `archived = left.archived || right.archived`, make `UNKNOWN` dominate Project and non-Project, make any invalid/missing activity invalidate the merged timestamp, choose the latest valid instant, and use a deterministic lexical tie-breaker for equal timestamp strings and titles. Have `classifyConversations()` consume the helper.

- [ ] **Step 4: Run focused filter tests and verify green.**

Run the command from Step 2. Expected: all filter tests pass with no warnings.

- [ ] **Step 5: Add the failing HIGH-1 archive tests.**

Extend `test/archive.test.ts` with fake inventory sequences proving zero transport calls for each case in both canary and later batch revalidation:

```text
old eligible then newer duplicate
newer duplicate then old duplicate
active duplicate plus archived duplicate
non-Project duplicate plus Project/UNKNOWN duplicate
```

Keep one unambiguous candidate in each sequence where needed so the later-batch cases prove the batch stops or skips before mutating the conflicting target. Preserve a separate successful unambiguous serial case.

- [ ] **Step 6: Run the focused archive tests and confirm they fail for first-record selection.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test -- --run test/archive.test.ts
```

Expected: the new duplicate tests demonstrate that the current `.find()` path mutates an unsafe target.

- [ ] **Step 7: Make revalidation classify every matching record.**

Change `findEligibleItem()` so it filters all refreshed records by `(kind, id)` and sends the full group through the shared classification/deduplication semantics. Return the one candidate only when the merged group is unambiguously eligible; otherwise return `null` and preserve the existing no-mutation/stop behavior.

- [ ] **Step 8: Run the archive and full pure-layer tests.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test -- --run test/filter.test.ts test/archive.test.ts
```

Expected: all focused tests pass, including canary and later-batch duplicate coverage.

---

### Task 2: Add the metadata-only durable execution journal

**Files:**
- Modify: `src/types.ts`
- Modify: `src/manifest.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- `src/types.ts` defines `JournalState`, `JournalEntry`, and `ExecutionJournal` contracts without sensitive fields.
- `ExecutionJournal` exposes `record(item: Pick<NormalizedConversation, "id" | "kind">, state: JournalState, at: string): Promise<void>`; `createExecutionJournal(stateDir, createdAt)` creates the current journal, and `assertNoUnresolvedJournals(stateDir)` inspects prior journals before a new run.
- `src/manifest.ts` produces a filesystem implementation plus helpers for secure atomic JSON persistence and journal discovery.

- [ ] **Step 1: Add failing journal tests for schema, privacy, and permissions.**

Test a fake or filesystem journal that creates a journal before any request, records only `(kind, id, state, at)`, writes under a `0700` directory with `0600` files, rejects unsafe extra fields, and atomically replaces the file. Include a corrupted/unreadable prior journal case that is treated as unresolved rather than ignored.

- [ ] **Step 2: Run focused manifest tests and confirm missing journal behavior.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test -- --run test/manifest.test.ts
```

Expected: the new journal tests fail because the journal contract and implementation do not exist.

- [ ] **Step 3: Implement journal contracts and secure atomic writes.**

Add states `pending`, `awaiting-verification`, `verified`, and `ambiguous`. Implement a journal file below the configured state directory. Write a temporary file with `0600`, flush and sync its file handle where supported, atomically rename it, and sync the parent directory where supported. Create directories with `0700` and explicitly preserve private modes on existing directories/files. Scan prior journal files; any `pending`, `awaiting-verification`, or `ambiguous` entry, malformed journal, or read failure blocks a new run. Do not serialize error strings, response data, titles, dates from conversations, or request details.

- [ ] **Step 4: Run focused manifest tests and verify green.**

Run the command from Step 2. Expected: journal privacy, state, atomicity, and fail-closed tests pass; existing manifest tests are updated only for intentional schema changes.

---

### Task 3: Integrate journal transitions into archive execution

**Files:**
- Modify: `src/archive.ts`
- Test: `test/archive.test.ts`

**Interfaces:**
- `executeArchive(options)` consumes an injected `ExecutionJournal` and records every attempted `(kind, id)` before transport invocation.
- `ArchiveAbortedError` continues to expose only verified result metadata and a safe guard message.

- [ ] **Step 1: Add failing fake-journal tests for transition ordering and stops.**

Add a recording fake journal and tests asserting:

```text
pending is recorded before transport.archive is entered
journal pending write failure causes zero transport calls
transport side effect followed by throw records ambiguous and prevents later mutation
verification false records ambiguous and prevents later mutation
successful canary and batch items transition pending -> awaiting-verification -> verified
```

Make the fake transport record a server-side side effect before throwing a plain `Error("connection lost after send")`; assert the error text is not stored by the journal. Verify that a transition failure after a verified mutation prevents any next mutation.

- [ ] **Step 2: Run focused archive tests and confirm they fail before implementation.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test -- --run test/archive.test.ts
```

Expected: the new journal assertions fail because the current workflow calls transport before recording any durable state and records results before verification.

- [ ] **Step 3: Implement journal lifecycle around each mutation.**

Require an initialized journal before the first transport call. For each target, record `pending`, call the transport inside a guarded try/catch, record `awaiting-verification` only after the call resolves, verify, then record `verified` before adding the result. On transport or verification ambiguity, record `ambiguous` and abort without loading or mutating later targets. If a required transition throws, abort immediately and never begin another mutation. Do not put the raw caught error into `ArchiveAbortedError`, journal data, or manifests.

- [ ] **Step 4: Run focused archive tests and verify green.**

Run the command from Step 2. Expected: all archive tests pass, including original canary/project-drift/serial behavior and every journal ordering case.

---

### Task 4: Version and validate reviewed dry-run manifests

**Files:**
- Modify: `src/types.ts`
- Modify: `src/manifest.ts`
- Modify: `src/cli.ts`
- Test: `test/manifest.test.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- `DryRunManifest` contains the complete classified entry set, cutoff, `mutationsExecuted: 0`, explicit `readOnly: true`, and non-secret provenance: exact origin, discovery-config fingerprint, and optional account/workspace fingerprint.
- `writeDryRunManifest()` accepts the provenance needed to produce the reviewed manifest.
- `readReviewedDryRunManifest(path, cutoff, expectedConfigFingerprint)` validates the envelope, read-only marker, schema, cutoff, origin, provenance, and complete entry shape before any execution connection.
- `fingerprintDiscoveryConfig(config)` and `fingerprintAccountContext(value)` return one-way stable fingerprints only.
- Fresh classification comparison uses canonical safety signatures for all entries and candidate IDs, without treating titles as authorization data.

- [ ] **Step 1: Add failing manifest validation and comparison tests.**

Test rejection of execute manifests, manifests with nonzero mutations, missing/false read-only markers, invalid schema, cutoff mismatch, wrong origin, missing provenance, malformed entries, and candidate/safety metadata changes. Test stable config fingerprints and one-way account fingerprints without persisting the source value.

- [ ] **Step 2: Run focused manifest/CLI tests and verify expected failures.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test -- --run test/manifest.test.ts test/cli.test.ts
```

Expected: new validation/comparison tests fail because the baseline manifest is schema 1 and execute has no reviewed-manifest input.

- [ ] **Step 3: Implement versioned manifest contracts and canonical comparisons.**

Use a new dry-run schema version while preserving metadata-only output. Canonicalize only non-secret config/provenance and safety fields before hashing/comparing. Treat any entry addition/removal, `(kind,id)` change, action change, archive-state outcome change, invalid/activity change, Project-status change, or duplicate-conflict outcome change as a mismatch. Reject a cutoff mismatch and a discovery-config fingerprint mismatch before connecting. Keep raw titles out of the authorization comparison.

- [ ] **Step 4: Wire `--dry-run-manifest PATH` and update dry-run output.**

Make `execute` require the flag in addition to `--confirm-archive`. Have `dry-run` write the new reviewed-manifest envelope with `readOnly: true` and provenance. Do not add implicit “latest manifest” selection. Keep discover and dry-run mutation-free.

- [ ] **Step 5: Run focused tests and verify green.**

Run the command from Step 2. Expected: manifest schema/privacy and pre-connect CLI guards pass while the original read-only tests remain green.

---

### Task 5: Bind execution to one CDP context and fresh reviewed inventory

**Files:**
- Modify: `src/browser.ts`
- Modify: `src/cli.ts`
- Modify: `src/archive.ts` if the reviewed snapshot contract belongs at the execution boundary
- Test: `test/browser.test.ts`
- Test: `test/cli.test.ts`
- Test: `test/archive.test.ts`

**Interfaces:**
- `selectUniqueChatGPTPage(pages: Page[]): Page` returns a page only when exactly one viable exact-origin page exists; `connectToChatGPT()` applies it across all contexts, closes the CDP connection, and throws a safe ambiguity error on zero or multiple viable pages.
- `CliSession` optionally exposes a reliable non-secret account/workspace fingerprint supplied by the already authenticated page; no undocumented identity endpoint is added.
- A reviewed-execution preflight compares the fresh complete snapshot against the reviewed dry-run before `executeArchive()` can call transport.

- [ ] **Step 1: Add failing browser and CLI guard tests.**

Call the pure `selectUniqueChatGPTPage()` with fake page objects to prove two viable ChatGPT pages fail closed, and use a fake CDP browser to prove `connectToChatGPT()` closes on ambiguity. Add CLI tests for execute without a reviewed manifest, cutoff mismatch, candidate addition/removal, duplicate/safety metadata mismatch, and account fingerprint mismatch; assert zero archive calls in every case and zero connection calls for pre-connect failures. Keep `--confirm-archive` alone insufficient.

- [ ] **Step 2: Run focused browser/CLI tests and verify expected failures.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test -- --run test/browser.test.ts test/cli.test.ts test/archive.test.ts
```

Expected: multiple-page and reviewed-manifest tests fail against first-page selection and the current execute dispatch.

- [ ] **Step 3: Implement fail-closed page selection.**

Collect all pages from all browser contexts, retain only pages whose current URL has exact origin `https://chatgpt.com`, require exactly one, and close the browser before throwing on zero or multiple viable pages. Preserve disconnect behavior that leaves the user’s Chrome process running.

- [ ] **Step 4: Implement fresh reviewed-inventory reconciliation.**

Before connecting, load and validate the stored discovery config, compute its fingerprint, and validate the reviewed manifest against that fingerprint and the requested cutoff. After single-page connection, obtain only an optional non-secret account fingerprint from the session, validate the current discovery client, load the complete conversations and Project inventory, apply Project statuses, classify/deduplicate it, and compare it to the reviewed manifest’s canonical safety snapshot. If the reviewed manifest contains a fingerprint, require the current session to provide the same fingerprint; if both are absent, continue without inventing an identity value or using an undocumented endpoint. On any mismatch, abort before constructing or invoking a mutating transport. Pass the approved journal and reviewed constraints into `executeArchive()`, which still performs its own canary and per-item refreshes.

- [ ] **Step 5: Add the exact reviewed-manifest success regression.**

Create a schema-valid reviewed fixture whose fresh inventory matches exactly, provide a single viable fake session and fake journal, and assert the existing canary plus serial batch archive calls remain functional and become `verified` in the journal.

- [ ] **Step 6: Run focused tests and verify green.**

Run the command from Step 2. Expected: all High-3 guard tests, exact-match success tests, and existing browser/archive/CLI tests pass with zero live browser access.

---

### Task 6: Update user-facing contracts and perform complete security verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-02-chatgpt-archive-cleanup-security-hardening-design.md` only if implementation decisions require an exact correction

- [ ] **Step 1: Update README execution instructions.**

Document that execute requires an explicit reviewed dry-run manifest path and that unresolved journals block retry. Preserve the default cutoff and all read-only/security boundaries. Do not document or encourage live execution during tests.

- [ ] **Step 2: Run the full test suite and static checks under Node 22.23.2.**

Run exactly:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm test
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm run typecheck
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm run lint
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm run archive -- --help
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm audit --json
```

Expected: all tests pass, typecheck/lint/help exit 0, and the audit reports zero vulnerabilities. If `npm ci` again omits the Darwin arm64 optional Rollup package, repair only generated `node_modules` as diagnosed during baseline and report that environment detail.

- [ ] **Step 3: Run required install and whitespace checks.**

Run:

```bash
PATH=/Users/mihaildovgun/.nvm/versions/node/v22.23.2/bin:$PATH npm ci
git diff --check
```

Then rerun the full test/static suite if `npm ci` replaced generated dependencies or if any late change was made.

- [ ] **Step 4: Perform a fresh execution-path security review.**

Read the complete final diff and trace `cli.ts -> browser.ts -> inventory/projects/filter -> archive.ts -> manifest/journal -> transport`. Prove with `rg` that there is no `DELETE`, bulk mutation, `~/.codex`, cookie/token/header persistence, raw response/error serialization, first-page selection, implicit dry-run fallback, or transport call before journal/review guards. Confirm no generated files or secrets are tracked.

- [ ] **Step 5: Verify repository state and commit readiness.**

Run:

```bash
git status --short --branch
git diff --stat
git diff --name-only
git log --oneline --decorate -4
git diff --check
```

Confirm only the intended implementation, tests, and README/design documentation are changed, no edits are present on `main`, and the implementation branch is based on audited HEAD plus the signed design commit.

---

## Final GitHub handoff

After all local verification is green, create one normal signed implementation commit on `codex/security-high-remediation`, push that branch without force, open a PR targeting `main`, and inspect its checks. Do not merge or enable auto-merge. If signing or GitHub access is unavailable, stop at `LOCAL_VERIFICATION` and report the exact blocker. Preserve the worktree for diagnosis; do not delete or automatically reuse it.
