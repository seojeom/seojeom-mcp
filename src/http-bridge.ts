import type { DesktopMcpServerConfig } from "./config.js";

type RequestMethod = "GET" | "POST" | "PUT";

export class UpstreamApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly bodyText: string | null;

  constructor(input: { status: number; path: string; bodyText: string | null }) {
    super(`upstream request failed: ${input.status} ${input.path}`);
    this.status = input.status;
    this.path = input.path;
    this.bodyText = input.bodyText;
  }
}

export class UpstreamApiBridge {
  private readonly baseUrl: string;
  private readonly cookieHeader: string | null;
  private readonly authHeaderName: string | null;
  private readonly authHeaderValue: string | null;

  constructor(config: DesktopMcpServerConfig) {
    this.baseUrl = config.apiBaseUrl;
    this.cookieHeader = config.apiCookieHeader;
    this.authHeaderName = config.apiHeaderName;
    this.authHeaderValue = config.apiHeaderValue;
  }

  describeAuthMode() {
    if (this.authHeaderName && this.authHeaderValue) {
      return `header:${this.authHeaderName}`;
    }

    if (this.cookieHeader) {
      return "cookie";
    }

    return "none";
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>("GET", path);
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>("POST", path, body);
  }

  async putJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>("PUT", path, body);
  }

  private buildHeaders(method: RequestMethod) {
    const headers = new Headers({
      Accept: "application/json",
    });

    if (method === "POST" || method === "PUT") {
      headers.set("Content-Type", "application/json");
    }

    if (this.cookieHeader) {
      headers.set("Cookie", this.cookieHeader);
    }

    if (this.authHeaderName && this.authHeaderValue) {
      headers.set(this.authHeaderName, this.authHeaderValue);
    }

    return headers;
  }

  private async requestJson<T>(
    method: RequestMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: this.buildHeaders(method),
      body: method === "POST" || method === "PUT" ? JSON.stringify(body ?? null) : undefined,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => null);
      throw new UpstreamApiError({
        status: response.status,
        path,
        bodyText,
      });
    }

    return (await response.json()) as T;
  }
}
