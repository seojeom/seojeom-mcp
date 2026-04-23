import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import type { LocalGraphGapFinding } from "../local-graph-gap-analysis.js";
import type { GraphContextResult } from "./graph-context.js";
import {
  prepareLocalGraphResearch,
  type ResearchPrepTask,
} from "./graph-research-prep.js";
import { preview } from "./shared.js";
import {
  prepareLocalGraphWorkflow,
  type WorkflowRecommendedAction,
  type WorkflowWikiMatch,
} from "./graph-workflow.js";

type RunbookPreferredTool =
  | ResearchPrepTask["preferredTool"]
  | WorkflowRecommendedAction["preferredTool"];

export type GraphRunbookStep = {
  id: string;
  order: number;
  source: "research" | "workflow";
  phase:
    | "review_local_knowledge"
    | "capture_local_knowledge"
    | "external_research"
    | "apply_graph_change"
    | "propose_graph_change";
  title: string;
  rationale: string;
  preferredTool: RunbookPreferredTool;
  alternativeTools: RunbookPreferredTool[];
  argumentsHint: Record<string, unknown> | null;
  targetRef: string | null;
  dependsOnStepIds: string[];
  completionSignal: string;
  proceedWhen: string;
  operatorPrompt: string | null;
};

export type GraphRunbookResult = {
  ok: true;
  authority: "local-snapshot";
  focusNodeId: string | null;
  atEpisode: number | null;
  summary: string;
  context: GraphContextResult;
  findings: LocalGraphGapFinding[];
  wikiMatches: WorkflowWikiMatch[];
  researchTasks: ResearchPrepTask[];
  workflowActions: WorkflowRecommendedAction[];
  orderedSteps: GraphRunbookStep[];
  warnings: string[];
};

export type UnsupportedGraphRunbookResult = {
  ok: false;
  code: "GRAPH_AUTHORITY_UNSUPPORTED";
  error: string;
};

export type GraphRunbookToolResult =
  | GraphRunbookResult
  | UnsupportedGraphRunbookResult;

function buildRunbookSummary(input: {
  focusNodeId: string | null;
  researchTaskCount: number;
  workflowActionCount: number;
  stepCount: number;
}) {
  const prefix = input.focusNodeId ? `node ${input.focusNodeId}` : "graph";
  if (input.stepCount === 0) {
    return `${prefix} does not need a deterministic runbook right now.`;
  }
  return `${prefix} runbook prepared ${input.stepCount} ordered step(s) from ` +
    `${input.researchTaskCount} research task(s) and ${input.workflowActionCount} workflow action(s).`;
}

function buildResearchStepDetails(task: ResearchPrepTask) {
  switch (task.stage) {
    case "read_local_wiki":
      return {
        phase: "review_local_knowledge" as const,
        completionSignal: "Relevant local wiki pages were reviewed and key facts were extracted.",
        proceedWhen:
          "Proceed when the page either confirms the current graph state or exposes a concrete documentation gap.",
      };
    case "search_local_wiki":
      return {
        phase: "review_local_knowledge" as const,
        completionSignal: "Local wiki search is exhausted for the focus label and the best match set is known.",
        proceedWhen:
          "Proceed when the top local matches have been checked or you confirm the focus node is still undocumented.",
      };
    case "write_local_wiki":
      return {
        phase: "capture_local_knowledge" as const,
        completionSignal: "A local wiki page exists with the currently grounded facts for the focus node.",
        proceedWhen:
          "Proceed after saving the page or deciding the local graph already contains enough grounded documentation.",
      };
    case "external_search":
      return {
        phase: "external_research" as const,
        completionSignal: "At least one external reference or grounded fact has been collected, or the search was explicitly ruled unnecessary.",
        proceedWhen:
          "Proceed when you can cite a concrete fact to bring back into the wiki or graph, or when no trustworthy result is needed.",
      };
  }
}

function buildWorkflowStepDetails(action: WorkflowRecommendedAction) {
  switch (action.preferredTool) {
    case "seojeom_apply_graph_mutation":
      return {
        phase: "apply_graph_change" as const,
        completionSignal:
          "The mutation applies cleanly and the targeted packet, summary, or structural gap is reduced in the local snapshot.",
        proceedWhen:
          "Proceed when the snapshot reflects the intended state and no version conflict remains.",
      };
    case "seojeom_propose_node":
    case "seojeom_propose_edge":
      return {
        phase: "propose_graph_change" as const,
        completionSignal:
          "The proposal set is created and then approved/applied if the change is still needed.",
        proceedWhen:
          "Proceed when the missing entity or relation is either resolved or intentionally deferred.",
      };
    case "seojeom_write_wiki":
      return {
        phase: "capture_local_knowledge" as const,
        completionSignal: "A local wiki page exists for the focus entity and reflects the current grounded facts.",
        proceedWhen:
          "Proceed after the page is saved or when another earlier documentation step already closed the gap.",
      };
  }
}

function mapResearchTaskToRunbookStep(task: ResearchPrepTask): Omit<GraphRunbookStep, "order" | "dependsOnStepIds"> {
  const details = buildResearchStepDetails(task);
  return {
    id: task.id,
    source: "research",
    phase: details.phase,
    title: task.title,
    rationale: task.rationale,
    preferredTool: task.preferredTool,
    alternativeTools: [],
    argumentsHint: task.argumentsHint,
    targetRef: null,
    completionSignal: details.completionSignal,
    proceedWhen: details.proceedWhen,
    operatorPrompt: task.query
      ? `Use the prepared query "${task.query}" and keep any resulting facts grounded before editing the local wiki or graph.`
      : null,
  };
}

function mapWorkflowActionToRunbookStep(
  action: WorkflowRecommendedAction,
): Omit<GraphRunbookStep, "order" | "dependsOnStepIds"> {
  const details = buildWorkflowStepDetails(action);
  return {
    id: action.id,
    source: "workflow",
    phase: details.phase,
    title: action.title,
    rationale: action.rationale,
    preferredTool: action.preferredTool,
    alternativeTools: action.alternativeTools,
    argumentsHint: action.argumentsHint,
    targetRef: action.targetRef,
    completionSignal: details.completionSignal,
    proceedWhen: details.proceedWhen,
    operatorPrompt: action.prompt,
  };
}

function buildOrderedRunbookSteps(input: {
  researchTasks: ResearchPrepTask[];
  workflowActions: WorkflowRecommendedAction[];
}) {
  const seenIds = new Set<string>();
  const baseSteps: Array<Omit<GraphRunbookStep, "order" | "dependsOnStepIds">> = [];

  for (const task of input.researchTasks) {
    if (seenIds.has(task.id)) {
      continue;
    }
    seenIds.add(task.id);
    baseSteps.push(mapResearchTaskToRunbookStep(task));
  }

  for (const action of input.workflowActions) {
    if (seenIds.has(action.id)) {
      continue;
    }
    seenIds.add(action.id);
    baseSteps.push(mapWorkflowActionToRunbookStep(action));
  }

  return baseSteps.map((step, index) => ({
    ...step,
    order: index + 1,
    dependsOnStepIds: index > 0 ? [baseSteps[index - 1]?.id].filter(Boolean) : [],
  }));
}

function renderRunbookText(result: GraphRunbookToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[graph runbook] steps=${result.orderedSteps.length}`,
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
  for (const step of result.orderedSteps.slice(0, 8)) {
    lines.push(
      `- [${step.order}] ${step.title} -> ${step.preferredTool}` +
        (step.targetRef ? ` (${step.targetRef})` : ""),
    );
    lines.push(`  ${preview(step.rationale, 180) ?? step.rationale}`);
  }
  return lines.join("\n");
}

export async function prepareLocalGraphRunbook(input: {
  context: DesktopMcpContext;
  focusNodeId?: string | null;
  atEpisode?: number | null;
  neighborDepth?: 0 | 1 | 2;
  maxNodes?: number;
  maxFindings?: number;
}): Promise<GraphRunbookToolResult> {
  const workflowResult = await prepareLocalGraphWorkflow({
    context: input.context,
    focusNodeId: input.focusNodeId,
    atEpisode: input.atEpisode,
    neighborDepth: input.neighborDepth,
    maxNodes: input.maxNodes,
    maxFindings: input.maxFindings,
  });
  if (!workflowResult.ok) {
    return {
      ok: false,
      code: workflowResult.code,
      error: "seojeom_prepare_graph_runbook requires graphAuthority=local-snapshot.",
    };
  }

  const researchResult = await prepareLocalGraphResearch({
    context: input.context,
    focusNodeId: input.focusNodeId,
    atEpisode: input.atEpisode,
    neighborDepth: input.neighborDepth,
    maxNodes: input.maxNodes,
  });
  if (!researchResult.ok) {
    return {
      ok: false,
      code: researchResult.code,
      error: "seojeom_prepare_graph_runbook requires graphAuthority=local-snapshot.",
    };
  }

  const orderedSteps = buildOrderedRunbookSteps({
    researchTasks: researchResult.researchTasks,
    workflowActions: workflowResult.recommendedActions,
  });

  return {
    ok: true,
    authority: "local-snapshot",
    focusNodeId: workflowResult.focusNodeId,
    atEpisode: workflowResult.atEpisode,
    summary: buildRunbookSummary({
      focusNodeId: workflowResult.focusNodeId,
      researchTaskCount: researchResult.researchTasks.length,
      workflowActionCount: workflowResult.recommendedActions.length,
      stepCount: orderedSteps.length,
    }),
    context: workflowResult.context,
    findings: workflowResult.findings,
    wikiMatches: workflowResult.wikiMatches,
    researchTasks: researchResult.researchTasks,
    workflowActions: workflowResult.recommendedActions,
    orderedSteps,
    warnings: Array.from(new Set([...workflowResult.warnings, ...researchResult.warnings])),
  };
}

export function registerGraphRunbookTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_prepare_graph_runbook",
    {
      title: "Prepare Local Graph Runbook",
      description:
        "Combine local graph workflow and local-first research prep into one ordered runbook for Claude/Codex graph editing sessions.",
      inputSchema: {
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        maxNodes: z.number().int().min(1).max(20).optional(),
        maxFindings: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ focusNodeId, atEpisode, neighborDepth, maxNodes, maxFindings }) => {
      const result = await prepareLocalGraphRunbook({
        context,
        focusNodeId,
        atEpisode,
        neighborDepth,
        maxNodes,
        maxFindings,
      });

      return {
        content: [{ type: "text" as const, text: renderRunbookText(result) }],
        structuredContent: result,
      };
    },
  );
}
