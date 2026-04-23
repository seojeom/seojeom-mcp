import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import {
  analyzeLocalGraphGaps,
  type LocalGraphGapAnalysisResult,
  type LocalGraphGapFinding,
} from "../local-graph-gap-analysis.js";
import { preview } from "./shared.js";

type UnsupportedGraphGapAnalysisResult = {
  ok: false;
  code: "GRAPH_AUTHORITY_UNSUPPORTED";
  error: string;
};

type GraphGapAnalysisToolResult =
  | (LocalGraphGapAnalysisResult & { ok: true })
  | UnsupportedGraphGapAnalysisResult;

function renderFindingLine(finding: LocalGraphGapFinding) {
  return `- [${finding.severity}] ${finding.title}: ${preview(finding.message, 180) ?? finding.message}`;
}

function renderGraphGapAnalysisText(result: GraphGapAnalysisToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[graph gap analysis] findings=${result.counts.findingCount}`,
    `summary: ${result.summary}`,
    `snapshot: ${result.snapshot.versionToken} @ ${result.snapshot.snapshotAt}`,
  ];

  if (result.focusNodeId) {
    lines.push(`focus: ${result.focusNodeId}`);
  }
  if (result.atEpisode != null) {
    lines.push(`atEpisode: ${result.atEpisode}`);
  }
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const finding of result.findings) {
    lines.push(renderFindingLine(finding));
  }

  return lines.join("\n");
}

export function registerGraphGapAnalysisTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_analyze_graph_gaps",
    {
      title: "Analyze Local Graph Gaps",
      description:
        "Analyze structural and snapshot-derived graph gaps from the local canonical graph snapshot without calling upstream APIs or LLM workflows.",
      inputSchema: {
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        maxFindings: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ focusNodeId, atEpisode, maxFindings }) => {
      if (!context.localGraphStore) {
        const unsupportedResult: UnsupportedGraphGapAnalysisResult = {
          ok: false,
          code: "GRAPH_AUTHORITY_UNSUPPORTED",
          error: "seojeom_analyze_graph_gaps requires graphAuthority=local-snapshot.",
        };
        return {
          content: [{ type: "text" as const, text: renderGraphGapAnalysisText(unsupportedResult) }],
          structuredContent: unsupportedResult,
        };
      }

      const result: LocalGraphGapAnalysisResult & { ok: true } = {
        ok: true,
        ...(await analyzeLocalGraphGaps({
          store: context.localGraphStore,
          focusNodeId: focusNodeId ?? null,
          atEpisode: atEpisode ?? null,
          maxFindings,
        })),
      };

      return {
        content: [{ type: "text" as const, text: renderGraphGapAnalysisText(result) }],
        structuredContent: result,
      };
    },
  );
}
