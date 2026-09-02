import { describe, expect, it, vi } from "vitest";
import { assertChatGPTOrigin, connectToChatGPT, selectUniqueChatGPTPage } from "../src/browser.js";
import type { Browser, Page } from "playwright-core";

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

describe("selectUniqueChatGPTPage", () => {
  const page = (url: string): Page => ({ url: () => url } as unknown as Page);

  it("returns the one viable ChatGPT page and ignores unrelated pages", () => {
    expect(selectUniqueChatGPTPage([
      page("https://example.test"),
      page("https://chatgpt.com/c/one")
    ]).url()).toBe("https://chatgpt.com/c/one");
  });

  it("fails closed when more than one viable ChatGPT page exists", () => {
    expect(() => selectUniqueChatGPTPage([
      page("https://chatgpt.com/c/one"),
      page("https://chatgpt.com/c/two")
    ])).toThrow(/multiple|ambiguous|page/i);
  });

  it("closes an ambiguous CDP browser before returning a session", async () => {
    const close = vi.fn(async () => undefined);
    const browser = {
      contexts: () => [{
        pages: () => [page("https://chatgpt.com/c/one"), page("https://chatgpt.com/c/two")]
      }],
      close
    } as unknown as Browser;

    await expect(connectToChatGPT("http://127.0.0.1:9222", async () => browser)).rejects.toThrow(/multiple|ambiguous/i);
    expect(close).toHaveBeenCalledOnce();
  });
});
