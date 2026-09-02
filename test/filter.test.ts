import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUTOFF,
  classifyConversations,
  type NormalizedConversation
} from "../src/filter.js";

const base = (overrides: Partial<NormalizedConversation> = {}): NormalizedConversation => ({
  id: "conversation-1",
  kind: "chatgpt",
  title: "Old conversation",
  archived: false,
  lastActivity: "2026-06-02T18:09:59+07:00",
  projectStatus: "CONFIRMED_NON_PROJECT",
  ...overrides
});

describe("classifyConversations", () => {
  it("selects only active confirmed non-project conversations strictly before the cutoff", () => {
    const result = classifyConversations([
      base(),
      base({ id: "equal", lastActivity: DEFAULT_CUTOFF }),
      base({ id: "new", lastActivity: "2026-06-02T18:10:01+07:00" })
    ], DEFAULT_CUTOFF);

    expect(result.candidates.map((item) => item.id)).toEqual(["conversation-1"]);
    expect(result.entries.find((item) => item.id === "equal")?.action).toBe("skip-new");
    expect(result.entries.find((item) => item.id === "new")?.action).toBe("skip-new");
  });

  it.each([
    ["project", base({ projectStatus: "CONFIRMED_PROJECT" }), "skip-project"],
    ["unknown project status", base({ projectStatus: "UNKNOWN" }), "skip-unknown"],
    ["missing activity", base({ lastActivity: null }), "skip-invalid-date"],
    ["malformed activity", base({ lastActivity: "not-a-date" }), "skip-invalid-date"],
    ["already archived", base({ archived: true }), "skip-archived"]
  ])("skips %s conservatively", (_name, item, action) => {
    const result = classifyConversations([item], DEFAULT_CUTOFF);

    expect(result.candidates).toEqual([]);
    expect(result.entries[0]?.action).toBe(action);
  });

  it("deduplicates conflicting IDs by preserving the least-eligible metadata", () => {
    const result = classifyConversations([
      base({ title: "candidate copy" }),
      base({ archived: true, projectStatus: "CONFIRMED_NON_PROJECT", title: "archived copy" })
    ], DEFAULT_CUTOFF);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: "conversation-1",
      title: "candidate copy",
      action: "skip-archived"
    });
    expect(result.candidates).toEqual([]);
  });
});
