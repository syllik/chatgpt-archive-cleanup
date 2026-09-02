import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";
import { writeDiscoveryConfig } from "../src/manifest.js";
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
});
