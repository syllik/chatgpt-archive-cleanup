# ChatGPT Archive Cleanup Implementation Plan

> **For agentic workers:** This plan is executed inline in the current session because the user requested implementation only and explicitly forbade commit/push. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local standalone TypeScript/Node CLI for safe, discovery-driven ChatGPT/Codex conversation archiving with dry-run as the default.

**Architecture:** Use a page-context CDP browser adapter, a bounded redacted discovery config, pure normalization/filtering/project-protection helpers, and a serial archive workflow guarded by one central firewall. All live operations are injectable behind small interfaces so tests use fixtures and fake adapters.

**Tech Stack:** Node 22, TypeScript, `playwright-core`, Vitest, `tsx`, ESLint.

**Spec:** `docs/superpowers/specs/2026-09-02-chatgpt-archive-cleanup-design.md`

## Global Constraints

- Runtime target: `Node 22.23.2`.
- CDP default: `http://127.0.0.1:9222`.
- Page origin must be exactly `https://chatgpt.com`.
- Default cutoff: `2026-06-02T18:10:00+07:00`.
- `UNKNOWN => SKIP`.
- `dry-run` and `discover` must execute zero mutations.
- `execute` requires `--confirm-archive` and concurrency is `1`.
- HTTP `DELETE`, bulk archive/delete, project/membership/move/title/content mutations, and `~/.codex` access are forbidden.
- Persist only redacted config and metadata-only manifests under `~/.local/state/chatgpt-archive-cleanup/`.
- Never commit or push.

---

### Task 1: Project scaffolding and pure safety/date contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `src/types.ts`
- Create: `src/safety.ts`
- Create: `src/filter.ts`
- Test: `test/filter.test.ts`
- Test: `test/safety.test.ts`

**Interfaces:**
- Produces `ProjectStatus`, `ConversationKind`, `NormalizedConversation`, `ManifestEntry`, `DiscoveryConfig`, `MutationRequest`, `FatalSafetyError`, `assertSafeMutation`, `classifyConversations`, and `DEFAULT_CUTOFF` for later tasks.

- [x] **Step 1: Write failing filter and safety tests** covering before/equal/after cutoff, missing/malformed date, confirmed project, unknown project, archived, and the two forbidden firewall cases.
- [x] **Step 2: Run `npm test -- --run test/filter.test.ts test/safety.test.ts` and verify failure because source contracts are absent.**
- [x] **Step 3: Implement the minimal strict predicate, conservative duplicate merge, manifest classification, and central firewall.**
- [x] **Step 4: Run the focused tests and verify they pass.**
- [x] **Step 5: Run `npm run typecheck` and `npm run lint` for the new contracts.**

### Task 2: Complete pagination and project protection

**Files:**
- Create: `src/api.ts`
- Create: `src/inventory.ts`
- Create: `src/projects.ts`
- Test: `test/inventory.test.ts`
- Test: `test/projects.test.ts`

**Interfaces:**
- Consumes `Operation`, `NormalizedConversation`, and safety contracts from Task 1.
- Produces `PageFetcher`, `paginateOperation`, `loadConversationInventory`, `ProjectInventory`, and `buildProjectProtectedSet`.

- [x] **Step 1: Write failing fixture tests for offset pagination, cursor pagination, duplicate IDs, complete project protected IDs, and incomplete project scans.**
- [x] **Step 2: Run the focused tests and verify they fail for missing pagination/project functions.**
- [x] **Step 3: Implement URL-template substitution, safe query construction, repeated-cursor detection, full page traversal, conservative normalization, and project-set collection.**
- [x] **Step 4: Run the focused tests and verify all pages are combined and incomplete protection cannot confirm non-project status.**
- [x] **Step 5: Run the full test suite and typecheck.**

### Task 3: Metadata-only manifests

**Files:**
- Create: `src/manifest.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes `ManifestEntry` and execute result types from `src/types.ts`.
- Produces `writeDryRunManifest`, `writeExecuteManifest`, and `stateDirectory`.

- [x] **Step 1: Write a failing test that writes a dry-run and execute manifest into a temporary state directory and asserts metadata-only fields, deterministic path shape, and rollback IDs.**
- [x] **Step 2: Run the focused test and verify it fails because manifest writers are absent.**
- [x] **Step 3: Implement atomic JSON writes without cookies, auth headers, tokens, message bodies, or raw request data.**
- [x] **Step 4: Run the focused test and verify it passes.**

### Task 4: CDP browser adapter and bounded discovery

**Files:**
- Create: `src/browser.ts`
- Create: `src/discovery.ts`
- Test: `test/discovery.test.ts`

**Interfaces:**
- Produces `BrowserSession`, `connectToChatGPT`, `discoverConfig`, `validateConfigAgainstPage`, `redactObservedUrl`, and `parseArchiveBundleEvidence`.
- Uses only same-origin page-context fetches and returns no cookies, headers, tokens, or raw bundle text to Node.

- [x] **Step 1: Write failing tests for exact origin rejection, redacted URL templates, list/project/archive evidence selection, ambiguous archive evidence blocking, and invalid schema blocking.**
- [x] **Step 2: Run the focused tests and verify the expected discovery failures.**
- [x] **Step 3: Implement CDP connection/disconnect, existing-page selection, performance/request observation, page-context JSON fetch, same-origin checks, transient bundle scanning, evidence redaction, and schema validation.**
- [x] **Step 4: Run focused discovery tests and verify they pass without a live browser.**

### Task 5: Archive workflow with canary and drift guards

**Files:**
- Create: `src/archive.ts`
- Test: `test/archive.test.ts`

**Interfaces:**
- Consumes `InventorySource`, `ProjectInventory`, `ArchiveTransport`, `assertSafeMutation`, and filter/manifest contracts.
- Produces `executeArchive`, `ArchiveRunResult`, canary verification, serial revalidation, and stop-on-failure behavior.

- [x] **Step 1: Write failing tests for zero mutation without confirmation, canary failure preventing batch, project-set drift aborting, execute-time revalidation, and successful serial archive verification.**
- [x] **Step 2: Run the focused tests and verify they fail before workflow implementation.**
- [x] **Step 3: Implement fresh inventory, deterministic candidate selection, canary re-fetch, project-set equality guard, firewall invocation, archive verification, and metadata-only result recording.**
- [x] **Step 4: Run the focused tests and verify failure paths stop before the next mutation.**

### Task 6: CLI wiring and read-only default

**Files:**
- Create: `src/cli.ts`
- Modify: `package.json`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes all previous modules and exposes `npm run archive -- discover|dry-run|execute [flags]`.

- [x] **Step 1: Write failing CLI tests for no subcommand/help, `--help`, and `execute` without `--confirm-archive` with zero transport mutations.**
- [x] **Step 2: Run the focused tests and verify they fail because CLI dispatch is absent.**
- [x] **Step 3: Implement argument parsing, default cutoff/CDP, state-directory handling, readable summaries, exit codes, and command wiring.**
- [x] **Step 4: Run the focused tests and verify they pass.**
- [x] **Step 5: Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run archive -- --help`; verify no live archive/cleanup command was run.**

## Self-review checklist

- Date boundary, every skip reason, project protection, duplicate safety, pagination, discovery blocking, firewall, canary, drift, revalidation, confirmation guard, manifest privacy, and read-only default each have a named test or explicit validation step.
- No plan step depends on an undefined function; all cross-task interfaces are listed above.
- No credentials, raw request data, message bodies, or filesystem deletion are part of the design.
