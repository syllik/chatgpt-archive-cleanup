import { describe, expect, it } from "vitest";
import { executeArchive, ArchiveAbortedError, type ArchiveSnapshot, type ArchiveTransport, type InventorySource } from "../src/archive.js";
import type { ExecutionJournal, JournalState, NormalizedConversation } from "../src/types.js";

const candidate = (id: string): NormalizedConversation => ({
  id,
  kind: "chatgpt",
  title: id,
  archived: false,
  lastActivity: "2026-06-01T00:00:00Z",
  projectStatus: "CONFIRMED_NON_PROJECT"
});

const duplicate = (id: string, overrides: Partial<NormalizedConversation> = {}): NormalizedConversation => ({
  ...candidate(id),
  ...overrides
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

  public constructor(
    private readonly verification: boolean | ((id: string) => boolean) = true,
    private readonly events: string[] = [],
    private readonly errorAfterSend: Error | null = null
  ) {}

  public async archive(item: NormalizedConversation): Promise<unknown> {
    this.archived.push(item.id);
    this.events.push(`transport:${item.id}`);
    if (this.errorAfterSend !== null) {
      throw this.errorAfterSend;
    }
    return { archived: true };
  }

  public async verify(item: NormalizedConversation): Promise<boolean> {
    return typeof this.verification === "function" ? this.verification(item.id) : this.verification;
  }
}

class RecordingJournal implements ExecutionJournal {
  public readonly transitions: Array<{ id: string; state: JournalState; at: string }> = [];

  public constructor(
    private readonly events: string[] = [],
    private readonly failOn: JournalState | null = null
  ) {}

  public async record(item: Pick<NormalizedConversation, "id" | "kind">, state: JournalState, at: string): Promise<void> {
    this.events.push(`journal:${state}:${item.id}`);
    if (state === this.failOn) {
      throw new Error("journal write failed");
    }
    this.transitions.push({ id: item.id, state, at });
  }
}

describe("executeArchive", () => {
  it("requires explicit confirmation before reading or mutating", async () => {
    const inventory = new SequenceInventory([snapshot([candidate("one")])]);
    const transport = new RecordingTransport();
    const journal = new RecordingJournal();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: false,
      inventory,
      transport,
      journal
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
    const journal = new RecordingJournal();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
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
    const journal = new RecordingJournal();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
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
    const journal = new RecordingJournal();

    const result = await executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    });

    expect(transport.archived).toEqual(["one", "two"]);
    expect(result.results.map((item) => item.id)).toEqual(["one", "two"]);
    expect(inventory.calls).toBe(4);
  });

  it("rejects a candidate that became new before the canary mutation", async () => {
    const refreshed = snapshot([{ ...candidate("one"), lastActivity: "2026-06-03T00:00:00Z" }]);
    const guardedInventory = new SequenceInventory([snapshot([candidate("one")]), refreshed]);
    const transport = new RecordingTransport();
    const journal = new RecordingJournal();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory: guardedInventory,
      transport,
      journal
    })).rejects.toThrow(/canary/i);

    expect(transport.archived).toEqual([]);
    expect(guardedInventory.calls).toBe(2);
  });

  it.each([
    ["old duplicate followed by newer duplicate", [candidate("one"), duplicate("one", { lastActivity: "2026-06-03T00:00:00Z" })]],
    ["newer duplicate followed by old duplicate", [duplicate("one", { lastActivity: "2026-06-03T00:00:00Z" }), candidate("one")]],
    ["active duplicate plus archived duplicate", [candidate("one"), duplicate("one", { archived: true })]],
    ["non-project duplicate plus Project duplicate", [candidate("one"), duplicate("one", { projectStatus: "CONFIRMED_PROJECT" })]]
  ])("does not mutate when canary records conflict: %s", async (_name, duplicates) => {
    const inventory = new SequenceInventory([
      snapshot([candidate("one")]),
      snapshot(duplicates)
    ]);
    const transport = new RecordingTransport();
    const journal = new RecordingJournal();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    })).rejects.toThrow(/canary/i);

    expect(transport.archived).toEqual([]);
  });

  it.each([
    ["old duplicate followed by newer duplicate", [candidate("two"), duplicate("two", { lastActivity: "2026-06-03T00:00:00Z" })]],
    ["newer duplicate followed by old duplicate", [duplicate("two", { lastActivity: "2026-06-03T00:00:00Z" }), candidate("two")]],
    ["active duplicate plus archived duplicate", [candidate("two"), duplicate("two", { archived: true })]],
    ["non-project duplicate plus Project duplicate", [candidate("two"), duplicate("two", { projectStatus: "CONFIRMED_PROJECT" })]]
  ])("does not mutate a conflicting later batch item: %s", async (_name, duplicates) => {
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), ...duplicates])
    ]);
    const transport = new RecordingTransport();
    const journal = new RecordingJournal();

    const result = await executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    });

    expect(transport.archived).toEqual(["one"]);
    expect(result.results.map((item) => item.id)).toEqual(["one"]);
  });

  it("records pending before transport invocation", async () => {
    const events: string[] = [];
    const journal = new RecordingJournal(events);
    const inventory = new SequenceInventory([
      snapshot([candidate("one")]),
      snapshot([candidate("one")])
    ]);
    const transport = new RecordingTransport(true, events);

    await executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    });

    expect(events.slice(0, 2)).toEqual(["journal:pending:one", "transport:one"]);
  });

  it("does not invoke transport when pending journal write fails", async () => {
    const journal = new RecordingJournal([], "pending");
    const inventory = new SequenceInventory([
      snapshot([candidate("one")]),
      snapshot([candidate("one")])
    ]);
    const transport = new RecordingTransport();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    })).rejects.toBeInstanceOf(ArchiveAbortedError);

    expect(transport.archived).toEqual([]);
  });

  it("records an ambiguous side effect and stops after transport throws", async () => {
    const journal = new RecordingJournal();
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")])
    ]);
    const transport = new RecordingTransport(true, [], new Error("connection lost after send"));

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    })).rejects.toThrow(/archive|ambiguous|connection/i);

    expect(transport.archived).toEqual(["one"]);
    expect(journal.transitions.map((entry) => entry.state)).toEqual(["pending", "ambiguous"]);
    expect(JSON.stringify(journal.transitions)).not.toContain("connection lost after send");
  });

  it("records verification failure as ambiguous and stops the batch", async () => {
    const journal = new RecordingJournal();
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")])
    ]);
    const transport = new RecordingTransport(false);

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    })).rejects.toThrow(/verification/i);

    expect(transport.archived).toEqual(["one"]);
    expect(journal.transitions.map((entry) => entry.state)).toEqual([
      "pending",
      "awaiting-verification",
      "ambiguous"
    ]);
  });

  it("records successful canary and batch items as verified", async () => {
    const journal = new RecordingJournal();
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("two")])
    ]);
    const transport = new RecordingTransport();

    await executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    });

    expect(journal.transitions.map((entry) => `${entry.id}:${entry.state}`)).toEqual([
      "one:pending",
      "one:awaiting-verification",
      "one:verified",
      "two:pending",
      "two:awaiting-verification",
      "two:verified"
    ]);
  });

  it("stops before the next mutation when verified state cannot be persisted", async () => {
    const journal = new RecordingJournal([], "verified");
    const inventory = new SequenceInventory([
      snapshot([candidate("one"), candidate("two")]),
      snapshot([candidate("one"), candidate("two")])
    ]);
    const transport = new RecordingTransport();

    await expect(executeArchive({
      cutoff: "2026-06-02T18:10:00+07:00",
      confirmArchive: true,
      inventory,
      transport,
      journal
    })).rejects.toThrow(/verified|ambiguous/i);

    expect(transport.archived).toEqual(["one"]);
    expect(journal.transitions.map((entry) => entry.state)).toEqual([
      "pending",
      "awaiting-verification",
      "ambiguous"
    ]);
  });
});
