import { describe, expect, it } from "vitest";
import { loadConversationInventory, paginateOperation, type PageFetcher } from "../src/inventory.js";
import type { ConversationListOperation } from "../src/types.js";

const operation: ConversationListOperation = {
  method: "GET",
  pathTemplate: "/backend-api/conversations",
  queryKeys: ["cursor", "limit"],
  pagination: "cursor",
  pageSize: 2,
  response: {
    itemsPath: "items",
    nextCursorPath: "nextCursor",
    hasMorePath: "hasMore"
  },
  fields: {
    idPath: "id",
    titlePath: "title",
    archivedPath: "archived",
    lastActivityPath: "updatedAt",
    projectIdPath: null
  },
  kind: "chatgpt"
};

describe("paginateOperation", () => {
  it("combines every offset page and stops after a short final page", async () => {
    const offsetOperation: ConversationListOperation = {
      ...operation,
      queryKeys: ["offset", "limit"],
      pagination: "offset"
    };
    const seenQueries: Record<string, string>[] = [];
    const fetchPage: PageFetcher = async (_operation, query) => {
      seenQueries.push({ ...query });
      return query.offset === "0"
        ? { items: [{ id: "one" }, { id: "two" }], hasMore: true }
        : { items: [{ id: "three" }], hasMore: false };
    };

    const records = await paginateOperation(offsetOperation, fetchPage);

    expect(records).toEqual([{ id: "one" }, { id: "two" }, { id: "three" }]);
    expect(seenQueries).toEqual([
      { offset: "0", limit: "2" },
      { offset: "2", limit: "2" }
    ]);
  });

  it("combines every cursor page and advances with the discovered cursor key", async () => {
    const seenQueries: Record<string, string>[] = [];
    const fetchPage: PageFetcher = async (_operation, query) => {
      seenQueries.push({ ...query });
      if (query.cursor === undefined) {
        return { items: [{ id: "one" }, { id: "two" }], nextCursor: "page-2", hasMore: true };
      }
      return { items: [{ id: "three" }], nextCursor: null, hasMore: false };
    };

    const records = await paginateOperation(operation, fetchPage);

    expect(records).toEqual([{ id: "one" }, { id: "two" }, { id: "three" }]);
    expect(seenQueries).toEqual([
      { limit: "2" },
      { cursor: "page-2", limit: "2" }
    ]);
  });

  it("fails closed when the server repeats a cursor", async () => {
    const fetchPage: PageFetcher = async () => ({
      items: [{ id: "one" }],
      nextCursor: "same",
      hasMore: true
    });

    await expect(paginateOperation(operation, fetchPage)).rejects.toThrow(/repeated pagination cursor/);
  });
});

describe("loadConversationInventory", () => {
  it("normalizes discovered fields and keeps malformed activity as null", async () => {
    const fetchPage: PageFetcher = async () => ({
      items: [
        { id: "one", title: "One", archived: false, updatedAt: "2026-06-01T00:00:00Z" },
        { id: "bad", title: "Bad", archived: false, updatedAt: 123 }
      ],
      hasMore: false
    });

    const records = await loadConversationInventory([operation], fetchPage);

    expect(records).toEqual([
      {
        id: "one",
        kind: "chatgpt",
        title: "One",
        archived: false,
        lastActivity: "2026-06-01T00:00:00Z",
        projectStatus: "UNKNOWN"
      },
      {
        id: "bad",
        kind: "chatgpt",
        title: "Bad",
        archived: false,
        lastActivity: null,
        projectStatus: "UNKNOWN"
      }
    ]);
  });
});
