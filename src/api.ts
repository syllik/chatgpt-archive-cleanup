import type {
  ConversationListOperation,
  ProjectListOperation
} from "./types.js";

export type PageOperation = ConversationListOperation | ProjectListOperation;
export type PageQuery = Readonly<Record<string, string>>;
export type PageFetcher = (operation: PageOperation, query: PageQuery) => Promise<unknown>;

export function readPath(value: unknown, path: string): unknown {
  if (path === "") {
    return value;
  }

  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function chooseQueryKey(keys: string[], candidates: string[]): string | null {
  return candidates.find((candidate) => keys.includes(candidate)) ?? null;
}

export function replaceProjectId(pathTemplate: string, projectId: string): string {
  if (!pathTemplate.includes("{projectId}")) {
    return pathTemplate;
  }
  return pathTemplate.replace("{projectId}", encodeURIComponent(projectId));
}
