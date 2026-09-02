import { describe, expect, it } from "vitest";
import { assertSafeMutation, FatalSafetyError } from "../src/safety.js";

describe("assertSafeMutation", () => {
  it("rejects DELETE regardless of operation name", () => {
    expect(() => assertSafeMutation({ method: "DELETE", operation: "archive-conversation" }))
      .toThrow(FatalSafetyError);
  });

  it("rejects every operation other than archive-conversation", () => {
    expect(() => assertSafeMutation({ method: "PATCH", operation: "move-conversation" }))
      .toThrow(FatalSafetyError);
  });

  it("allows only a non-DELETE archive-conversation mutation", () => {
    expect(() => assertSafeMutation({ method: "PATCH", operation: "archive-conversation" }))
      .not.toThrow();
  });
});
