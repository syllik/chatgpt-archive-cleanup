import { chooseQueryKey, readPath, type PageFetcher } from "./api.js";
import { classifyConversations } from "./filter.js";
import type {
  ConversationFields,
  ConversationListOperation,
  NormalizedConversation,
  ProjectStatus
} from "./types.js";

const MAX_PAGES = 10_000;

function pageItems(payload: unknown, itemsPath: string): unknown[] {
  const items = readPath(payload, itemsPath);
  if (!Array.isArray(items)) {
    throw new Error("Invalid page: items are not an array");
  }
  return items;
}

function pageCursor(payload: unknown, cursorPath: string | null): string | null {
  if (cursorPath === null) {
    return null;
  }
  const cursor = readPath(payload, cursorPath);
  if (cursor === null || cursor === undefined || cursor === "") {
    return null;
  }
  if (typeof cursor !== "string") {
    throw new Error("Invalid page: next cursor is not a string");
  }
  return cursor;
}

function pageHasMore(payload: unknown, hasMorePath: string | null, itemsLength: number, pageSize: number): boolean {
  if (hasMorePath !== null) {
    const hasMore = readPath(payload, hasMorePath);
    if (typeof hasMore !== "boolean") {
      throw new Error("Invalid page: hasMore is not a boolean");
    }
    return hasMore;
  }
  return itemsLength >= pageSize && itemsLength > 0;
}

export async function paginateOperation(
  operation: ConversationListOperation,
  fetchPage: PageFetcher
): Promise<unknown[]>;
export async function paginateOperation(
  operation: Parameters<PageFetcher>[0],
  fetchPage: PageFetcher
): Promise<unknown[]>;
export async function paginateOperation(
  operation: Parameters<PageFetcher>[0],
  fetchPage: PageFetcher
): Promise<unknown[]> {
  const allItems: unknown[] = [];
  const offsetKey = chooseQueryKey(operation.queryKeys, ["offset", "start"]);
  const cursorKey = chooseQueryKey(operation.queryKeys, ["cursor", "next_cursor"]);
  const limitKey = chooseQueryKey(operation.queryKeys, ["limit", "page_size", "pageSize"]);
  const seenCursors = new Set<string>();
  let offset = 0;
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const query: Record<string, string> = {};
    if (limitKey !== null) {
      query[limitKey] = String(operation.pageSize);
    }
    if (operation.pagination === "offset" && offsetKey !== null) {
      query[offsetKey] = String(offset);
    }
    if (operation.pagination === "cursor" && cursorKey !== null && cursor !== null) {
      query[cursorKey] = cursor;
    }

    const payload = await fetchPage(operation, query);
    const items = pageItems(payload, operation.response.itemsPath);
    allItems.push(...items);

    if (operation.pagination === "none") {
      return allItems;
    }

    const nextCursor = pageCursor(payload, operation.response.nextCursorPath);
    const hasMore = pageHasMore(payload, operation.response.hasMorePath, items.length, operation.pageSize);

    if (!hasMore) {
      return allItems;
    }

    if (operation.pagination === "cursor") {
      if (nextCursor === null) {
        throw new Error("Invalid page: hasMore without a next cursor");
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`Safety stop: repeated pagination cursor ${nextCursor}`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } else {
      if (items.length === 0) {
        return allItems;
      }
      offset += items.length;
    }
  }

  throw new Error(`Safety stop: pagination exceeded ${MAX_PAGES} pages`);
}

function stringAt(item: unknown, path: string | null): string | null {
  if (path === null) {
    return null;
  }
  const value = readPath(item, path);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function archivedAt(item: unknown, path: string | null): boolean {
  if (path === null) {
    return true;
  }
  const value = readPath(item, path);
  return typeof value === "boolean" ? value : true;
}

function normalizeConversation(item: unknown, fields: ConversationFields, kind: NormalizedConversation["kind"]): NormalizedConversation {
  const id = stringAt(item, fields.idPath);
  if (id === null) {
    throw new Error("Invalid conversation record: missing id");
  }

  const projectId = stringAt(item, fields.projectIdPath);
  const projectStatus: ProjectStatus = projectId === null ? "UNKNOWN" : "CONFIRMED_PROJECT";

  return {
    id,
    kind,
    title: stringAt(item, fields.titlePath),
    archived: archivedAt(item, fields.archivedPath),
    lastActivity: stringAt(item, fields.lastActivityPath),
    projectStatus
  };
}

export async function loadConversationInventory(
  operations: ConversationListOperation[],
  fetchPage: PageFetcher
): Promise<NormalizedConversation[]> {
  const records: NormalizedConversation[] = [];

  for (const operation of operations) {
    const items = await paginateOperation(operation, fetchPage);
    records.push(...items.map((item) => normalizeConversation(item, operation.fields, operation.kind)));
  }

  return records;
}

export function summarizeInventory(items: NormalizedConversation[], cutoff: string): {
  scanned: Record<NormalizedConversation["kind"], number>;
  candidates: Record<NormalizedConversation["kind"], number>;
} {
  const classified = classifyConversations(items, cutoff);
  const scanned = { chatgpt: 0, codex: 0 };
  const candidates = { chatgpt: 0, codex: 0 };
  for (const item of items) {
    scanned[item.kind] += 1;
  }
  for (const item of classified.candidates) {
    candidates[item.kind] += 1;
  }
  return { scanned, candidates };
}

export type { PageFetcher } from "./api.js";
