import { existsSync } from "node:fs";
import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  StandaloneMcpApprovalController,
  type StandaloneMcpApprovalMode,
} from "./approval.js";
import { parseDesktopMcpServerConfig } from "./config.js";
import { createDesktopMcpServer } from "./server.js";
import {
  buildClaudeMcpOnboardingResult,
  renderClaudeMcpOnboardingText,
} from "./tools/graph-playbook.js";

function readStandaloneArgValue(argv: string[], flag: string) {
  const prefixed = `${flag}=`;
  const inline = argv.find((arg) => arg.startsWith(prefixed));
  if (inline) {
    return inline.slice(prefixed.length).trim() || null;
  }

  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }

  return next.trim() || null;
}

function parseApprovalMode(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): StandaloneMcpApprovalMode {
  const rawValue =
    readStandaloneArgValue(argv, "--approval-mode") ??
    env.SEOJEOM_MCP_APPROVAL_MODE ??
    "prompt";
  const normalized = rawValue.trim().toLowerCase();

  if (
    normalized === "always" ||
    normalized === "never" ||
    normalized === "prompt"
  ) {
    return normalized;
  }

  throw new Error(
    `invalid --approval-mode value: ${rawValue} (expected prompt, always, or never)`,
  );
}

function printHelp() {
  process.stdout.write(
    [
      "seojeom-mcp",
      "",
      "stdio MCP server for Claude/Codex local project access.",
      "",
      "shared flags:",
      "  --project-root <path>",
      "  --project-id <id>",
      "  --api-base-url <url>                 default: http://127.0.0.1:3000",
      "",
      "optional shared flags:",
      "  --graph-authority <api-bridge|local-snapshot>",
      "  --graph-slice-path <path>",
      "  --wiki-authority <api-bridge|local-filesystem>",
      "",
      "standalone-only flags:",
      "  --approval-mode <prompt|always|never>  default: prompt",
      "",
      "direct example:",
      "  seojeom-mcp --project-root . --project-id demo --graph-authority local-snapshot --approval-mode prompt",
      "",
      "Claude install example:",
      "  claude mcp add seojeom -- npx -y @seojeom/mcp-server --project-root . --project-id demo --graph-authority local-snapshot --approval-mode prompt",
      "",
      "pre-install onboarding:",
      "  seojeom-mcp --print-claude-onboarding --project-root . --focus-node-id character:serin",
      "  seojeom-mcp --print-claude-onboarding-json --project-root .",
      "",
      "recommended first MCP tool call after install:",
      "  seojeom_get_claude_mcp_onboarding",
    ].join("\n"),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (
    argv.includes("--print-claude-onboarding") ||
    argv.includes("--print-claude-onboarding-json")
  ) {
    const result = buildClaudeMcpOnboardingResult({
      projectRootHint: readStandaloneArgValue(argv, "--project-root"),
      focusNodeId: readStandaloneArgValue(argv, "--focus-node-id"),
    });
    const isJson = argv.includes("--print-claude-onboarding-json");
    process.stdout.write(
      isJson
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${renderClaudeMcpOnboardingText(result)}\n`,
    );
    return;
  }

  const config = {
    ...parseDesktopMcpServerConfig(argv, {
      ...process.env,
      SEOJEOM_MCP_WIKI_AUTHORITY:
        process.env.SEOJEOM_MCP_WIKI_AUTHORITY ?? "local-filesystem",
    }),
    transport: "stdio" as const,
    serverName: "seojeom-mcp",
  };
  const approvalMode = parseApprovalMode(argv);

  if (!existsSync(config.projectRoot)) {
    throw new Error(`project root does not exist: ${config.projectRoot}`);
  }

  process.chdir(config.projectRoot);

  const approval = new StandaloneMcpApprovalController({
    projectId: config.projectId,
    mode: approvalMode,
  });
  const server = createDesktopMcpServer(config, 0, approval);
  const transport = new StdioServerTransport();

  let closed = false;
  const shutdown = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await server.close();
    } finally {
      await transport.close().catch(() => undefined);
    }
  };

  transport.onerror = (error) => {
    process.stderr.write(
      `[seojeom-mcp] stdio transport error: ${error.message}\n`,
    );
  };
  transport.onclose = () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => {
        process.exit(0);
      });
    });
  }

  await server.connect(transport);
}

void main().catch((error) => {
  process.stderr.write(
    `[seojeom-mcp] failed to start: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
