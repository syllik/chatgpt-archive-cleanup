import { describe, expect, it } from "vitest";
import { assertChatGPTOrigin } from "../src/browser.js";

describe("assertChatGPTOrigin", () => {
  it("accepts only the ChatGPT origin", () => {
    expect(() => assertChatGPTOrigin("https://chatgpt.com/c/example")).not.toThrow();
  });

  it.each(["https://evil.example", "http://chatgpt.com", "https://chat.openai.com"]) (
    "rejects %s",
    (url) => {
      expect(() => assertChatGPTOrigin(url)).toThrow(/origin/i);
    }
  );
});
