import { cwd } from "node:process";
import { resolve } from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_APPROVAL_PATH = "/approval";
const DEFAULT_PORT = 43123;
const DEFAULT_PROJECT_ID = "desktop-project";
const DEFAULT_SERVER_NAME = "ainovel-desktop-sidecar";
const DEFAULT_SERVER_VERSION = process.env.SEOJEOM_MCP_SERVER_VERSION?.trim() || "0.2.0";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_WIKI_AUTHORITY = "api-bridge";
const DEFAULT_GRAPH_AUTHORITY = "api-bridge";

export type DesktopMcpServerConfig = {
  host: string;
  port: number;
  transport: "streamable-http" | "stdio";
  wikiAuthority: "api-bridge" | "local-filesystem";
  graphAuthority: "api-bridge" | "local-snapshot";
  graphSlicePath: string | null;
  projectId: string;
  projectRoot: string;
  mcpPath: string;
  healthPath: string;
  approvalPath: string;
  serverName: string;
  serverVersion: string;
  startedAt: string;
  apiBaseUrl: string;
  apiCookieHeader: string | null;
  apiHeaderName: string | null;
  apiHeaderValue: string | null;
};

export type DesktopMcpHealthSnapshot = {
  status: "ok";
  projectId: string;
  projectRoot: string;
  transport: "streamable-http" | "stdio";
  host: string;
  port: number;
  mcpPath: string;
  approvalPath: string;
  startedAt: string;
  pid: number;
};

function readArgValue(argv: string[], flag: string): string | undefined {
  const flagIndex = argv.indexOf(flag);
  if (flagIndex === -1) {
    return undefined;
  }

  const nextValue = argv[flagIndex + 1];
  if (!nextValue || nextValue.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }

  return nextValue;
}

function parsePort(rawPort: string): number {
  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`invalid --port value: ${rawPort}`);
  }

  return parsedPort;
}

function normalizeHttpPath(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeNullableString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid api base url protocol: ${url.protocol}`);
  }

  return url.toString().replace(/\/$/, "");
}

export function parseDesktopMcpServerConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): DesktopMcpServerConfig {
  const host = readArgValue(argv, "--host") ?? env.SEOJEOM_DESKTOP_MCP_HOST ?? DEFAULT_HOST;
  const port = parsePort(
    readArgValue(argv, "--port") ?? env.SEOJEOM_DESKTOP_MCP_PORT ?? String(DEFAULT_PORT),
  );
  const projectId =
    readArgValue(argv, "--project-id") ?? env.SEOJEOM_PROJECT_ID ?? DEFAULT_PROJECT_ID;
  const projectRoot = resolve(
    readArgValue(argv, "--project-root") ?? env.SEOJEOM_PROJECT_ROOT ?? cwd(),
  );
  const mcpPath = normalizeHttpPath(
    readArgValue(argv, "--mcp-path") ?? env.SEOJEOM_DESKTOP_MCP_PATH ?? DEFAULT_MCP_PATH,
    DEFAULT_MCP_PATH,
  );
  const apiBaseUrl = normalizeBaseUrl(
    readArgValue(argv, "--api-base-url") ?? env.SEOJEOM_API_BASE_URL ?? DEFAULT_API_BASE_URL,
  );
  const wikiAuthorityRaw =
    readArgValue(argv, "--wiki-authority") ??
    env.SEOJEOM_MCP_WIKI_AUTHORITY ??
    env.SEOJEOM_DESKTOP_MCP_WIKI_AUTHORITY ??
    DEFAULT_WIKI_AUTHORITY;
  const graphAuthorityRaw =
    readArgValue(argv, "--graph-authority") ??
    env.SEOJEOM_MCP_GRAPH_AUTHORITY ??
    env.SEOJEOM_DESKTOP_MCP_GRAPH_AUTHORITY ??
    DEFAULT_GRAPH_AUTHORITY;
  const wikiAuthority =
    wikiAuthorityRaw === "api-bridge" || wikiAuthorityRaw === "local-filesystem"
      ? wikiAuthorityRaw
      : null;
  const graphAuthority =
    graphAuthorityRaw === "api-bridge" || graphAuthorityRaw === "local-snapshot"
      ? graphAuthorityRaw
      : null;
  const graphSlicePath = normalizeNullableString(
    readArgValue(argv, "--graph-slice-path") ??
      env.SEOJEOM_MCP_GRAPH_SLICE_PATH ??
      env.SEOJEOM_DESKTOP_MCP_GRAPH_SLICE_PATH,
  );
  const approvalPath = normalizeHttpPath(
    readArgValue(argv, "--approval-path") ??
      env.SEOJEOM_DESKTOP_MCP_APPROVAL_PATH ??
      DEFAULT_APPROVAL_PATH,
    DEFAULT_APPROVAL_PATH,
  );
  const apiCookieHeader = normalizeNullableString(
    readArgValue(argv, "--api-cookie-header") ?? env.SEOJEOM_API_COOKIE_HEADER,
  );
  const apiHeaderName = normalizeNullableString(
    readArgValue(argv, "--api-header-name") ?? env.SEOJEOM_API_HEADER_NAME,
  );
  const apiHeaderValue = normalizeNullableString(
    readArgValue(argv, "--api-header-value") ?? env.SEOJEOM_API_HEADER_VALUE,
  );

  if ((apiHeaderName == null) !== (apiHeaderValue == null)) {
    throw new Error("api header name/value must be provided together");
  }

  if (!wikiAuthority) {
    throw new Error(
      `invalid --wiki-authority value: ${wikiAuthorityRaw} (expected api-bridge or local-filesystem)`,
    );
  }
  if (!graphAuthority) {
    throw new Error(
      `invalid --graph-authority value: ${graphAuthorityRaw} (expected api-bridge or local-snapshot)`,
    );
  }

  return {
    host,
    port,
    transport: "streamable-http",
    wikiAuthority,
    graphAuthority,
    graphSlicePath,
    projectId,
    projectRoot,
    mcpPath,
    healthPath: DEFAULT_HEALTH_PATH,
    approvalPath,
    serverName: DEFAULT_SERVER_NAME,
    serverVersion: DEFAULT_SERVER_VERSION,
    startedAt: new Date().toISOString(),
    apiBaseUrl,
    apiCookieHeader,
    apiHeaderName,
    apiHeaderValue,
  };
}

export function buildDesktopMcpHealthSnapshot(
  config: DesktopMcpServerConfig,
  actualPort: number,
): DesktopMcpHealthSnapshot {
  return {
    status: "ok",
    projectId: config.projectId,
    projectRoot: config.projectRoot,
    transport: config.transport,
    host: config.host,
    port: actualPort,
    mcpPath: config.mcpPath,
    approvalPath: config.approvalPath,
    startedAt: config.startedAt,
    pid: process.pid,
  };
}
