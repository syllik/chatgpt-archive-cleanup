import { describe, expect, it } from "vitest";
import {
  buildDiscoveryConfig,
  DiscoveryBlockedError,
  assertDiscoveryConfigShape,
  parseArchiveBundleEvidence,
  redactObservedUrl,
  type DiscoveryEvidence
} from "../src/discovery.js";

const evidence: DiscoveryEvidence = {
  observedRequests: [
    { method: "GET", url: "https://chatgpt.com/api/conversations?offset=0&limit=50" },
    { method: "GET", url: "https://chatgpt.com/api/projects?limit=100" },
    { method: "GET", url: "https://chatgpt.com/api/projects/project-secret/conversations?limit=50" }
  ],
  samples: {
    "/api/conversations": {
      items: [{ id: "conversation-1", title: "A title", archived: false, updated_at: "2026-06-01T00:00:00Z" }],
      has_more: false
    },
    "/api/projects": { items: [{ id: "project-secret" }], has_more: false },
    "/api/projects/{projectId}/conversations": {
      items: [{ id: "conversation-1" }],
      has_more: false
    }
  },
  archiveEvidence: [{
    method: "PATCH",
    pathTemplate: "/api/conversation/{id}",
    bodyKey: "is_archived"
  }],
  discoveredAt: "2026-09-02T12:00:00.000Z"
};

describe("bounded discovery", () => {
  it("redacts observed query values and dynamic IDs", () => {
    expect(redactObservedUrl("https://chatgpt.com/api/projects/project-secret/conversations?cursor=secret-token"))
      .toEqual({
        pathTemplate: "/api/projects/{projectId}/conversations",
        queryKeys: ["cursor"]
      });
  });

  it("builds a normalized config from current request and schema evidence", () => {
    const config = buildDiscoveryConfig(evidence);

    expect(config).toMatchObject({
      schema: 1,
      origin: "https://chatgpt.com",
      operations: {
        archiveConversation: {
          method: "PATCH",
          pathTemplate: "/api/conversation/{id}",
          bodyKey: "is_archived"
        }
      }
    });
    expect(JSON.stringify(config)).not.toMatch(/project-secret|secret-token|A title|message/i);
  });

  it("parses one archive route only when method and safe body evidence are adjacent", () => {
    const result = parseArchiveBundleEvidence(
      'fetch("/api/conversation/" + id, { method: "PATCH", body: JSON.stringify({ is_archived: true }) })'
    );

    expect(result).toEqual([{
      method: "PATCH",
      pathTemplate: "/api/conversation/{id}",
      bodyKey: "is_archived"
    }]);
  });

  it("blocks ambiguous archive evidence instead of guessing", () => {
    expect(() => buildDiscoveryConfig({
      ...evidence,
      archiveEvidence: [
        ...evidence.archiveEvidence,
        { method: "POST", pathTemplate: "/api/threads/{id}", bodyKey: "archived" }
      ]
    })).toThrow(DiscoveryBlockedError);
  });

  it("blocks a response sample that cannot prove the required activity field", () => {
    const invalid = {
      ...evidence,
      samples: {
        ...evidence.samples,
        "/api/conversations": { items: [{ id: "conversation-1", archived: false }] }
      }
    };

    expect(() => buildDiscoveryConfig(invalid)).toThrow(/last activity/i);
  });

  it("rejects a tampered config that changes archive semantics", () => {
    const config = buildDiscoveryConfig(evidence);
    const tampered = {
      ...config,
      operations: {
        ...config.operations,
        archiveConversation: {
          ...config.operations.archiveConversation,
          bodyKey: "title"
        }
      }
    };

    expect(() => assertDiscoveryConfigShape(tampered)).toThrow(/archive operation/i);
  });
});
