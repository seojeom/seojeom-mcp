import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import { buildDesktopMcpHealthSnapshot } from "../config.js";

export function registerProjectTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_project_info",
    {
      title: "AINovel Project Info",
      description:
        "Return the currently bound desktop project metadata, loopback MCP status, and upstream bridge configuration summary.",
    },
    async () => {
      const localGraphSnapshotPath = context.localGraphStore
        ? await context.localGraphStore.getResolvedSnapshotPath()
        : null;
      const localProposalQueuePath = context.localProposalStore
        ? context.localProposalStore.getResolvedQueuePath()
        : null;
      const localGraphSceneStorePath = context.localGraphSceneStore
        ? context.localGraphSceneStore.getResolvedSceneStorePath()
        : null;
      const payload = {
        ...buildDesktopMcpHealthSnapshot(context.config, context.actualPort),
        serverName: context.config.serverName,
        serverVersion: context.config.serverVersion,
        authorities: {
          wiki: context.config.wikiAuthority,
          graph: context.config.graphAuthority,
        },
        localPaths: {
          graphSnapshotPath: localGraphSnapshotPath,
          proposalQueuePath: localProposalQueuePath,
          graphSceneStorePath: localGraphSceneStorePath,
        },
        upstream: {
          apiBaseUrl: context.apiBridge.getBaseUrl(),
          authMode: context.apiBridge.describeAuthMode(),
        },
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
      };
    },
  );
}
