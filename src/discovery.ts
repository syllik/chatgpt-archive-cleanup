import { assertChatGPTOrigin } from "./browser.js";
import { readPath } from "./api.js";
import type {
  ArchiveBundleEvidence,
  ArchiveOperation,
  ConversationFields,
  ConversationListOperation,
  DiscoveryConfig,
  ObservedRequest,
  ProjectConversationOperation,
  ProjectListOperation,
  ResponseSchema
} from "./types.js";

export class DiscoveryBlockedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DiscoveryBlockedError";
  }
}

export interface RedactedObservedUrl {
  pathTemplate: string;
  queryKeys: string[];
}

export interface DiscoveryEvidence {
  observedRequests: ObservedRequest[];
  samples: Record<string, unknown>;
  archiveEvidence: ArchiveBundleEvidence[];
  discoveredAt: string;
}

export interface DiscoveryRuntime {
  pageUrl(): string;
  observeRequests(waitSeconds: number): Promise<ObservedRequest[]>;
  inspectArchiveBundle(): Promise<ArchiveBundleEvidence[]>;
  fetchUrl(url: string): Promise<unknown>;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function assertSafePathTemplate(pathTemplate: unknown, label: string): asserts pathTemplate is string {
  if (typeof pathTemplate !== "string" || !pathTemplate.startsWith("/")
    || pathTemplate.includes("://") || pathTemplate.includes("?") || pathTemplate.includes("#")
    || pathTemplate.includes("..")) {
    throw new DiscoveryBlockedError(`Unsafe ${label} path template`);
  }
}

export function assertDiscoveryConfigShape(value: unknown): asserts value is DiscoveryConfig {
  const config = objectRecord(value);
  const operations = objectRecord(config?.operations);
  if (config?.schema !== 1 || config.origin !== "https://chatgpt.com"
    || typeof config.discoveredAt !== "string" || operations === null) {
    throw new DiscoveryBlockedError("Invalid discovery config envelope");
  }
  if (!Array.isArray(operations.listConversations)
    || operations.listConversations.length === 0
    || objectRecord(operations.listProjects) === null
    || objectRecord(operations.listProjectConversations) === null
    || objectRecord(operations.archiveConversation) === null) {
    throw new DiscoveryBlockedError("Invalid discovery config operations");
  }

  const listOperations = [
    ...operations.listConversations,
    operations.listProjects,
    operations.listProjectConversations,
    ...(operations.listArchivedConversations === undefined ? [] : [operations.listArchivedConversations])
  ];
  for (const operation of listOperations) {
    const record = objectRecord(operation);
    assertSafePathTemplate(record?.pathTemplate, "read operation");
    if (record.method !== "GET" || !Array.isArray(record.queryKeys)) {
      throw new DiscoveryBlockedError("Invalid read operation in discovery config");
    }
  }

  const archive = objectRecord(operations.archiveConversation);
  assertSafePathTemplate(archive?.pathTemplate, "archive operation");
  if (archive.method !== "PATCH" && archive.method !== "POST" && archive.method !== "PUT"
    || (archive.bodyKey !== "archived" && archive.bodyKey !== "is_archived")
    || !archive.pathTemplate.includes("{id}")
    || !/conversation|thread/i.test(archive.pathTemplate)
    || /delete|bulk|project|move|title|content|all/i.test(archive.pathTemplate)
    || !Array.isArray(archive.queryKeys)) {
    throw new DiscoveryBlockedError("Invalid archive operation in discovery config");
  }
}

const ID_SEGMENT = /^[a-f0-9]{8}-[a-f0-9-]{20,}$/i;

function dynamicSegment(segment: string): boolean {
  return !/^(?:conversation|conversations|thread|threads|project|projects)$/i.test(segment)
    && (ID_SEGMENT.test(segment) || segment.length >= 13);
}

export function redactObservedUrl(rawUrl: string): RedactedObservedUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DiscoveryBlockedError(`Invalid observed URL: ${rawUrl}`);
  }
  assertChatGPTOrigin(url.toString());

  const segments = url.pathname.split("/").filter(Boolean);
  const redacted = segments.map((segment, index) => {
    const previous = segments[index - 1]?.toLowerCase();
    if (previous === "project" || previous === "projects") {
      return "{projectId}";
    }
    if (index === segments.length - 1 && dynamicSegment(segment)
      && segments.some((candidate) => /conversation|thread/i.test(candidate))) {
      return "{id}";
    }
    return segment;
  });

  return {
    pathTemplate: `/${redacted.join("/")}`,
    queryKeys: [...new Set([...url.searchParams.keys()])]
  };
}

function requestEntries(evidence: DiscoveryEvidence): Map<string, ObservedRequest[]> {
  const grouped = new Map<string, ObservedRequest[]>();
  for (const request of evidence.observedRequests) {
    if (request.method.toUpperCase() !== "GET") {
      continue;
    }
    const redacted = redactObservedUrl(request.url);
    const list = grouped.get(redacted.pathTemplate) ?? [];
    list.push(request);
    grouped.set(redacted.pathTemplate, list);
  }
  return grouped;
}

function isConversationPath(pathTemplate: string): boolean {
  return /conversation|thread/i.test(pathTemplate);
}

function isProjectPath(pathTemplate: string): boolean {
  return /project/i.test(pathTemplate);
}

function isProjectConversationPath(pathTemplate: string): boolean {
  return isProjectPath(pathTemplate) && isConversationPath(pathTemplate);
}

function isProjectListPath(pathTemplate: string): boolean {
  const last = pathTemplate.split("/").filter(Boolean).at(-1) ?? "";
  return isProjectPath(pathTemplate) && !isConversationPath(pathTemplate)
    && /projects?/i.test(last);
}

function isAnyConversationListPath(pathTemplate: string): boolean {
  const last = pathTemplate.split("/").filter(Boolean).at(-1) ?? "";
  return isConversationPath(pathTemplate) && !isProjectPath(pathTemplate)
    && /^(?:conversations?|threads?)$/i.test(last);
}

function isConversationListPath(pathTemplate: string): boolean {
  return isAnyConversationListPath(pathTemplate) && !/archived/i.test(pathTemplate);
}

function kindForPath(pathTemplate: string): "chatgpt" | "codex" {
  return /(?:^|\/)codex(?:\/|$)/i.test(pathTemplate) ? "codex" : "chatgpt";
}

function pageSizeFor(requests: ObservedRequest[]): number {
  for (const request of requests) {
    const url = new URL(request.url);
    for (const key of ["limit", "page_size", "pageSize"]) {
      const value = Number(url.searchParams.get(key));
      if (Number.isInteger(value) && value > 0 && value <= 1000) {
        return value;
      }
    }
  }
  return 100;
}

function paginationFor(queryKeys: string[]): ConversationListOperation["pagination"] {
  if (queryKeys.some((key) => ["cursor", "next_cursor"].includes(key))) {
    return "cursor";
  }
  if (queryKeys.some((key) => ["offset", "start"].includes(key))) {
    return "offset";
  }
  return "none";
}

function firstExistingPath(sample: unknown, paths: string[], predicate: (value: unknown) => boolean): string | null {
  for (const path of paths) {
    const value = readPath(sample, path);
    if (predicate(value)) {
      return path;
    }
  }
  return null;
}

function inferResponseSchema(sample: unknown): ResponseSchema {
  const itemsPath = firstExistingPath(sample, ["", "items", "data", "conversations", "results", "data.items"], Array.isArray);
  if (itemsPath === null) {
    throw new DiscoveryBlockedError("Response schema does not expose an item array");
  }

  const nextCursorPath = firstExistingPath(sample,
    ["next_cursor", "nextCursor", "pagination.next_cursor", "pagination.nextCursor"],
    (value) => value === null || value === undefined || typeof value === "string");
  const hasMorePath = firstExistingPath(sample,
    ["has_more", "hasMore", "pagination.has_more", "pagination.hasMore"],
    (value) => typeof value === "boolean");

  return { itemsPath, nextCursorPath, hasMorePath };
}

function sampleItems(sample: unknown, response: ResponseSchema): unknown[] {
  const items = readPath(sample, response.itemsPath);
  if (!Array.isArray(items) || items.length === 0) {
    throw new DiscoveryBlockedError("Response schema sample contains no records");
  }
  return items;
}

function fieldPath(items: unknown[], paths: string[], predicate: (value: unknown) => boolean): string | null {
  return paths.find((path) => items.every((item) => {
    const value = readPath(item, path);
    return value === null || value === undefined || predicate(value);
  })) ?? null;
}

function strictFieldPath(items: unknown[], paths: string[], predicate: (value: unknown) => boolean): string | null {
  return paths.find((path) => items.every((item) => predicate(readPath(item, path)))) ?? null;
}

function inferConversationFields(sample: unknown, response: ResponseSchema, requireActivity: boolean): ConversationFields {
  const items = sampleItems(sample, response);
  const idPath = strictFieldPath(items, ["id", "conversation_id", "thread_id"], (value) => typeof value === "string" && value.length > 0);
  if (idPath === null) {
    throw new DiscoveryBlockedError("Response schema does not expose a stable conversation ID");
  }

  const titlePath = fieldPath(items, ["title", "name"], (value) => typeof value === "string");
  const archivedPath = fieldPath(items, ["archived", "is_archived"], (value) => typeof value === "boolean");
  const activityCandidates = ["update_time", "updated_at", "last_activity", "lastActivity"];
  const lastActivityPath = activityCandidates.find((path) => {
    const values = items.map((item) => readPath(item, path));
    return values.some((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
      && values.every((value) => value === null || value === undefined || typeof value === "string");
  }) ?? null;

  if (requireActivity && lastActivityPath === null) {
    throw new DiscoveryBlockedError("Response schema does not expose reliable last activity");
  }
  if (requireActivity && archivedPath === null) {
    throw new DiscoveryBlockedError("Response schema does not expose archived state");
  }

  const projectIdPath = fieldPath(items, ["project_id", "projectId"], (value) => typeof value === "string" && value.length > 0);
  return { idPath, titlePath, archivedPath, lastActivityPath, projectIdPath };
}

function inferProjectIdPath(sample: unknown, response: ResponseSchema): string {
  const items = sampleItems(sample, response);
  const path = strictFieldPath(items, ["id", "project_id", "projectId"], (value) => typeof value === "string" && value.length > 0);
  if (path === null) {
    throw new DiscoveryBlockedError("Project response does not expose a stable project ID");
  }
  return path;
}

function operationBase(requests: ObservedRequest[]): {
  queryKeys: string[];
  pagination: "none" | "offset" | "cursor";
  pageSize: number;
} {
  const queryKeys = [...new Set(requests.flatMap((request) => redactObservedUrl(request.url).queryKeys))];
  return { queryKeys, pagination: paginationFor(queryKeys), pageSize: pageSizeFor(requests) };
}

function makeConversationOperation(
  pathTemplate: string,
  requests: ObservedRequest[],
  sample: unknown,
  requireActivity: boolean
): ConversationListOperation {
  const response = inferResponseSchema(sample);
  const operationPagination = operationBase(requests);
  assertPaginationContract(sample, response, operationPagination.pagination);
  return {
    method: "GET",
    pathTemplate,
    ...operationPagination,
    response,
    fields: inferConversationFields(sample, response, requireActivity),
    kind: kindForPath(pathTemplate)
  };
}

function assertPaginationContract(
  sample: unknown,
  response: ResponseSchema,
  pagination: ConversationListOperation["pagination"]
): void {
  if (pagination === "none") {
    if (response.hasMorePath === null) {
      throw new DiscoveryBlockedError("Pagination semantics are not proven by the current client");
    }
    if (readPath(sample, response.hasMorePath) !== false) {
      throw new DiscoveryBlockedError("A non-paginated response does not prove a complete inventory");
    }
  }
}

function uniqueArchiveEvidence(evidence: ArchiveBundleEvidence[]): ArchiveBundleEvidence[] {
  const unique = new Map<string, ArchiveBundleEvidence>();
  for (const item of evidence) {
    if (/delete|bulk|project|move|title|content|all/i.test(item.pathTemplate)) {
      continue;
    }
    const key = `${item.method}:${item.pathTemplate}:${item.bodyKey}`;
    unique.set(key, item);
  }
  return [...unique.values()];
}

export function parseArchiveBundleEvidence(source: string): ArchiveBundleEvidence[] {
  const routePattern = /["'`](\/[^"'`\\]*(?:conversation|thread)[^"'`\\]*)["'`]/gi;
  const results: ArchiveBundleEvidence[] = [];
  for (const match of source.matchAll(routePattern)) {
    const route = match[1];
    const start = match.index ?? 0;
    const context = source.slice(Math.max(0, start - 240), start + 360);
    if (/delete|bulk|project|move|title|content|all/i.test(context)) {
      continue;
    }
  const methodMatch = context.match(/method\s*:\s*["'](PATCH|POST|PUT)["']/i);
  const bodyMatch = context.match(/\b(is_archived|archived)\s*:\s*true/i);
    if (route === undefined || methodMatch?.[1] === undefined || bodyMatch?.[1] === undefined) {
      continue;
    }
    const pathTemplate = route.endsWith("/")
      ? `${route}{id}`
      : /\/(?:conversation|thread)s?$/i.test(route)
        ? `${route}/{id}`
        : route.replace(/\/[^/]+$/, "/{id}");
    results.push({
      method: methodMatch[1].toUpperCase() as ArchiveBundleEvidence["method"],
      pathTemplate,
      bodyKey: bodyMatch[1].toLowerCase() === "archived" ? "archived" : "is_archived"
    });
  }
  return uniqueArchiveEvidence(results);
}

function requiredSample(samples: Record<string, unknown>, pathTemplate: string): unknown {
  const sample = samples[pathTemplate];
  if (sample === undefined) {
    throw new DiscoveryBlockedError(`No response sample for ${pathTemplate}`);
  }
  return sample;
}

export function buildDiscoveryConfig(evidence: DiscoveryEvidence): DiscoveryConfig {
  const grouped = requestEntries(evidence);
  const listPaths = [...grouped.keys()].filter(isConversationListPath);
  const projectListPaths = [...grouped.keys()].filter(isProjectListPath);
  const projectConversationPaths = [...grouped.keys()].filter(isProjectConversationPath);
  if (listPaths.length === 0) {
    throw new DiscoveryBlockedError("No active conversation list operation was observed");
  }
  if (projectListPaths.length !== 1 || projectConversationPaths.length !== 1) {
    throw new DiscoveryBlockedError("Project inventory operations are missing or ambiguous");
  }

  const listConversations = listPaths.map((pathTemplate) => makeConversationOperation(
    pathTemplate,
    grouped.get(pathTemplate) ?? [],
    requiredSample(evidence.samples, pathTemplate),
    true
  ));
  const projectListPath = projectListPaths[0];
  if (projectListPath === undefined) {
    throw new DiscoveryBlockedError("Project list operation is missing");
  }
  const projectListSample = requiredSample(evidence.samples, projectListPath);
  const projectListResponse = inferResponseSchema(projectListSample);
  const projectListBase = operationBase(grouped.get(projectListPath) ?? []);
  assertPaginationContract(projectListSample, projectListResponse, projectListBase.pagination);
  const listProjects: ProjectListOperation = {
    method: "GET",
    pathTemplate: projectListPath,
    ...projectListBase,
    response: projectListResponse,
    projectIdPath: inferProjectIdPath(projectListSample, projectListResponse)
  };

  const projectConversationPath = projectConversationPaths[0];
  if (projectConversationPath === undefined) {
    throw new DiscoveryBlockedError("Project conversation operation is missing");
  }
  const projectConversationSample = requiredSample(evidence.samples, projectConversationPath);
  const projectConversationOperation = makeConversationOperation(
    projectConversationPath,
    grouped.get(projectConversationPath) ?? [],
    projectConversationSample,
    false
  ) as ProjectConversationOperation;
  projectConversationOperation.projectIdParam = "path";

  const archiveEvidence = uniqueArchiveEvidence(evidence.archiveEvidence);
  if (archiveEvidence.length !== 1) {
    throw new DiscoveryBlockedError("Archive operation evidence is missing or ambiguous");
  }
  const archiveEvidenceItem = archiveEvidence[0];
  if (archiveEvidenceItem === undefined) {
    throw new DiscoveryBlockedError("Archive operation evidence is missing");
  }
  const archiveConversation: ArchiveOperation = {
    ...archiveEvidenceItem,
    queryKeys: [],
    responseArchivedPath: null
  };
  assertSafePathTemplate(archiveConversation.pathTemplate, "archive operation");
  if (!archiveConversation.pathTemplate.includes("{id}")) {
    throw new DiscoveryBlockedError("Archive operation has no redacted conversation ID");
  }

  const config: DiscoveryConfig = {
    schema: 1,
    discoveredAt: evidence.discoveredAt,
    origin: "https://chatgpt.com",
    operations: {
      listConversations,
      listProjects,
      listProjectConversations: projectConversationOperation,
      archiveConversation
    }
  };

  const archivedPath = [...grouped.keys()].find((path) => /archived/i.test(path) && isAnyConversationListPath(path));
  if (archivedPath !== undefined) {
    config.operations.listArchivedConversations = makeConversationOperation(
      archivedPath,
      grouped.get(archivedPath) ?? [],
      requiredSample(evidence.samples, archivedPath),
      false
    );
  }
  return config;
}

export function validateDiscoveryConfig(
  config: DiscoveryConfig,
  observedRequests: ObservedRequest[],
  archiveEvidence: ArchiveBundleEvidence[]
): void {
  assertChatGPTOrigin(config.origin);
  const observedPaths = new Set(observedRequests
    .filter((request) => request.method.toUpperCase() === "GET")
    .map((request) => redactObservedUrl(request.url).pathTemplate));
  const listOperations = [
    ...config.operations.listConversations,
    config.operations.listProjects,
    config.operations.listProjectConversations,
    ...(config.operations.listArchivedConversations === undefined ? [] : [config.operations.listArchivedConversations])
  ];
  for (const operation of listOperations) {
    if (!observedPaths.has(operation.pathTemplate)) {
      throw new DiscoveryBlockedError(`Configured operation is not present in current client: ${operation.pathTemplate}`);
    }
  }
  const matchingArchive = uniqueArchiveEvidence(archiveEvidence)
    .filter((item) => item.method === config.operations.archiveConversation.method
      && item.pathTemplate === config.operations.archiveConversation.pathTemplate
      && item.bodyKey === config.operations.archiveConversation.bodyKey);
  if (matchingArchive.length !== 1) {
    throw new DiscoveryBlockedError("Configured archive operation is not currently evidenced");
  }
}

export async function discoverConfig(
  runtime: DiscoveryRuntime,
  waitSeconds = 15
): Promise<DiscoveryConfig> {
  assertChatGPTOrigin(runtime.pageUrl());
  const observedRequests = await runtime.observeRequests(waitSeconds);
  const grouped = requestEntries({
    observedRequests,
    samples: {},
    archiveEvidence: [],
    discoveredAt: new Date().toISOString()
  });
  const samplePaths = [...grouped.keys()].filter((path) => isConversationListPath(path)
    || isProjectListPath(path) || isProjectConversationPath(path));
  const samples: Record<string, unknown> = {};
  for (const pathTemplate of samplePaths) {
    const request = grouped.get(pathTemplate)?.[0];
    if (request !== undefined) {
      samples[pathTemplate] = await runtime.fetchUrl(request.url);
    }
  }
  const archiveEvidence = await runtime.inspectArchiveBundle();
  const evidence: DiscoveryEvidence = {
    observedRequests,
    samples,
    archiveEvidence,
    discoveredAt: new Date().toISOString()
  };
  const config = buildDiscoveryConfig(evidence);
  validateDiscoveryConfig(config, observedRequests, archiveEvidence);
  return config;
}

export type { ArchiveBundleEvidence, ObservedRequest } from "./types.js";
