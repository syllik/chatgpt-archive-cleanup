export type ConversationKind = "chatgpt" | "codex";

export type ProjectStatus =
  | "CONFIRMED_PROJECT"
  | "CONFIRMED_NON_PROJECT"
  | "UNKNOWN";

export type ManifestAction =
  | "candidate"
  | "skip-project"
  | "skip-unknown"
  | "skip-new"
  | "skip-invalid-date"
  | "skip-archived";

export interface NormalizedConversation {
  id: string;
  kind: ConversationKind;
  title: string | null;
  archived: boolean;
  lastActivity: string | null;
  projectStatus: ProjectStatus;
}

export interface ManifestEntry {
  id: string;
  kind: ConversationKind;
  title: string | null;
  lastActivity: string | null;
  projectStatus: ProjectStatus;
  action: ManifestAction;
}

export interface ClassificationResult {
  entries: ManifestEntry[];
  candidates: NormalizedConversation[];
}

export interface ResponseSchema {
  itemsPath: string;
  nextCursorPath: string | null;
  hasMorePath: string | null;
}

export interface ConversationFields {
  idPath: string;
  titlePath: string | null;
  archivedPath: string | null;
  lastActivityPath: string | null;
  projectIdPath: string | null;
}

export interface ConversationListOperation {
  method: "GET";
  pathTemplate: string;
  queryKeys: string[];
  pagination: "none" | "offset" | "cursor";
  pageSize: number;
  response: ResponseSchema;
  fields: ConversationFields;
  kind: ConversationKind;
}

export interface ProjectListOperation {
  method: "GET";
  pathTemplate: string;
  queryKeys: string[];
  pagination: "none" | "offset" | "cursor";
  pageSize: number;
  response: ResponseSchema;
  projectIdPath: string;
}

export interface ProjectConversationOperation extends ConversationListOperation {
  projectIdParam: "path" | string;
}

export interface ArchiveOperation {
  method: "PATCH" | "POST" | "PUT";
  pathTemplate: string;
  queryKeys: string[];
  bodyKey: "archived" | "is_archived";
  responseArchivedPath: string | null;
}

export interface DiscoveryConfig {
  schema: 1;
  discoveredAt: string;
  origin: "https://chatgpt.com";
  operations: {
    listConversations: ConversationListOperation[];
    listProjects: ProjectListOperation;
    listProjectConversations: ProjectConversationOperation;
    archiveConversation: ArchiveOperation;
    listArchivedConversations?: ConversationListOperation;
  };
}

export interface MutationRequest {
  method: string;
  operation: string;
}

export interface ObservedRequest {
  method: string;
  url: string;
}

export interface ArchiveBundleEvidence {
  method: ArchiveOperation["method"];
  pathTemplate: string;
  bodyKey: ArchiveOperation["bodyKey"];
}
