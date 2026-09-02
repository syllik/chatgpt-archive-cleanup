import { describe, expect, it } from "vitest";
import { executeArchive, ArchiveAbortedError, type ArchiveSnapshot, type ArchiveTransport, type InventorySource } from "../src/archive.js";
import type { NormalizedConversation } from "../src/types.js";

const candidate = (id: string): NormalizedConversation => ({
  id,
  kind: "chatgpt",
  title: id,
  archived: false,
  lastActivity: "2026-06-01T00:00:00Z",
  projectStatus: "CONFIRMED_NON_PROJECT"
});

const snapshot = (items: NormalizedConversation[], protectedIds: string[] = []): ArchiveSnapshot => ({
  conversations: items,
  projectInventory: {
    protectedConversationIds: new Set(protectedIds),
    projectIds: new Set(["project-a"]),
    complete: true
  }
});

class SequenceInventory implements InventorySource {
  public calls = 0;

  public constructor(private readonly snapshots: ArchiveSnapshot[]) {}

  public async loadSnapshot(): Promise<ArchiveSnapshot> {
    const index = Math.min(this.calls, this.snapshots.length - 1);
    this.calls += 1;
    const result = this.snapshots[index];
    if (result === undefined) {
      throw new Error("missing test snapshot");
    }
    return result;
  }
}

class RecordingTransport implements ArchiveTransport {
  public archived: string[] = [];
  public readonly mutationMethod = "PATCH";

  public constructor(private readonly verification: boolean | ((id: string) => boolean) = true) {}

  public async archive(item: NormalizedConversation): Promise<unknown> {
    this.archived.push(item.id);
    return { archived: true };
  }

  public async verify(item: NormalizedConversation): Promise<boolean> {
    return typeof this.verification === "function" ? this.verification(item.id) : this.verification;
  }
}

describe("executeArchive", () => {
  it("requires explicit confirmation before reading or mutating", async () => {
    const inventory = new SequenceInventory([snapshot([candidate("one")])]);
    const transport = new RecordingTransport();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: false,
      inventory,
      transport
    })).rejects.toThrow(/confirm-archive/);

    expect(inventory.calls).toBe(0);
    expect(transport.archived).toEqual([]);
  });

  it("stops after a failed canary verification and never starts the batch", async () => {
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")])
    ]);
    const transport = new RecordingTransport(false);

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport
    })).rejects.toBeInstanceOf(ArchiveAbortedError);

    expect(transport.archived).toEqual(["one"]);
    expect(inventory.calls).toBe(2);
  });

  it("aborts before the next mutation when the protected Project set changes after canary", async () => {
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")], ["protected"]),
      snapshot([candidate("one"), candidate("two")], ["protected"]),
      snapshot([candidate("one"), candidate("two")], ["protected", "new-protected"])
    ]);
    const transport = new RecordingTransport();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport
    })).rejects.toThrow(/Project set changed/);

    expect(transport.archived).toEqual(["one"]);
  });

  it("revalidates each candidate from fresh inventory and archives serially", async () => {
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("two")])
    ]);
    const transport = new RecordingTransport();

    const result = await executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport
    });

    expect(transport.archived).toEqual(["one", "two"]);
    expect(result.results.map((item) => item.id)).toEqual(["one", "two"]);
    expect(inventory.calls).toBe(4);
  });

  it("rejects a candidate that became new before the canary mutation", async () => {
    const refreshed = snapshot([{ ...candidate("one"), lastActivity: "2026-06-03T00:00:00Z" }]);
    const guardedInventory = new SequenceInventory([snapshot([candidate("one")]), refreshed]);
    const transport = new RecordingTransport();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory: guardedInventory,
      transport
    })).rejects.toThrow(/canary/i);

    expect(transport.archived).toEqual([]);
    expect(guardedInventory.calls).toBe(2);
  });
});
