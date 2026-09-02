import { describe, expect, it } from "vitest";
import { buildProjectProtectedSet, type PageFetcher } from "../src/projects.js";
import type { ProjectConversationOperation, ProjectListOperation } from "../src/types.js";

const listProjects: ProjectListOperation = {
  method: "GET",
  pathTemplate: "/backend-api/projects",
  queryKeys: ["limit"],
  pagination: "none",
  pageSize: 100,
  response: { itemsPath: "items", nextCursorPath: null, hasMorePath: null },
  projectIdPath: "id"
};

const listProjectConversations: ProjectConversationOperation = {
  method: "GET",
  pathTemplate: "/backend-api/projects/{projectId}/conversations",
  queryKeys: ["limit"],
  pagination: "none",
  pageSize: 100,
  response: { itemsPath: "items", nextCursorPath: null, hasMorePath: null },
  fields: {
    idPath: "id",
    titlePath: null,
    archivedPath: null,
    lastActivityPath: null,
    projectIdPath: null
  },
  kind: "chatgpt",
  projectIdParam: "path"
};

describe("buildProjectProtectedSet", () => {
  it("collects conversation IDs from every discovered project", async () => {
    const fetchPage: PageFetcher = async (operation) => {
      if (operation.pathTemplate === "/backend-api/projects") {
        return { items: [{ id: "project-a" }, { id: "project-b" }], hasMore: false };
      }
      if (operation.pathTemplate.endsWith("project-a/conversations")) {
        return { items: [{ id: "protected-a" }], hasMore: false };
      }
      return { items: [{ id: "protected-b" }], hasMore: false };
    };

    const result = await buildProjectProtectedSet(
      listProjects,
      listProjectConversations,
      fetchPage
    );

    expect([...result.protectedConversationIds]).toEqual(["protected-a", "protected-b"]);
    expect(result.projectIds).toEqual(new Set(["project-a", "project-b"]));
    expect(result.complete).toBe(true);
  });

  it("marks the protected set incomplete when one project scan is ambiguous", async () => {
    const fetchPage: PageFetcher = async (operation) => {
      if (operation.pathTemplate === "/backend-api/projects") {
        return { items: [{ id: "project-a" }, { id: "project-b" }], hasMore: false };
      }
      if (operation.pathTemplate.endsWith("project-a/conversations")) {
        return { items: [{ id: "protected-a" }], hasMore: false };
      }
      throw new Error("project inventory unavailable");
    };

    const result = await buildProjectProtectedSet(
      listProjects,
      listProjectConversations,
      fetchPage
    );

    expect(result.complete).toBe(false);
    expect(result.protectedConversationIds).toEqual(new Set(["protected-a"]));
  });
});
