import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import { analyzeLocalGraphGaps } from "../local-graph-gap-analysis.js";
import { buildLocalGraphContext, type GraphContextResult } from "./graph-context.js";
import {
  buildWikiCreateAction,
  collectWorkflowWikiMatches,
  type WorkflowWikiMatch,
} from "./graph-workflow.js";
import { preview } from "./shared.js";

export type ResearchPrepTask = {
  id: string;
  priority: number;
  stage: "read_local_wiki" | "search_local_wiki" | "write_local_wiki" | "external_search";
  title: string;
  rationale: string;
  preferredTool:
    | "seojeom_read_wiki"
    | "seojeom_search_wiki_pages"
    | "seojeom_write_wiki"
    | "external_web_search";
  argumentsHint: Record<string, unknown> | null;
  query: string | null;
  domainHints: string[];
};

export type GraphResearchPrepResult = {
  ok: true;
  authority: "local-snapshot";
  focusNodeId: string | null;
  atEpisode: number | null;
  summary: string;
  context: GraphContextResult;
  wikiMatches: WorkflowWikiMatch[];
  researchTasks: ResearchPrepTask[];
  warnings: string[];
};

export type UnsupportedGraphResearchPrepResult = {
  ok: false;
  code: "GRAPH_AUTHORITY_UNSUPPORTED";
  error: string;
};

export type GraphResearchPrepToolResult =
  | GraphResearchPrepResult
  | UnsupportedGraphResearchPrepResult;

const EXTERNAL_RESEARCHABLE_NODE_TYPES = new Set([
  "location",
  "organization",
  "item",
  "world_rule",
  "world_system",
  "event",
]);

function buildResearchSummary(input: {
  focusNodeId: string | null;
  taskCount: number;
  wikiMatchCount: number;
}) {
  const prefix = input.focusNodeId ? `node ${input.focusNodeId}` : "graph";
  if (input.taskCount === 0) {
    return `${prefix} does not need extra research prep right now.`;
  }
  return `${prefix} research prep produced ${input.taskCount} task(s)` +
    (input.wikiMatchCount > 0 ? ` with ${input.wikiMatchCount} local wiki match(es).` : ".");
}

function buildExternalQueries(node: GraphContextResult["focusNode"]) {
  if (!node || !EXTERNAL_RESEARCHABLE_NODE_TYPES.has(node.type)) {
    return [] as Array<{ query: string; domainHints: string[]; rationale: string }>;
  }

  switch (node.type) {
    case "location":
      return [
        {
          query: `${node.label} history map culture overview`,
          domainHints: ["wikipedia.org", "britannica.com"],
          rationale: "장소 배경과 문화/공간 정보를 보강할 수 있습니다.",
        },
      ];
    case "organization":
      return [
        {
          query: `${node.label} organization structure leadership mission`,
          domainHints: ["official site", "wikipedia.org"],
          rationale: "조직 구조와 목적, 외부 인식 정보를 보강할 수 있습니다.",
        },
      ];
    case "item":
      return [
        {
          query: `${node.label} origin design usage reference`,
          domainHints: ["manufacturer", "wikipedia.org"],
          rationale: "아이템 기원, 사용성, 디자인 레퍼런스를 찾을 수 있습니다.",
        },
      ];
    case "world_rule":
    case "world_system":
      return [
        {
          query: `${node.label} rules limitations examples`,
          domainHints: ["fandom wiki", "design essay"],
          rationale: "규칙과 제약, 예시 레퍼런스를 수집할 수 있습니다.",
        },
      ];
    case "event":
      return [
        {
          query: `${node.label} timeline causes outcomes reference`,
          domainHints: ["history source", "encyclopedia"],
          rationale: "사건 원인과 결과 구조를 보강할 수 있습니다.",
        },
      ];
    default:
      return [];
  }
}

function renderResearchPrepText(result: GraphResearchPrepToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[graph research prep] tasks=${result.researchTasks.length}`,
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
  for (const task of result.researchTasks) {
    lines.push(`- [${task.priority}] ${task.title} -> ${task.preferredTool}`);
    lines.push(`  ${preview(task.rationale, 180) ?? task.rationale}`);
  }
  return lines.join("\n");
}

export function registerGraphResearchPrepTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_prepare_graph_research",
    {
      title: "Prepare Local Graph Research",
      description:
        "Build a local-first research plan from graph context, wiki matches, and gap findings without running external web search.",
      inputSchema: {
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        maxNodes: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ focusNodeId, atEpisode, neighborDepth, maxNodes }) => {
      const result = await prepareLocalGraphResearch({
        context,
        focusNodeId,
        atEpisode,
        neighborDepth,
        maxNodes,
      });

      return {
        content: [{ type: "text" as const, text: renderResearchPrepText(result) }],
        structuredContent: result,
      };
    },
  );
}

export async function prepareLocalGraphResearch(input: {
  context: DesktopMcpContext;
  focusNodeId?: string | null;
  atEpisode?: number | null;
  neighborDepth?: 0 | 1 | 2;
  maxNodes?: number;
}): Promise<GraphResearchPrepToolResult> {
  const focusNodeId = input.focusNodeId?.trim() || null;
  const atEpisode = input.atEpisode ?? null;

  if (!input.context.localGraphStore) {
    return {
      ok: false,
      code: "GRAPH_AUTHORITY_UNSUPPORTED",
      error: "seojeom_prepare_graph_research requires graphAuthority=local-snapshot.",
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
    maxFindings: 6,
  });
  const wikiMatches = await collectWorkflowWikiMatches({
    context: input.context,
    graphContext,
  });

  const tasks: ResearchPrepTask[] = [];
  let priority = 0;

  for (const match of wikiMatches.slice(0, 3)) {
    priority += 1;
    tasks.push({
      id: `wiki-read:${match.documentId}`,
      priority,
      stage: "read_local_wiki",
      title: `로컬 wiki 읽기 · ${match.title}`,
      rationale: `focus node와 관련된 local wiki page가 이미 있습니다 (${match.matchReason}).`,
      preferredTool: "seojeom_read_wiki",
      argumentsHint: {
        pageId: match.documentId,
        includeSections: true,
      },
      query: null,
      domainHints: [],
    });
  }

  const focusNode = graphContext.focusNode;
  const hasFocusWikiMatch = Boolean(
    focusNode &&
      wikiMatches.some(
        (match: WorkflowWikiMatch) => match.primaryNodeRef === focusNode.id,
      ),
  );

  if (focusNode && !hasFocusWikiMatch) {
    priority += 1;
    tasks.push({
      id: `wiki-search:${focusNode.id}`,
      priority,
      stage: "search_local_wiki",
      title: `로컬 wiki 검색 · ${focusNode.label}`,
      rationale: "focus node와 직접 연결된 wiki page가 없어 먼저 로컬 문서를 다시 확인합니다.",
      preferredTool: "seojeom_search_wiki_pages",
      argumentsHint: {
        query: focusNode.label,
      },
      query: focusNode.label,
      domainHints: [],
    });

    const wikiCreateAction = buildWikiCreateAction({
      focusNode,
      priority: priority + 1,
    });
    if (wikiCreateAction) {
      priority += 1;
      tasks.push({
        id: wikiCreateAction.id,
        priority,
        stage: "write_local_wiki",
        title: wikiCreateAction.title,
        rationale: wikiCreateAction.rationale,
        preferredTool: "seojeom_write_wiki",
        argumentsHint: wikiCreateAction.argumentsHint,
        query: null,
        domainHints: [],
      });
    }
  }

  const shouldSuggestExternalResearch = Boolean(
    focusNode &&
      !hasFocusWikiMatch &&
      (gapResult.findings.length > 0 || !focusNode.summary),
  );
  if (shouldSuggestExternalResearch) {
    for (const suggestion of buildExternalQueries(focusNode).slice(0, 2)) {
      priority += 1;
      tasks.push({
        id: `external-search:${focusNode?.id}:${priority}`,
        priority,
        stage: "external_search",
        title: `외부 조사 질의 · ${focusNode?.label}`,
        rationale: suggestion.rationale,
        preferredTool: "external_web_search",
        argumentsHint: {
          query: suggestion.query,
          domainHints: suggestion.domainHints,
        },
        query: suggestion.query,
        domainHints: suggestion.domainHints,
      });
    }
  }

  return {
    ok: true,
    authority: "local-snapshot",
    focusNodeId,
    atEpisode,
    summary: buildResearchSummary({
      focusNodeId,
      taskCount: tasks.length,
      wikiMatchCount: wikiMatches.length,
    }),
    context: graphContext,
    wikiMatches,
    researchTasks: tasks,
    warnings: Array.from(new Set([...graphContext.warnings, ...gapResult.warnings])),
  };
}
