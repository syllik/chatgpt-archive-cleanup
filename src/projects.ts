import { replaceProjectId, readPath, type PageFetcher } from "./api.js";
import { paginateOperation } from "./inventory.js";
import type {
  NormalizedConversation,
  ProjectConversationOperation,
  ProjectListOperation
} from "./types.js";

export interface ProjectInventory {
  protectedConversationIds: Set<string>;
  projectIds: Set<string>;
  complete: boolean;
}

function projectId(item: unknown, path: string): string | null {
  const value = readPath(item, path);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function buildProjectProtectedSet(
  listProjects: ProjectListOperation,
  listProjectConversations: ProjectConversationOperation,
  fetchPage: PageFetcher
): Promise<ProjectInventory> {
  const protectedConversationIds = new Set<string>();
  const projectIds = new Set<string>();
  let complete = true;
  let projects: unknown[];

  try {
    projects = await paginateOperation(listProjects, fetchPage);
  } catch {
    return { protectedConversationIds, projectIds, complete: false };
  }

  for (const project of projects) {
    const id = projectId(project, listProjects.projectIdPath);
    if (id === null) {
      complete = false;
      continue;
    }
    projectIds.add(id);

    try {
      const operation: ProjectConversationOperation = {
        ...listProjectConversations,
        pathTemplate: listProjectConversations.projectIdParam === "path"
          ? replaceProjectId(listProjectConversations.pathTemplate, id)
          : listProjectConversations.pathTemplate
      };
      const items = await paginateOperation(operation, async (projectOperation, query) => {
        if (listProjectConversations.projectIdParam === "path") {
          return fetchPage(projectOperation, query);
        }
        return fetchPage(projectOperation, {
          ...query,
          [listProjectConversations.projectIdParam]: id
        });
      });
      for (const item of items) {
        const conversationId = projectId(item, listProjectConversations.fields.idPath);
        if (conversationId === null) {
          complete = false;
        } else {
          protectedConversationIds.add(conversationId);
        }
      }
    } catch {
      complete = false;
    }
  }

  return { protectedConversationIds, projectIds, complete };
}

export function applyProjectStatuses(
  conversations: NormalizedConversation[],
  projectInventory: ProjectInventory
): NormalizedConversation[] {
  return conversations.map((conversation) => {
    if (conversation.projectStatus === "CONFIRMED_PROJECT"
      || projectInventory.protectedConversationIds.has(conversation.id)) {
      return { ...conversation, projectStatus: "CONFIRMED_PROJECT" };
    }
    return {
      ...conversation,
      projectStatus: projectInventory.complete ? "CONFIRMED_NON_PROJECT" : "UNKNOWN"
    };
  });
}

export function projectSetFingerprint(inventory: ProjectInventory): string {
  return [...inventory.protectedConversationIds].sort().join("\u0000");
}

export type { PageFetcher } from "./api.js";
