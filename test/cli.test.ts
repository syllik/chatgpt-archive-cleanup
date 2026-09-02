import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";
import {
  assertNoUnresolvedJournals,
  createExecutionJournal,
  fingerprintAccountContext,
  fingerprintDiscoveryConfig,
  writeDiscoveryConfig,
  writeDryRunManifest
} from "../src/manifest.js";
import type { CliSession } from "../src/cli.js";
import type { DiscoveryConfig } from "../src/types.js";

function dependencies(): CliDependencies & { connected: number } {
  return {
    connected: 0,
    connect: async () => {
      throw new Error("browser must not be connected");
    },
    write: () => undefined
  };
}

const config: DiscoveryConfig = {
  schema: 1,
  discoveredAt: "2026-09-02T00:00:00.000Z",
  origin: "https://chatgpt.com",
  operations: {
    listConversations: [{
      method: "GET",
      pathTemplate: "/api/conversations",
      queryKeys: ["limit"],
      pagination: "none",
      pageSize: 100,
      response: { itemsPath: "items", nextCursorPath: null, hasMorePath: "hasMore" },
      fields: {
        idPath: "id",
        titlePath: "title",
        archivedPath: "archived",
        lastActivityPath: "updatedAt",
        projectIdPath: null
      },
      kind: "chatgpt"
    }],
    listProjects: {
      method: "GET",
      pathTemplate: "/api/projects",
      queryKeys: ["limit"],
      pagination: "none",
      pageSize: 100,
      response: { itemsPath: "items", nextCursorPath: null, hasMorePath: "hasMore" },
      projectIdPath: "id"
    },
    listProjectConversations: {
      method: "GET",
      pathTemplate: "/api/projects/{projectId}/conversations",
      queryKeys: ["limit"],
      pagination: "none",
      pageSize: 100,
      response: { itemsPath: "items", nextCursorPath: null, hasMorePath: "hasMore" },
      fields: {
        idPath: "id",
        titlePath: null,
        archivedPath: null,
        lastActivityPath: null,
        projectIdPath: null
      },
      kind: "chatgpt",
      projectIdParam: "path"
    },
    archiveConversation: {
      method: "PATCH",
      pathTemplate: "/api/conversation/{id}",
      queryKeys: [],
      bodyKey: "is_archived",
      responseArchivedPath: null
    }
  }
};

const conversation = (id: string, overrides: {
  archived?: boolean;
  lastActivity?: string;
} = {}) => ({
  id,
  title: id,
  archived: overrides.archived ?? false,
  updatedAt: overrides.lastActivity ?? "2026-06-01T00:00:00Z"
});

const manifestEntry = (id: string, overrides: Partial<{
  action: "candidate" | "skip-project" | "skip-unknown" | "skip-new" | "skip-invalid-date" | "skip-archived";
  lastActivity: string | null;
  projectStatus: "CONFIRMED_PROJECT" | "CONFIRMED_NON_PROJECT" | "UNKNOWN";
}> = {}) => ({
  id,
  kind: "chatgpt" as const,
  title: id,
  lastActivity: overrides.lastActivity ?? "2026-06-01T00:00:00Z",
  projectStatus: overrides.projectStatus ?? "CONFIRMED_NON_PROJECT" as const,
  action: overrides.action ?? "candidate" as const
});

function fakeSession(
  rawItems: Array<{ id: string; title: string; archived: boolean; updatedAt: string }>,
  protectedIds: string[] = [],
  account: string | undefined = undefined
): { session: CliSession; archiveCalls: string[] } {
  const archived = new Set<string>();
  const archiveCalls: string[] = [];
  const session: CliSession = {
    pageUrl: () => "https://chatgpt.com/c/example",
    observeRequests: async () => [
      { method: "GET", url: "https://chatgpt.com/api/conversations?limit=100" },
      { method: "GET", url: "https://chatgpt.com/api/projects?limit=100" },
      { method: "GET", url: "https://chatgpt.com/api/projects/project-a/conversations?limit=100" }
    ],
    inspectArchiveBundle: async () => [{
      method: "PATCH",
      pathTemplate: "/api/conversation/{id}",
      bodyKey: "is_archived"
    }],
    fetchUrl: async () => null,
    fetchOperation: async (operation) => {
      if (operation.pathTemplate === "/api/conversations") {
        return {
          items: rawItems.filter((item) => !archived.has(item.id)),
          hasMore: false
        };
      }
      if (operation.pathTemplate === "/api/projects") {
        return {
          items: protectedIds.length === 0 ? [] : [{ id: "project-a" }],
          hasMore: false
        };
      }
      return { items: protectedIds.map((id) => ({ id })), hasMore: false };
    },
    archiveConversation: async (_operation, id) => {
      archiveCalls.push(id);
      archived.add(id);
      return { is_archived: true };
    },
    ...(account === undefined ? {} : { accountFingerprint: async () => account }),
    disconnect: async () => undefined
  };
  return { session, archiveCalls };
}

async function reviewedManifest(
  entries: ReturnType<typeof manifestEntry>[],
  accountFingerprint: string | null = null
): Promise<{ stateDir: string; path: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-reviewed-cli-"));
  await writeDiscoveryConfig(stateDir, config);
  const path = await writeDryRunManifest(
    stateDir,
    "2026-06-02T18:10:00+07:00",
    entries,
    new Date("2026-09-02T12:34:56.000Z"),
    {
      origin: "https://chatgpt.com",
      discoveryConfigFingerprint: fingerprintDiscoveryConfig(config),
      accountFingerprint
    }
  );
  return { stateDir, path };
}

describe("CLI safety defaults", () => {
  it("prints help and performs no browser work with no subcommand", async () => {
    const deps = dependencies();

    const result = await runCli([], deps);

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/discover|dry-run|execute/);
    expect(deps.connected).toBe(0);
  });

  it("prints help for --help without connecting to CDP", async () => {
    const deps = dependencies();

    const result = await runCli(["--help"], deps);

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/--confirm-archive/);
    expect(deps.connected).toBe(0);
  });

  it("rejects execute without confirmation before connecting or mutating", async () => {
    const deps = dependencies();

    const result = await runCli(["execute"], deps);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/confirm-archive/);
    expect(deps.connected).toBe(0);
  });

  it("rejects confirmed execute without an explicit reviewed dry-run manifest before connecting", async () => {
    let connected = 0;
    const deps: CliDependencies = {
      connect: async () => {
        connected += 1;
        throw new Error("browser must not be connected");
      },
      write: () => undefined
    };

    const result = await runCli(["execute", "--confirm-archive"], deps);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/dry-run-manifest|reviewed/i);
    expect(connected).toBe(0);
  });

  it("blocks execute on an unresolved prior journal before connecting", async () => {
    const reviewed = await reviewedManifest([manifestEntry("old")]);
    const journal = await createExecutionJournal(reviewed.stateDir, new Date("2026-09-02T12:35:00.000Z"));
    await journal.record({ id: "old", kind: "chatgpt" }, "pending", "2026-09-02T12:35:01.000Z");
    let connected = 0;
    const deps: CliDependencies = {
      connect: async () => {
        connected += 1;
        throw new Error("browser must not be connected");
      },
      write: () => undefined
    };

    const result = await runCli([
      "execute",
      "--confirm-archive",
      "--dry-run-manifest",
      reviewed.path,
      "--state-dir",
      reviewed.stateDir
    ], deps);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/journal|invalid|review/i);
    expect(connected).toBe(0);
  });

  it("runs dry-run without calling the archive transport", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chatgpt-archive-cli-"));
    await writeDiscoveryConfig(stateDir, config);
    let archiveCalls = 0;
    let disconnected = false;
    const session: CliSession = {
      pageUrl: () => "https://chatgpt.com/c/example",
      observeRequests: async () => [
        { method: "GET", url: "https://chatgpt.com/api/conversations?limit=100" },
        { method: "GET", url: "https://chatgpt.com/api/projects?limit=100" },
        { method: "GET", url: "https://chatgpt.com/api/projects/project-a/conversations?limit=100" }
      ],
      inspectArchiveBundle: async () => [{
        method: "PATCH",
        pathTemplate: "/api/conversation/{id}",
        bodyKey: "is_archived"
      }],
      fetchUrl: async () => null,
      fetchOperation: async (operation) => operation.pathTemplate === "/api/conversations"
        ? { items: [{ id: "old", title: "Old", archived: false, updatedAt: "2026-06-01T00:00:00Z" }], hasMore: false }
        : { items: [], hasMore: false },
      archiveConversation: async () => {
        archiveCalls += 1;
        return { is_archived: true };
      },
      disconnect: async () => {
        disconnected = true;
      }
    };
    const deps: CliDependencies = {
      connect: async () => session,
      write: () => undefined
    };

    const result = await runCli(["dry-run", "--state-dir", stateDir], deps);

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/Mutations executed: 0/);
    expect(archiveCalls).toBe(0);
    expect(disconnected).toBe(true);
  });

  it("rejects a cutoff mismatch before connecting", async () => {
    const reviewed = await reviewedManifest([manifestEntry("old")]);
    let connected = 0;
    const deps: CliDependencies = {
      connect: async () => {
        connected += 1;
        throw new Error("browser must not be connected");
      },
      write: () => undefined
    };

    const result = await runCli([
      "execute",
      "--confirm-archive",
      "--dry-run-manifest",
      reviewed.path,
      "--cutoff",
      "2026-06-03T18:10:00+07:00",
      "--state-dir",
      reviewed.stateDir
    ], deps);

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/reviewed|cutoff/i);
    expect(connected).toBe(0);
  });

  it("rejects a fresh candidate-set addition before archive transport", async () => {
    const reviewed = await reviewedManifest([manifestEntry("old")]);
    const fake = fakeSession([conversation("old"), conversation("extra")]);
    const deps: CliDependencies = {
      connect: async () => fake.session,
      write: () => undefined
    };

    const result = await runCli([
      "execute",
      "--confirm-archive",
      "--dry-run-manifest",
      reviewed.path,
      "--state-dir",
      reviewed.stateDir
    ], deps);

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/match|safety|reviewed/i);
    expect(fake.archiveCalls).toEqual([]);
  });

  it("rejects fresh Project-status drift before archive transport", async () => {
    const reviewed = await reviewedManifest([manifestEntry("old")]);
    const fake = fakeSession([conversation("old")], ["old"]);
    const deps: CliDependencies = {
      connect: async () => fake.session,
      write: () => undefined
    };

    const result = await runCli([
      "execute",
      "--confirm-archive",
      "--dry-run-manifest",
      reviewed.path,
      "--state-dir",
      reviewed.stateDir
    ], deps);

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/match|safety|reviewed/i);
    expect(fake.archiveCalls).toEqual([]);
  });

  it("rejects fresh duplicate-conflict drift before archive transport", async () => {
    const reviewed = await reviewedManifest([manifestEntry("old")]);
    const fake = fakeSession([
      conversation("old"),
      conversation("old", { lastActivity: "2026-06-03T00:00:00Z" })
    ]);
    const deps: CliDependencies = {
      connect: async () => fake.session,
      write: () => undefined
    };

    const result = await runCli([
      "execute",
      "--confirm-archive",
      "--dry-run-manifest",
      reviewed.path,
      "--state-dir",
      reviewed.stateDir
    ], deps);

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/match|safety|reviewed/i);
    expect(fake.archiveCalls).toEqual([]);
  });

  it("rejects an account fingerprint mismatch before archive transport", async () => {
    const reviewed = await reviewedManifest([manifestEntry("old")], fingerprintAccountContext("reviewed-account"));
    const fake = fakeSession([conversation("old")], [], "different-account");
    const deps: CliDependencies = {
      connect: async () => fake.session,
      write: () => undefined
    };

    const result = await runCli([
      "execute",
      "--confirm-archive",
      "--dry-run-manifest",
      reviewed.path,
      "--state-dir",
      reviewed.stateDir
    ], deps);

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/fingerprint|account|workspace/i);
    expect(fake.archiveCalls).toEqual([]);
  });

  it("keeps exact reviewed inventory execution serial and verified", async () => {
    const reviewed = await reviewedManifest([manifestEntry("one"), manifestEntry("two")]);
    const fake = fakeSession([conversation("one"), conversation("two")]);
    const deps: CliDependencies = {
      connect: async () => fake.session,
      write: () => undefined
    };

    const result = await runCli([
      "execute",
      "--confirm-archive",
      "--dry-run-manifest",
      reviewed.path,
      "--state-dir",
      reviewed.stateDir
    ], deps);

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/Execute complete/);
    expect(fake.archiveCalls).toEqual(["one", "two"]);
    await expect(assertNoUnresolvedJournals(reviewed.stateDir)).resolves.toBeUndefined();
  });
});
