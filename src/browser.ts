import { chromium, type Browser, type Page, type Request } from "playwright-core";
import { assertSafeMutation } from "./safety.js";
import type { PageOperation } from "./api.js";
import type { ArchiveOperation } from "./types.js";

export const CHATGPT_ORIGIN = "https://chatgpt.com" as const;
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export function assertChatGPTOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid browser URL: ${url}`);
  }

  if (parsed.origin !== CHATGPT_ORIGIN) {
    throw new Error(`Unexpected browser origin: ${parsed.origin}`);
  }
}

interface PageRequestPayload {
  url: string;
  method: string;
  body?: string;
}

interface PageResponsePayload {
  status: number;
  body: unknown;
}

function materializeUrl(pathTemplate: string, query: Readonly<Record<string, string>>, pageUrl: string): string {
  if (pathTemplate.includes("{")) {
    throw new Error(`Unresolved URL template: ${pathTemplate}`);
  }

  const url = new URL(pathTemplate, pageUrl);
  if (url.origin !== CHATGPT_ORIGIN) {
    throw new Error(`Unexpected request origin: ${url.origin}`);
  }
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export class BrowserSession {
  public constructor(
    private readonly browser: Browser,
    public readonly page: Page
  ) {}

  public pageUrl(): string {
    const url = this.page.url();
    assertChatGPTOrigin(url);
    return url;
  }

  public async observeRequests(waitSeconds: number): Promise<{ method: string; url: string }[]> {
    const observed = new Map<string, { method: string; url: string }>();
    const record = (method: string, url: string): void => {
      try {
        assertChatGPTOrigin(url);
        const key = `${method.toUpperCase()} ${url}`;
        observed.set(key, { method: method.toUpperCase(), url });
      } catch {
        // Third-party resources are irrelevant to the discovery contract.
      }
    };

    const onRequest = (request: Request): void => {
      record(request.method(), request.url());
    };
    this.page.on("request", onRequest);

    const existing = await this.page.evaluate(() => performance.getEntriesByType("resource")
      .map((entry) => entry.name));
    for (const url of existing) {
      record("GET", url);
    }

    if (waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(waitSeconds, 300) * 1000);
      });
    }

    this.page.off("request", onRequest);
    return [...observed.values()];
  }

  private async requestUrl(url: string, method: string, body?: Record<string, boolean>): Promise<unknown> {
    assertChatGPTOrigin(this.pageUrl());
    const target = new URL(url, this.page.url());
    if (target.origin !== CHATGPT_ORIGIN) {
      throw new Error(`Unexpected request origin: ${target.origin}`);
    }

    const payload: PageRequestPayload = { url: target.toString(), method: method.toUpperCase() };
    if (body !== undefined) {
      payload.body = JSON.stringify(body);
    }

    const result = await this.page.evaluate(async (request: PageRequestPayload): Promise<PageResponsePayload> => {
      const init: RequestInit = {
        method: request.method,
        credentials: "include"
      };
      if (request.body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = request.body;
      }
      const response = await fetch(request.url, init);
      const text = await response.text();
      let parsed: unknown = null;
      if (text !== "") {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, body: parsed };
    }, payload);

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Browser request failed with HTTP ${result.status}`);
    }
    return result.body;
  }

  public async fetchUrl(url: string): Promise<unknown> {
    return this.requestUrl(url, "GET");
  }

  public async fetchOperation(operation: PageOperation, query: Readonly<Record<string, string>>): Promise<unknown> {
    if (operation.method !== "GET") {
      throw new Error(`Non-read operation passed to fetchOperation: ${operation.method}`);
    }
    return this.fetchUrl(materializeUrl(operation.pathTemplate, query, this.page.url()));
  }

  public async archiveConversation(operation: ArchiveOperation, id: string): Promise<unknown> {
    const path = operation.pathTemplate.replace("{id}", encodeURIComponent(id));
    if (path.includes("{")) {
      throw new Error(`Unresolved archive URL template: ${operation.pathTemplate}`);
    }
    assertSafeMutation({ method: operation.method, operation: "archive-conversation" });
    return this.requestUrl(path, operation.method, { [operation.bodyKey]: true });
  }

  public async inspectArchiveBundle(): Promise<{
    method: ArchiveOperation["method"];
    pathTemplate: string;
    bodyKey: ArchiveOperation["bodyKey"];
  }[]> {
    const scripts = await this.page.evaluate(() => [...document.scripts]
      .map((script) => script.src)
      .filter((src) => {
        try {
          return src !== "" && new URL(src).origin === "https://chatgpt.com";
        } catch {
          return false;
        }
      }));

    return this.page.evaluate(async (urls: string[]) => {
      const results: {
        method: "PATCH" | "POST" | "PUT";
        pathTemplate: string;
        bodyKey: "archived" | "is_archived";
      }[] = [];
      const routePattern = /["'`](\/[^"'`\\]*(?:conversation|thread)[^"'`\\]*)["'`]/gi;
      for (const scriptUrl of urls) {
        let source = "";
        try {
          const response = await fetch(scriptUrl, { credentials: "include" });
          if (response.ok) {
            source = await response.text();
          }
        } catch {
          continue;
        }

        for (const match of source.matchAll(routePattern)) {
          const route = match[1];
          if (route === undefined) {
            continue;
          }
          const start = match.index ?? 0;
          const context = source.slice(Math.max(0, start - 240), start + 360);
          if (/(?:delete|bulk|project|move|title|content)/i.test(context)) {
            continue;
          }
          const methodMatch = context.match(/method\s*:\s*["'](PATCH|POST|PUT)["']/i);
          const bodyMatch = context.match(/\b(is_archived|archived)\s*:\s*true/i);
          if (methodMatch?.[1] === undefined || bodyMatch?.[1] === undefined) {
            continue;
          }
          const cleanRoute = route.split(/[?#]/)[0] ?? route;
          const pathTemplate = route.endsWith("/")
            ? `${cleanRoute}{id}`
            : /\/(?:conversation|thread)s?$/i.test(cleanRoute)
              ? `${cleanRoute}/{id}`
              : cleanRoute.replace(/\/[^/]+$/, "/{id}");
          results.push({
            method: methodMatch[1].toUpperCase() as "PATCH" | "POST" | "PUT",
            pathTemplate,
            bodyKey: bodyMatch[1].toLowerCase() === "archived" ? "archived" : "is_archived"
          });
        }
      }
      return results;
    }, scripts);
  }

  public async disconnect(): Promise<void> {
    await this.browser.close();
  }
}

export async function connectToChatGPT(cdpUrl: string = DEFAULT_CDP_URL): Promise<BrowserSession> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => {
    try {
      assertChatGPTOrigin(candidate.url());
      return true;
    } catch {
      return false;
    }
  });

  if (page === undefined) {
    await browser.close();
    throw new Error("No authenticated https://chatgpt.com page found in the CDP browser");
  }
  return new BrowserSession(browser, page);
}

export { DEFAULT_CDP_URL };
