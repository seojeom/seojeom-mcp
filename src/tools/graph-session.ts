import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import type { GraphContextResult } from "./graph-context.js";
import {
  prepareLocalGraphRunbook,
  type GraphRunbookResult,
  type GraphRunbookStep,
} from "./graph-runbook.js";
import { preview } from "./shared.js";

export type GraphSessionToolCall = {
  order: number;
  toolName: GraphRunbookStep["preferredTool"];
  argumentsHint: Record<string, unknown> | null;
  why: string;
  stopCondition: string;
  targetRef: string | null;
  dependsOnStepIds: string[];
};

export type GraphSessionResult = {
  ok: true;
  authority: "local-snapshot";
  focusNodeId: string | null;
  atEpisode: number | null;
  summary: string;
  objective: string;
  context: GraphContextResult;
  groundingRules: string[];
  toolSequence: GraphSessionToolCall[];
  operatorBrief: string;
  copyablePrompt: string;
  completionChecklist: string[];
  warnings: string[];
};

export type UnsupportedGraphSessionResult = {
  ok: false;
  code: "GRAPH_AUTHORITY_UNSUPPORTED";
  error: string;
};

export type GraphSessionToolResult =
  | GraphSessionResult
  | UnsupportedGraphSessionResult;

export type FocusedGraphSessionKind =
  | "wiki_documentation"
  | "packet_repair"
  | "relation_fill_in";

export type GraphFocusedSessionResult = {
  ok: true;
  authority: "local-snapshot";
  sessionKind: FocusedGraphSessionKind;
  focusNodeId: string | null;
  atEpisode: number | null;
  summary: string;
  objective: string;
  context: GraphContextResult;
  selectedFindings: GraphRunbookResult["findings"];
  selectedSteps: GraphRunbookStep[];
  groundingRules: string[];
  toolSequence: GraphSessionToolCall[];
  operatorBrief: string;
  copyablePrompt: string;
  completionChecklist: string[];
  warnings: string[];
};

export type UnsupportedFocusedGraphSessionResult = {
  ok: false;
  code: "GRAPH_AUTHORITY_UNSUPPORTED";
  error: string;
};

export type GraphFocusedSessionToolResult =
  | GraphFocusedSessionResult
  | UnsupportedFocusedGraphSessionResult;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function isWikiToolName(
  toolName: GraphRunbookStep["preferredTool"] | GraphSessionToolCall["toolName"],
) {
  return (
    toolName === "seojeom_read_wiki" ||
    toolName === "seojeom_search_wiki_pages" ||
    toolName === "seojeom_write_wiki"
  );
}

function mutationKindFromStep(step: GraphRunbookStep) {
  const mutation = asRecord(asRecord(step.argumentsHint).mutation);
  const kind = mutation.kind;
  return typeof kind === "string" ? kind : null;
}

function selectFocusedRunbook(input: {
  runbook: GraphRunbookResult;
  sessionKind: FocusedGraphSessionKind;
}) {
  let selectedFindingKinds: Array<GraphRunbookResult["findings"][number]["kind"]> = [];
  let selectedSteps = input.runbook.orderedSteps.filter(() => false);

  if (input.sessionKind === "wiki_documentation") {
    selectedSteps = input.runbook.orderedSteps.filter(
      (step) => isWikiToolName(step.preferredTool) || step.preferredTool === "external_web_search",
    );
  } else if (input.sessionKind === "packet_repair") {
    selectedFindingKinds = ["missing_state_packet", "empty_summary"];
    selectedSteps = input.runbook.orderedSteps.filter((step) => {
      if (isWikiToolName(step.preferredTool)) {
        return true;
      }
      if (step.preferredTool !== "seojeom_apply_graph_mutation") {
        return false;
      }
      const mutationKind = mutationKindFromStep(step);
      return (
        mutationKind === "create_packet" ||
        mutationKind === "update_packet" ||
        mutationKind === "update_node"
      );
    });
  } else if (input.sessionKind === "relation_fill_in") {
    selectedFindingKinds = ["orphan_node", "weak_hub", "unresolved_foreshadowing"];
    selectedSteps = input.runbook.orderedSteps.filter(
      (step) =>
        isWikiToolName(step.preferredTool) ||
        step.preferredTool === "external_web_search" ||
        step.preferredTool === "seojeom_propose_edge",
    );
  }

  const selectedStepIds = new Set(selectedSteps.map((step) => step.id));
  const normalizedSteps = selectedSteps.map((step, index) => ({
    ...step,
    order: index + 1,
    dependsOnStepIds: step.dependsOnStepIds.filter((stepId) => selectedStepIds.has(stepId)),
  }));

  return {
    selectedSteps: normalizedSteps,
    selectedFindings:
      selectedFindingKinds.length > 0
        ? input.runbook.findings.filter((finding) => selectedFindingKinds.includes(finding.kind))
        : [],
  };
}

function buildFocusedObjective(input: {
  sessionKind: FocusedGraphSessionKind;
  runbook: GraphRunbookResult;
}) {
  const focusLabel = input.runbook.focusNodeId ?? "graph";

  switch (input.sessionKind) {
    case "wiki_documentation":
      return `Review and improve grounded local wiki coverage around ${focusLabel}.`;
    case "packet_repair":
      return `Repair grounded state-packet and summary gaps around ${focusLabel}.`;
    case "relation_fill_in":
      return `Fill grounded relation gaps around ${focusLabel} without expanding beyond the current local context unless needed.`;
  }
}

function buildFocusedGroundingRules(input: {
  sessionKind: FocusedGraphSessionKind;
  runbook: GraphRunbookResult;
}) {
  const rules = [
    "Stay inside local wiki and local graph authorities before broadening scope.",
    "Keep every step grounded in current local context; do not invent unsupported facts.",
  ];

  if (input.sessionKind === "wiki_documentation") {
    rules.push("Prefer local wiki reuse and local wiki creation before any graph edits.");
    rules.push("If external research is used, capture the grounded fact in local wiki rather than mutating the graph directly.");
  }

  if (input.sessionKind === "packet_repair") {
    rules.push("Use local wiki or current graph facts to justify packet and summary changes.");
    rules.push("Packet repair should change only current-state or canonical summary fields, not speculative future outcomes.");
  }

  if (input.sessionKind === "relation_fill_in") {
    rules.push("Prefer proposing missing edges before proposing new nodes.");
    rules.push("Only broaden with external research when the current local context cannot justify the relation target.");
  }

  if (input.runbook.wikiMatches.length === 0) {
    rules.push("No local wiki match exists yet, so capture documentation before relying on memory.");
  }

  return rules;
}

function buildFocusedSummary(input: {
  sessionKind: FocusedGraphSessionKind;
  focusNodeId: string | null;
  stepCount: number;
}) {
  const prefix = input.focusNodeId ? `node ${input.focusNodeId}` : "graph";
  if (input.stepCount === 0) {
    return `${prefix} has no deterministic ${input.sessionKind} steps right now.`;
  }
  return `${prefix} focused ${input.sessionKind} session prepared ${input.stepCount} ordered step(s).`;
}

function buildFocusedOperatorBrief(input: {
  sessionKind: FocusedGraphSessionKind;
  focusNodeId: string | null;
  objective: string;
  groundingRules: string[];
  steps: GraphRunbookStep[];
}) {
  const lines = [
    `Session kind: ${input.sessionKind}`,
    `Objective: ${input.objective}`,
    `Focus: ${input.focusNodeId ?? "graph"}`,
    "",
    "Grounding rules:",
    ...input.groundingRules.map((rule) => `- ${rule}`),
    "",
    "Ordered steps:",
    ...input.steps.slice(0, 8).map((step) => {
      const suffix = step.targetRef ? ` (${step.targetRef})` : "";
      return `${step.order}. ${step.preferredTool}${suffix} — ${preview(step.rationale, 160) ?? step.rationale}`;
    }),
  ];
  return lines.join("\n");
}

function buildFocusedCopyablePrompt(input: {
  sessionKind: FocusedGraphSessionKind;
  focusNodeId: string | null;
  objective: string;
  groundingRules: string[];
  steps: GraphRunbookStep[];
}) {
  return [
    `Run a local-first ${input.sessionKind} session.`,
    input.objective,
    `Focus node: ${input.focusNodeId ?? "none"}`,
    "",
    "Grounding rules:",
    ...input.groundingRules.map((rule) => `- ${rule}`),
    "",
    "Execute these tool calls in order:",
    ...input.steps.slice(0, 8).map((step) => {
      const targetSuffix = step.targetRef ? ` target=${step.targetRef}` : "";
      return `${step.order}. Call ${step.preferredTool}${targetSuffix}. Stop when: ${step.completionSignal}`;
    }),
  ].join("\n");
}

function buildFocusedCompletionChecklist(input: {
  sessionKind: FocusedGraphSessionKind;
  objective: string;
  steps: GraphRunbookStep[];
}) {
  const checklist = [`Objective is still satisfied: ${input.objective}`];

  if (input.sessionKind === "wiki_documentation") {
    checklist.push("Local wiki now reflects the grounded facts you decided to keep.");
    checklist.push("No graph mutation was required to finish the documentation pass.");
  } else if (input.sessionKind === "packet_repair") {
    checklist.push("Updated packet or summary fields were re-read from the local graph after mutation.");
    checklist.push("No stale version conflict remains on the repaired node.");
  } else if (input.sessionKind === "relation_fill_in") {
    checklist.push("Each missing relation is either proposed with grounded rationale or explicitly deferred.");
    checklist.push("No relation proposal depends on facts that were never captured locally.");
  }

  if (input.steps.some((step) => step.preferredTool === "external_web_search")) {
    checklist.push("Any external fact that survived review was captured locally before downstream graph edits.");
  }

  return checklist;
}

function renderFocusedGraphSessionText(result: GraphFocusedSessionToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[focused graph session] kind=${result.sessionKind} steps=${result.toolSequence.length}`,
    `summary: ${result.summary}`,
    `objective: ${result.objective}`,
  ];
  if (result.focusNodeId) {
    lines.push(`focus: ${result.focusNodeId}`);
  }
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const call of result.toolSequence.slice(0, 8)) {
    lines.push(
      `- [${call.order}] ${call.toolName}` + (call.targetRef ? ` (${call.targetRef})` : ""),
    );
    lines.push(`  ${preview(call.why, 180) ?? call.why}`);
  }
  return lines.join("\n");
}

function buildObjective(result: GraphRunbookResult) {
  if (result.focusNodeId && result.findings.length > 0) {
    return `Resolve the highest-priority grounded wiki and graph gaps around ${result.focusNodeId}.`;
  }
  if (result.focusNodeId) {
    return `Review and update the grounded local context for ${result.focusNodeId}.`;
  }
  return "Review the grounded local wiki and graph state, then apply the next deterministic change.";
}

function buildGroundingRules(result: GraphRunbookResult) {
  const rules = [
    "Start from local wiki and local graph context before proposing new facts.",
    "Treat external research as optional input; do not write new graph facts until they are grounded in the local wiki or a clearly cited note.",
    "Prefer direct local mutation for summary or packet fixes, and prefer proposal tools for new entities or new relationships.",
    "After every mutating step, verify the resulting local graph or wiki state before moving on.",
  ];

  if (result.wikiMatches.length === 0) {
    rules.push("If the focus entity has no local wiki coverage, capture a local wiki page before broadening graph scope.");
  }
  if (result.findings.some((finding) => finding.kind === "missing_state_packet")) {
    rules.push("State-packet gaps should be closed with grounded current-state facts, not speculative future state.");
  }

  return rules;
}

function buildToolSequence(steps: GraphRunbookStep[]): GraphSessionToolCall[] {
  return steps.map((step) => ({
    order: step.order,
    toolName: step.preferredTool,
    argumentsHint: step.argumentsHint,
    why: step.rationale,
    stopCondition: step.completionSignal,
    targetRef: step.targetRef,
    dependsOnStepIds: step.dependsOnStepIds,
  }));
}

function buildCompletionChecklist(input: {
  runbook: GraphRunbookResult;
  objective: string;
}) {
  const checklist = [
    `Objective is still satisfied: ${input.objective}`,
    "All accepted external facts are reflected in the local wiki before graph mutations depend on them.",
    "Any applied graph change was re-read or re-searched from the local authority afterward.",
  ];

  if (input.runbook.orderedSteps.some((step) => step.preferredTool === "seojeom_write_wiki")) {
    checklist.push("Local wiki coverage exists for the focus entity or the missing coverage was intentionally deferred.");
  }
  if (
    input.runbook.orderedSteps.some(
      (step) =>
        step.preferredTool === "seojeom_propose_node" ||
        step.preferredTool === "seojeom_propose_edge",
    )
  ) {
    checklist.push("Any proposal-based change was reviewed, approved, and applied only if still needed.");
  }

  return checklist;
}

function buildOperatorBrief(input: {
  runbook: GraphRunbookResult;
  objective: string;
  groundingRules: string[];
}) {
  const lines = [
    `Objective: ${input.objective}`,
    `Focus: ${input.runbook.focusNodeId ?? "graph"}`,
    "",
    "Grounding rules:",
    ...input.groundingRules.map((rule) => `- ${rule}`),
    "",
    "Ordered steps:",
    ...input.runbook.orderedSteps.slice(0, 8).map((step) => {
      const suffix = step.targetRef ? ` (${step.targetRef})` : "";
      return `${step.order}. ${step.preferredTool}${suffix} — ${preview(step.rationale, 160) ?? step.rationale}`;
    }),
  ];
  return lines.join("\n");
}

function buildCopyablePrompt(input: {
  runbook: GraphRunbookResult;
  objective: string;
  groundingRules: string[];
}) {
  const focusLine = input.runbook.focusNodeId
    ? `Focus node: ${input.runbook.focusNodeId}`
    : "Focus node: none";
  const stepLines = input.runbook.orderedSteps.slice(0, 8).map((step) => {
    const targetSuffix = step.targetRef ? ` target=${step.targetRef}` : "";
    return `${step.order}. Call ${step.preferredTool}${targetSuffix}. Stop when: ${step.completionSignal}`;
  });

  return [
    "Operate only on the local MCP authorities for wiki and graph state.",
    input.objective,
    focusLine,
    "",
    "Grounding rules:",
    ...input.groundingRules.map((rule) => `- ${rule}`),
    "",
    "Execute this tool sequence in order:",
    ...stepLines,
    "",
    "If external research is used, bring the grounded facts back into the local wiki before mutating the graph.",
  ].join("\n");
}

function renderGraphSessionText(result: GraphSessionToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[graph session] steps=${result.toolSequence.length}`,
    `summary: ${result.summary}`,
    `objective: ${result.objective}`,
  ];
  if (result.focusNodeId) {
    lines.push(`focus: ${result.focusNodeId}`);
  }
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const call of result.toolSequence.slice(0, 8)) {
    lines.push(
      `- [${call.order}] ${call.toolName}` + (call.targetRef ? ` (${call.targetRef})` : ""),
    );
    lines.push(`  ${preview(call.why, 180) ?? call.why}`);
  }
  return lines.join("\n");
}

export async function prepareLocalGraphSession(input: {
  context: DesktopMcpContext;
  focusNodeId?: string | null;
  atEpisode?: number | null;
  neighborDepth?: 0 | 1 | 2;
  maxNodes?: number;
  maxFindings?: number;
}): Promise<GraphSessionToolResult> {
  const runbook = await prepareLocalGraphRunbook(input);
  if (!runbook.ok) {
    return {
      ok: false,
      code: runbook.code,
      error: "seojeom_prepare_graph_session requires graphAuthority=local-snapshot.",
    };
  }

  const objective = buildObjective(runbook);
  const groundingRules = buildGroundingRules(runbook);

  return {
    ok: true,
    authority: "local-snapshot",
    focusNodeId: runbook.focusNodeId,
    atEpisode: runbook.atEpisode,
    summary:
      `${runbook.summary} Session contract prepared ${runbook.orderedSteps.length} executable tool step(s).`,
    objective,
    context: runbook.context,
    groundingRules,
    toolSequence: buildToolSequence(runbook.orderedSteps),
    operatorBrief: buildOperatorBrief({
      runbook,
      objective,
      groundingRules,
    }),
    copyablePrompt: buildCopyablePrompt({
      runbook,
      objective,
      groundingRules,
    }),
    completionChecklist: buildCompletionChecklist({
      runbook,
      objective,
    }),
    warnings: runbook.warnings,
  };
}

export function registerGraphSessionTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_prepare_graph_session",
    {
      title: "Prepare Local Graph Session",
      description:
        "Turn the local graph runbook into a Claude/Codex-ready session contract with grounding rules, ordered tool calls, and a copyable prompt.",
      inputSchema: {
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        maxNodes: z.number().int().min(1).max(20).optional(),
        maxFindings: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ focusNodeId, atEpisode, neighborDepth, maxNodes, maxFindings }) => {
      const result = await prepareLocalGraphSession({
        context,
        focusNodeId,
        atEpisode,
        neighborDepth,
        maxNodes,
        maxFindings,
      });

      return {
        content: [{ type: "text" as const, text: renderGraphSessionText(result) }],
        structuredContent: result,
      };
    },
  );
}

export async function prepareFocusedLocalGraphSession(input: {
  context: DesktopMcpContext;
  sessionKind: FocusedGraphSessionKind;
  focusNodeId?: string | null;
  atEpisode?: number | null;
  neighborDepth?: 0 | 1 | 2;
  maxNodes?: number;
  maxFindings?: number;
}): Promise<GraphFocusedSessionToolResult> {
  const runbook = await prepareLocalGraphRunbook(input);
  if (!runbook.ok) {
    return {
      ok: false,
      code: runbook.code,
      error: "seojeom_prepare_graph_focused_session requires graphAuthority=local-snapshot.",
    };
  }

  const { selectedSteps, selectedFindings } = selectFocusedRunbook({
    runbook,
    sessionKind: input.sessionKind,
  });
  const objective = buildFocusedObjective({
    sessionKind: input.sessionKind,
    runbook,
  });
  const groundingRules = buildFocusedGroundingRules({
    sessionKind: input.sessionKind,
    runbook,
  });

  return {
    ok: true,
    authority: "local-snapshot",
    sessionKind: input.sessionKind,
    focusNodeId: runbook.focusNodeId,
    atEpisode: runbook.atEpisode,
    summary: buildFocusedSummary({
      sessionKind: input.sessionKind,
      focusNodeId: runbook.focusNodeId,
      stepCount: selectedSteps.length,
    }),
    objective,
    context: runbook.context,
    selectedFindings,
    selectedSteps,
    groundingRules,
    toolSequence: buildToolSequence(selectedSteps),
    operatorBrief: buildFocusedOperatorBrief({
      sessionKind: input.sessionKind,
      focusNodeId: runbook.focusNodeId,
      objective,
      groundingRules,
      steps: selectedSteps,
    }),
    copyablePrompt: buildFocusedCopyablePrompt({
      sessionKind: input.sessionKind,
      focusNodeId: runbook.focusNodeId,
      objective,
      groundingRules,
      steps: selectedSteps,
    }),
    completionChecklist: buildFocusedCompletionChecklist({
      sessionKind: input.sessionKind,
      objective,
      steps: selectedSteps,
    }),
    warnings: runbook.warnings,
  };
}

export function registerFocusedGraphSessionTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_prepare_graph_focused_session",
    {
      title: "Prepare Focused Local Graph Session",
      description:
        "Prepare a focused local-first graph session for wiki documentation, packet repair, or relation fill-in work.",
      inputSchema: {
        sessionKind: z.enum(["wiki_documentation", "packet_repair", "relation_fill_in"]),
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        maxNodes: z.number().int().min(1).max(20).optional(),
        maxFindings: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ sessionKind, focusNodeId, atEpisode, neighborDepth, maxNodes, maxFindings }) => {
      const result = await prepareFocusedLocalGraphSession({
        context,
        sessionKind,
        focusNodeId,
        atEpisode,
        neighborDepth,
        maxNodes,
        maxFindings,
      });

      return {
        content: [{ type: "text" as const, text: renderFocusedGraphSessionText(result) }],
        structuredContent: result,
      };
    },
  );
}
