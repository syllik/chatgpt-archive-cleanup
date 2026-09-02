import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeDryRunManifest, writeExecuteManifest } from "../src/manifest.js";
import type { ManifestEntry } from "../src/types.js";

const entry: ManifestEntry = {
  id: "conversation-1",
  kind: "chatgpt",
  title: "Metadata only",
  lastActivity: "2026-06-01T00:00:00Z",
  projectStatus: "CONFIRMED_NON_PROJECT",
  action: "candidate"
};

describe("manifest writers", () => {
  it("writes a deterministic dry-run manifest without bodies or request secrets", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-manifest-"));
    const createdAt = new Date("2026-09-02T12:34:56.000Z");

    const path = await writeDryRunManifest(stateDir, "2026-06-02T18:10:00+07:00", [entry], createdAt);
    const raw = await readFile(path, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;

    expect(path).toMatch(/runs\/2026-09-02T12-34-56-000Z-dry-run\.json$/);
    expect(manifest).toEqual({
      schema: 1,
      kind: "dry-run",
      createdAt: "2026-09-02T12:34:56.000Z",
      cutoff: "2026-06-02T18:10:00+07:00",
      mutationsExecuted: 0,
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
});
