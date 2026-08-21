import { z } from "zod";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";

// ─── Web Fetch ──────────────────────────────────────────────────────────────

const WEB_FETCH_MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const WEB_FETCH_DEFAULT_TIMEOUT = 30_000;
const WEB_FETCH_MAX_TIMEOUT = 120_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

function buildAcceptHeader(format: "text" | "markdown" | "html"): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

async function htmlToMarkdown(html: string): Promise<string> {
  const { default: TurndownService } = await import("turndown");
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  td.remove(["script", "style", "meta", "link"]);
  return td.turndown(html);
}

function htmlToText(html: string): string {
  return html
    .replace(
      /<(script|style|noscript|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetchTool = defineTool({
  name: "web_fetch",
  concurrency: "safe",
  description:
    "Fetch the content of a URL and return it as text, markdown, or raw HTML. " +
    "Use this when the user asks you to read, summarize, or extract information from a specific URL. " +
    "HTTP URLs are automatically upgraded to HTTPS.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in. Defaults to markdown."),
    timeout: z
      .number()
      .default(30)
      .optional()
      .describe("Request timeout in seconds (max 120). Defaults to 30."),
  }),
  showContent: false,
  titleFormatter: (input) => `web_fetch: ${input.url ?? ""}`,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const { url, format, timeout } = input;

    const resolvedUrl = url.startsWith("http://")
      ? url.replace("http://", "https://")
      : url;

    if (!resolvedUrl.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://");
    }

    const timeoutMs = Math.min(
      (timeout ?? WEB_FETCH_DEFAULT_TIMEOUT / 1000) * 1000,
      WEB_FETCH_MAX_TIMEOUT,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Link the external cancellation signal to our internal controller
    if (signal) {
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const headers = {
        "User-Agent": BROWSER_UA,
        Accept: buildAcceptHeader(format),
        "Accept-Language": "en-US,en;q=0.9",
      };

      const initial = await fetch(resolvedUrl, {
        signal: controller.signal,
        headers,
      });

      // Retry with a plain UA if Cloudflare blocks us
      const response =
        initial.status === 403 &&
        initial.headers.get("cf-mitigated") === "challenge"
          ? await fetch(resolvedUrl, {
              signal: controller.signal,
              headers: { ...headers, "User-Agent": "code-agent" },
            })
          : initial;

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (
        contentLength &&
        parseInt(contentLength, 10) > WEB_FETCH_MAX_RESPONSE_SIZE
      ) {
        throw new Error("Response too large (exceeds 5 MB limit)");
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > WEB_FETCH_MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5 MB limit)");
      }

      const contentType = response.headers.get("content-type") ?? "";
      const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

      if (mime.startsWith("image/") && mime !== "image/svg+xml") {
        return {
          content: [{ type: "text", text: `Image content at ${resolvedUrl} (${mime}) - binary content skipped` }],
        };
      }

      const content = new TextDecoder().decode(arrayBuffer);
      const isHtml = contentType.includes("text/html");
      let output = content;

      switch (format) {
        case "markdown":
          output = isHtml ? await htmlToMarkdown(content) : content;
          break;
        case "text":
          output = isHtml ? htmlToText(content) : content;
          break;
        case "html":
          output = content;
          break;
      }

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      // If abort was triggered by our external signal, propagate as AbortError
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)} seconds`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
});
