import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReviewedEntriesMatch,
  assertNoUnresolvedJournals,
  createExecutionJournal,
  fingerprintAccountContext,
  fingerprintDiscoveryConfig,
  readReviewedDryRunManifest,
  writeDryRunManifest,
  writeExecuteManifest
} from "../src/manifest.js";
import type { DryRunManifestProvenance, ManifestEntry } from "../src/types.js";

const entry: ManifestEntry = {
  id: "conversation-1",
  kind: "chatgpt",
  title: "Metadata only",
  lastActivity: "2026-06-01T00:00:00Z",
  projectStatus: "CONFIRMED_NON_PROJECT",
  action: "candidate"
};

const provenance: DryRunManifestProvenance = {
  origin: "https://chatgpt.com",
  discoveryConfigFingerprint: "a".repeat(64),
  accountFingerprint: null
};

describe("manifest writers", () => {
  it("writes a deterministic dry-run manifest without bodies or request secrets", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-manifest-"));
    const createdAt = new Date("2026-09-02T12:34:56.000Z");

    const path = await writeDryRunManifest(stateDir, "2026-06-02T18:10:00+07:00", [entry], createdAt, provenance);
    const raw = await readFile(path, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;

    expect(path).toMatch(/runs\/2026-09-02T12-34-56-000Z-dry-run\.json$/);
    expect(manifest).toEqual({
      schema: 2,
      kind: "dry-run",
      createdAt: "2026-09-02T12:34:56.000Z",
      readOnly: true,
      cutoff: "2026-06-02T18:10:00+07:00",
      mutationsExecuted: 0,
      provenance,
      entries: [entry]
    });
    expect(raw).not.toMatch(/message|cookie|authorization|token|body/i);
  });

  it("writes execute rollback IDs with the previous archive state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-manifest-"));
    const result = {
      id: "conversation-1",
      kind: "chatgpt" as const,
      previousArchived: false as const,
      archivedAt: "2026-09-02T12:34:56.000Z"
    };

    const path = await writeExecuteManifest(
      stateDir,
      "2026-06-02T18:10:00+07:00",
      [result],
      new Date("2026-09-02T12:34:56.000Z")
    );
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    expect(manifest).toEqual({
      schema: 1,
      kind: "execute",
      createdAt: "2026-09-02T12:34:56.000Z",
      cutoff: "2026-06-02T18:10:00+07:00",
      mutationsExecuted: 1,
      results: [result]
    });
  });

  it("writes a private metadata-only journal with durable state transitions", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "chatgpt-archive-journal-"));
    const stateDir = join(temporaryRoot, "state");
    const createdAt = new Date("2026-09-02T12:34:56.000Z");
    const journal = await createExecutionJournal(stateDir, createdAt);

    await journal.record({ id: "conversation-1", kind: "chatgpt" }, "pending", "2026-09-02T12:34:57.000Z");
    await journal.record({ id: "conversation-1", kind: "chatgpt" }, "awaiting-verification", "2026-09-02T12:34:58.000Z");
    await journal.record({ id: "conversation-1", kind: "chatgpt" }, "verified", "2026-09-02T12:34:59.000Z");

    const journalDirectory = join(stateDir, "journals");
    const journalNames = await readdir(journalDirectory);
    expect(journalNames).toHaveLength(1);
    const journalPath = join(journalDirectory, journalNames[0] as string);
    const raw = await readFile(journalPath, "utf8");
    expect(JSON.parse(raw)).toEqual({
      schema: 1,
      kind: "execute-journal",
      createdAt: createdAt.toISOString(),
      entries: [{
        id: "conversation-1",
        kind: "chatgpt",
        state: "verified",
        at: "2026-09-02T12:34:59.000Z"
      }]
    });
    expect(raw).not.toMatch(/message|cookie|authorization|token|header|title|response|error/i);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(journalDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
  });

  it("blocks a new journal while an earlier journal is unresolved", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-journal-"));
    const journal = await createExecutionJournal(stateDir, new Date("2026-09-02T12:34:56.000Z"));
    await journal.record({ id: "conversation-1", kind: "chatgpt" }, "pending", "2026-09-02T12:34:57.000Z");

    await expect(assertNoUnresolvedJournals(stateDir)).rejects.toThrow(/unresolved|journal/i);
    await expect(createExecutionJournal(stateDir, new Date("2026-09-02T12:35:00.000Z"))).rejects.toThrow(/unresolved|journal/i);
  });

  it("fails closed when an earlier journal cannot be parsed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-journal-"));
    const journalDirectory = join(stateDir, "journals");
    await writeFile(join(stateDir, "placeholder"), "state");
    await createExecutionJournal(stateDir, new Date("2026-09-02T12:34:56.000Z"));
    const journalName = (await readdir(journalDirectory))[0] as string;
    await writeFile(join(journalDirectory, journalName), "not-json\n");

    await expect(assertNoUnresolvedJournals(stateDir)).rejects.toThrow(/unresolved|journal/i);
  });

  it("validates a reviewed read-only dry-run manifest and compares safety metadata", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-reviewed-"));
    const manifestPath = join(stateDir, "reviewed.json");
    await writeFile(manifestPath, JSON.stringify({
      schema: 2,
      kind: "dry-run",
      createdAt: "2026-09-02T12:34:56.000Z",
      readOnly: true,
      cutoff: "2026-06-02T18:10:00+07:00",
      mutationsExecuted: 0,
      provenance,
      entries: [entry]
    }));

    const reviewed = await readReviewedDryRunManifest(
      manifestPath,
      "2026-06-02T18:10:00+07:00",
      provenance.discoveryConfigFingerprint
    );

    expect(reviewed.entries).toEqual([entry]);
    expect(() => assertReviewedEntriesMatch(reviewed.entries, [entry])).not.toThrow();
    expect(() => assertReviewedEntriesMatch(reviewed.entries, [{
      ...entry,
      lastActivity: "2026-06-03T00:00:00Z"
    }])).toThrow(/reviewed|safety|mismatch/i);
    expect(() => assertReviewedEntriesMatch(reviewed.entries, [{
      ...entry,
      projectStatus: "CONFIRMED_PROJECT",
      action: "skip-project"
    }])).toThrow(/reviewed|safety|mismatch/i);
    expect(() => assertReviewedEntriesMatch(reviewed.entries, [entry, {
      ...entry,
      id: "conversation-2"
    }])).toThrow(/reviewed|safety|mismatch/i);
  });

  it("rejects a changed cutoff, config provenance, or non-read-only manifest", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-reviewed-"));
    const manifestPath = join(stateDir, "reviewed.json");
    const manifest = {
      schema: 2,
      kind: "dry-run",
      createdAt: "2026-09-02T12:34:56.000Z",
      readOnly: true,
      cutoff: "2026-06-02T18:10:00+07:00",
      mutationsExecuted: 0,
      provenance,
      entries: [entry]
    };

    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(readReviewedDryRunManifest(
      manifestPath,
      "2026-06-03T18:10:00+07:00",
      provenance.discoveryConfigFingerprint
    )).rejects.toThrow(/cutoff/i);

    await expect(readReviewedDryRunManifest(
      manifestPath,
      manifest.cutoff,
      "b".repeat(64)
    )).rejects.toThrow(/provenance|config/i);

    await writeFile(manifestPath, JSON.stringify({ ...manifest, readOnly: false }));
    await expect(readReviewedDryRunManifest(
      manifestPath,
      manifest.cutoff,
      provenance.discoveryConfigFingerprint
    )).rejects.toThrow(/invalid|read.only/i);
  });

  it("creates stable one-way fingerprints without exposing source identity", () => {
    const config = { schema: 1, origin: "https://chatgpt.com", operations: { b: 2, a: 1 } };
    const reordered = { operations: { a: 1, b: 2 }, origin: "https://chatgpt.com", schema: 1 };

    expect(fingerprintDiscoveryConfig(config)).toBe(fingerprintDiscoveryConfig(reordered));
    expect(fingerprintAccountContext("account@example.test")).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintAccountContext("account@example.test")).not.toContain("account@example.test");
  });

  it("rejects raw account context before writing a dry-run manifest", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-reviewed-"));

    await expect(writeDryRunManifest(
      stateDir,
      "2026-06-02T18:10:00+07:00",
      [entry],
      new Date("2026-09-02T12:34:56.000Z"),
      { ...provenance, accountFingerprint: "account@example.test" }
    )).rejects.toThrow(/provenance|fingerprint/i);
  });

  it("privates an existing permissive state root before writing", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "chatgpt-archive-state-"));
    const stateDir = join(temporaryRoot, "state");
    await mkdir(stateDir, { mode: 0o755 });
    await chmod(stateDir, 0o755);

    await writeExecuteManifest(stateDir, "2026-06-02T18:10:00+07:00", []);

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
  });
});
