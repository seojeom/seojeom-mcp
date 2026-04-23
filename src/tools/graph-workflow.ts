import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import {
  analyzeLocalGraphGaps,
  type LocalGraphGapFinding,
} from "../local-graph-gap-analysis.js";
import {
  buildLocalGraphContext,
  type GraphContextResult,
  type UnsupportedGraphContextResult,
} from "./graph-context.js";
import { preview } from "./shared.js";

export type WorkflowRecommendedAction = {
  id: string;
  priority: number;
  title: string;
  rationale: string;
  targetRef: string | null;
  preferredTool:
    | "seojeom_propose_node"
    | "seojeom_propose_edge"
    | "seojeom_apply_graph_mutation"
    | "seojeom_write_wiki";
  alternativeTools: Array<
    | "seojeom_propose_node"
    | "seojeom_propose_edge"
    | "seojeom_apply_graph_mutation"
    | "seojeom_write_wiki"
  >;
  argumentsHint: Record<string, unknown> | null;
  prompt: string;
};

export type WorkflowWikiMatch = {
  documentId: string;
  title: string;
  canonicalPath: string | null;
  primaryNodeRef: string | null;
  noteClass: string | null;
  updatedAt: string | null;
  score: number;
  matchReason: "primary_node" | "title" | "tag" | "section_heading" | "section_body" | "body";
  matchedSnippet: string | null;
};

export type GraphWorkflowResult = {
  ok: true;
  authority: "local-snapshot";
  focusNodeId: string | null;
  atEpisode: number | null;
  summary: string;
  context: GraphContextResult;
  findings: LocalGraphGapFinding[];
  wikiMatches: WorkflowWikiMatch[];
  recommendedActions: WorkflowRecommendedAction[];
  warnings: string[];
};

export type UnsupportedGraphWorkflowResult = UnsupportedGraphContextResult;

export type GraphWorkflowToolResult = GraphWorkflowResult | UnsupportedGraphWorkflowResult;

function parseMissingCoreTypes(message: string) {
  const match = /핵심 노드 타입이 비어 있습니다:\s*(.+)\./.exec(message);
  if (!match?.[1]) {
    return [] as string[];
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function mapFindingToAction(input: {
  finding: LocalGraphGapFinding;
  atEpisode: number | null;
  priority: number;
}): WorkflowRecommendedAction[] {
  const { finding } = input;

  if (finding.kind === "missing_core_type") {
    return parseMissingCoreTypes(finding.message).map((nodeType, index) => ({
      id: `${finding.id}:create-core:${nodeType}`,
      priority: input.priority + index,
      title: `핵심 ${nodeType} 노드 제안`,
      rationale: finding.message,
      targetRef: null,
      preferredTool: "seojeom_propose_node",
      alternativeTools: ["seojeom_apply_graph_mutation"],
      argumentsHint: {
        label: `<new-${nodeType}-label>`,
        nodeTypeHint: nodeType,
        summary: "<canon summary>",
      },
      prompt:
        `누락된 핵심 타입 ${nodeType}를 최소 한 개 제안하세요. ` +
        "현재 wiki와 graph context에 직접 근거가 있는 사실만 사용하세요.",
    }));
  }

  if (finding.kind === "missing_state_packet") {
    return [
      {
        id: `${finding.id}:packet`,
        priority: input.priority,
        title: `상태 패킷 보강 · ${finding.targetRef ?? "-"}`,
        rationale: finding.message,
        targetRef: finding.targetRef,
        preferredTool: "seojeom_apply_graph_mutation",
        alternativeTools: ["seojeom_propose_node"],
        argumentsHint: {
          mutation: {
            kind: "create_packet",
            nodeId: finding.targetRef,
            packet: {
              scopeLevel: "episode",
              ...(input.atEpisode != null
                ? { scopeEpisodeId: String(input.atEpisode) }
                : { scopeRef: "<episode-or-scope-ref>" }),
              summaryText: "<current state summary>",
              currentLocationRef: "<location-ref>",
              activeGoalRefs: ["<goal-ref>"],
            },
          },
        },
        prompt: finding.prompt,
      },
    ];
  }

  if (finding.kind === "empty_summary") {
    return [
      {
        id: `${finding.id}:summary`,
        priority: input.priority,
        title: `노드 요약 보강 · ${finding.targetRef ?? "-"}`,
        rationale: finding.message,
        targetRef: finding.targetRef,
        preferredTool: "seojeom_apply_graph_mutation",
        alternativeTools: ["seojeom_propose_node"],
        argumentsHint: {
          mutation: {
            kind: "update_node",
            nodeId: finding.targetRef,
            baseVersion: "<currentVersion>",
            patch: {
              summary: "<canonical summary>",
            },
          },
        },
        prompt: finding.prompt,
      },
    ];
  }

  const edgeType =
    finding.kind === "unresolved_foreshadowing" ? "foreshadows" : "<relation-type>";
  return [
    {
      id: `${finding.id}:edge`,
      priority: input.priority,
      title: `연결 보강 · ${finding.targetRef ?? "-"}`,
      rationale: finding.message,
      targetRef: finding.targetRef,
      preferredTool: "seojeom_propose_edge",
      alternativeTools: ["seojeom_apply_graph_mutation", "seojeom_propose_node"],
      argumentsHint: {
        sourceNodeId: finding.targetRef,
        targetNodeId: "<counterpart-node-ref>",
        edgeType,
        relationClass: "derived",
        summary: "<why these are connected>",
      },
      prompt: finding.prompt,
    },
  ];
}

function buildWorkflowSummary(input: {
  focusNodeId: string | null;
  findings: LocalGraphGapFinding[];
  actions: WorkflowRecommendedAction[];
  wikiMatches: WorkflowWikiMatch[];
}) {
  const prefix = input.focusNodeId ? `node ${input.focusNodeId}` : "graph";
  if (input.findings.length === 0) {
    return input.wikiMatches.length > 0
      ? `${prefix} has no deterministic workflow blockers right now, and ${input.wikiMatches.length} related wiki page(s) were found.`
      : `${prefix} has no deterministic workflow blockers right now.`;
  }
  return `${prefix} workflow prepared ${input.actions.length} recommended action(s) from ${input.findings.length} finding(s)` +
    (input.wikiMatches.length > 0 ? ` and ${input.wikiMatches.length} related wiki page(s).` : ".");
}

function renderWorkflowText(result: GraphWorkflowToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[graph workflow] actions=${result.recommendedActions.length} findings=${result.findings.length}`,
    `summary: ${result.summary}`,
  ];
  if (result.focusNodeId) {
    lines.push(`focus: ${result.focusNodeId}`);
  }
  if (result.wikiMatches.length > 0) {
    lines.push(`wikiMatches: ${result.wikiMatches.length}`);
  }
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const wikiMatch of result.wikiMatches.slice(0, 5)) {
    lines.push(`- [wiki] ${wikiMatch.title} (${wikiMatch.documentId}) · ${wikiMatch.matchReason}`);
  }
  for (const action of result.recommendedActions) {
    lines.push(
      `- [${action.priority}] ${action.title} -> ${action.preferredTool}` +
        (action.targetRef ? ` (${action.targetRef})` : ""),
    );
    lines.push(`  ${preview(action.rationale, 180) ?? action.rationale}`);
  }
  return lines.join("\n");
}

function inferWikiCreationShape(node: GraphContextResult["focusNode"]) {
  if (!node) {
    return null;
  }

  switch (node.type) {
    case "character":
      return { noteClass: "character_sheet", title: `${node.label} 인물 시트`, category: null };
    case "organization":
      return { noteClass: "organization", title: `${node.label} 조직 노트`, category: null };
    case "location":
      return { noteClass: "location", title: `${node.label} 장소 노트`, category: null };
    case "item":
      return { noteClass: "item", title: `${node.label} 아이템 노트`, category: null };
    default:
      return { noteClass: null, title: `${node.label} 노트`, category: "custom" };
  }
}

export async function collectWorkflowWikiMatches(input: {
  context: DesktopMcpContext;
  graphContext: GraphContextResult;
}) {
  if (!input.context.localWikiStore) {
    return [] as WorkflowWikiMatch[];
  }

  const focusNode = input.graphContext.focusNode;
  const allPages = await input.context.localWikiStore.listPages(200);
  const matches = new Map<string, WorkflowWikiMatch>();
  const pageById = new Map(allPages.map((page) => [page.id, page] as const));

  if (focusNode) {
    for (const page of allPages.filter((page) => page.primaryNodeRef === focusNode.id)) {
      matches.set(page.id, {
        documentId: page.id,
        title: page.title,
        canonicalPath: page.canonicalPath ?? null,
        primaryNodeRef: page.primaryNodeRef ?? null,
        noteClass: page.noteClass ?? null,
        updatedAt: page.updatedAt ?? null,
        score: 120,
        matchReason: "primary_node",
        matchedSnippet: page.title,
      });
    }
  }

  const searchTerms = Array.from(
    new Set(
      [
        focusNode?.label ?? null,
        ...input.graphContext.nodes.slice(0, 4).map((node) => node.label),
      ]
        .map((value) => value?.trim() ?? "")
        .filter((value) => value.length >= 2),
    ),
  ).slice(0, 4);

  for (const term of searchTerms) {
    const searchResult = await input.context.localWikiStore.searchPages(term, 8);
    for (const result of searchResult.results) {
      const existing = matches.get(result.documentId);
      if (existing && existing.score >= result.score) {
        continue;
      }
      const page = pageById.get(result.documentId);
      matches.set(result.documentId, {
        documentId: result.documentId,
        title: result.title,
        canonicalPath: result.canonicalPath,
        primaryNodeRef: result.primaryNodeRef,
        noteClass: page?.noteClass ?? null,
        updatedAt: result.updatedAt,
        score: result.score,
        matchReason: result.matchedField as WorkflowWikiMatch["matchReason"],
        matchedSnippet: result.matchedSnippet,
      });
    }
  }

  return Array.from(matches.values()).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  });
}

export function buildWikiCreateAction(input: {
  focusNode: GraphContextResult["focusNode"];
  priority: number;
}): WorkflowRecommendedAction | null {
  const creationShape = inferWikiCreationShape(input.focusNode);
  if (!creationShape || !input.focusNode) {
    return null;
  }

  return {
    id: `wiki-create:${input.focusNode.id}`,
    priority: input.priority,
    title: `관련 wiki 페이지 생성 · ${input.focusNode.label}`,
    rationale: `focus node ${input.focusNode.label}에 연결된 local wiki 페이지가 아직 없습니다.`,
    targetRef: input.focusNode.id,
    preferredTool: "seojeom_write_wiki",
    alternativeTools: [],
    argumentsHint: {
      mode: "create",
      title: creationShape.title,
      noteClass: creationShape.noteClass,
      category: creationShape.category,
      primaryNodeRef: input.focusNode.id,
      tags: [input.focusNode.label, input.focusNode.type],
      bodyMarkdown: `# ${creationShape.title}\n\n${input.focusNode.summary ?? ""}`.trim(),
    },
    prompt:
      `focus node "${input.focusNode.label}"에 대응하는 local wiki page를 만들고, ` +
      "현재 graph context에 이미 있는 사실만 정리하세요.",
  };
}

export function registerGraphWorkflowTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_prepare_graph_workflow",
    {
      title: "Prepare Local Graph Workflow",
      description:
        "Combine local graph context, local gap findings, and deterministic next-tool recommendations for Claude/Codex graph editing workflows.",
      inputSchema: {
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        maxNodes: z.number().int().min(1).max(20).optional(),
        maxFindings: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ focusNodeId, atEpisode, neighborDepth, maxNodes, maxFindings }) => {
      const result = await prepareLocalGraphWorkflow({
        context,
        focusNodeId,
        atEpisode,
        neighborDepth,
        maxNodes,
        maxFindings,
      });

      return {
        content: [{ type: "text" as const, text: renderWorkflowText(result) }],
        structuredContent: result,
      };
    },
  );
}

export async function prepareLocalGraphWorkflow(input: {
  context: DesktopMcpContext;
  focusNodeId?: string | null;
  atEpisode?: number | null;
  neighborDepth?: 0 | 1 | 2;
  maxNodes?: number;
  maxFindings?: number;
}): Promise<GraphWorkflowToolResult> {
  const focusNodeId = input.focusNodeId?.trim() || null;
  const atEpisode = input.atEpisode ?? null;

  if (!input.context.localGraphStore) {
    return {
      ok: false,
      code: "GRAPH_AUTHORITY_UNSUPPORTED",
      error: "seojeom_prepare_graph_workflow requires graphAuthority=local-snapshot.",
    };
  }

  const graphContext = await buildLocalGraphContext({
    context: input.context,
    focusNodeId,
    atEpisode,
    neighborDepth: input.neighborDepth,
    maxNodes: input.maxNodes,
  });
  const gapResult = await analyzeLocalGraphGaps({
    store: input.context.localGraphStore,
    focusNodeId,
    atEpisode,
    maxFindings: input.maxFindings,
  });
  const wikiMatches = await collectWorkflowWikiMatches({
    context: input.context,
    graphContext,
  });

  const recommendedActions = gapResult.findings.flatMap((finding, index) =>
    mapFindingToAction({
      finding,
      atEpisode,
      priority: index + 1,
    }),
  );
  const hasFocusWikiMatch = Boolean(
    graphContext.focusNode &&
      wikiMatches.some((match) => match.primaryNodeRef === graphContext.focusNode?.id),
  );
  if (graphContext.focusNode && !hasFocusWikiMatch) {
    const wikiCreateAction = buildWikiCreateAction({
      focusNode: graphContext.focusNode,
      priority: recommendedActions.length + 1,
    });
    if (wikiCreateAction) {
      recommendedActions.push(wikiCreateAction);
    }
  }

  return {
    ok: true,
    authority: "local-snapshot",
    focusNodeId,
    atEpisode,
    summary: buildWorkflowSummary({
      focusNodeId,
      findings: gapResult.findings,
      actions: recommendedActions,
      wikiMatches,
    }),
    context: graphContext,
    findings: gapResult.findings,
    wikiMatches,
    recommendedActions,
    warnings: Array.from(new Set([...graphContext.warnings, ...gapResult.warnings])),
  };
}
