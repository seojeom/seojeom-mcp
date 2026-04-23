import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import type { GraphContextResult } from "./graph-context.js";
import {
  prepareFocusedLocalGraphSession,
  type FocusedGraphSessionKind,
  type GraphFocusedSessionResult,
} from "./graph-session.js";
import { preview } from "./shared.js";

export type GraphPlaybookKind =
  | "document_entity"
  | "repair_state"
  | "fill_relations"
  | "research_document_then_link";

export type GraphPlaybookPhase = {
  order: number;
  title: string;
  sessionKind: FocusedGraphSessionKind;
  objective: string;
  whyThisPhase: string;
  toolSequence: GraphFocusedSessionResult["toolSequence"];
  completionChecklist: string[];
  operatorBrief: string;
  copyablePrompt: string;
};

export type GraphPlaybookResult = {
  ok: true;
  authority: "local-snapshot";
  playbookKind: GraphPlaybookKind;
  focusNodeId: string | null;
  atEpisode: number | null;
  summary: string;
  whenToUse: string;
  context: GraphContextResult;
  phases: GraphPlaybookPhase[];
  verificationSteps: string[];
  approvalCheckpoints: string[];
  handoffPrompt: string;
  warnings: string[];
};

export type UnsupportedGraphPlaybookResult = {
  ok: false;
  code: "GRAPH_AUTHORITY_UNSUPPORTED";
  error: string;
};

export type GraphPlaybookToolResult =
  | GraphPlaybookResult
  | UnsupportedGraphPlaybookResult;

export type GraphPlaybookCatalogRow = {
  playbookKind: GraphPlaybookKind;
  title: string;
  whenToUse: string;
  phaseKinds: FocusedGraphSessionKind[];
  recommendedFocus: string;
  suggestedFirstTool: "seojeom_prepare_graph_playbook";
  argumentsHint: {
    playbookKind: GraphPlaybookKind;
    focusNodeId: string;
  };
  starterPrompt: string;
};

export type GraphPlaybookCatalogResult = {
  ok: true;
  summary: string;
  rows: GraphPlaybookCatalogRow[];
};

export type ClaudeMcpOnboardingResult = {
  ok: true;
  summary: string;
  install: {
    packageName: "@seojeom/mcp-server";
    claudeMcpAddCommand: string;
    directRunCommand: string;
    recommendedFlags: string[];
  };
  firstCalls: Array<{
    order: number;
    toolName: "seojeom_list_graph_playbooks" | "seojeom_prepare_graph_playbook";
    argumentsHint: Record<string, unknown>;
    why: string;
  }>;
  starterPrompt: string;
};

export function buildClaudeMcpOnboardingResult(input: {
  projectRootHint?: string | null;
  focusNodeId?: string | null;
}): ClaudeMcpOnboardingResult {
  const resolvedProjectRoot = input.projectRootHint?.trim() || "<project-root>";
  const resolvedFocusNodeId = input.focusNodeId?.trim() || null;

  return {
    ok: true,
    summary:
      "Install the MCP package into Claude, then start from the playbook catalog before choosing a concrete graph playbook.",
    install: {
      packageName: "@seojeom/mcp-server",
      claudeMcpAddCommand: buildClaudeMcpAddCommand(
        resolvedProjectRoot,
        resolvedFocusNodeId,
      ),
      directRunCommand: buildDirectRunCommand(resolvedProjectRoot),
      recommendedFlags: [
        "--project-root <path>",
        "--project-id <id>",
        "--graph-authority local-snapshot",
        "--approval-mode prompt",
      ],
    },
    firstCalls: [
      {
        order: 1,
        toolName: "seojeom_list_graph_playbooks",
        argumentsHint: resolvedFocusNodeId ? { focusNodeId: resolvedFocusNodeId } : {},
        why: "Start by discovering the right preset and starter prompt for the current task.",
      },
      {
        order: 2,
        toolName: "seojeom_prepare_graph_playbook",
        argumentsHint: {
          playbookKind: "document_entity",
          ...(resolvedFocusNodeId ? { focusNodeId: resolvedFocusNodeId } : {}),
        },
        why: "After choosing the preset, expand it into phased operator steps, approval checkpoints, and verification guidance.",
      },
    ],
    starterPrompt: resolvedFocusNodeId
      ? `Install the Seojeom MCP package, then call seojeom_list_graph_playbooks with focusNodeId=${resolvedFocusNodeId} before picking a playbook.`
      : "Install the Seojeom MCP package, then call seojeom_list_graph_playbooks before picking a playbook.",
  };
}

type PlaybookRecipe = {
  title: string;
  whenToUse: string;
  phaseKinds: FocusedGraphSessionKind[];
  phaseWhy: string[];
  verificationSteps: string[];
};

const PLAYBOOK_RECIPES: Record<GraphPlaybookKind, PlaybookRecipe> = {
  document_entity: {
    title: "Document Entity",
    whenToUse:
      "Use when the main gap is missing or stale local documentation for the focus entity.",
    phaseKinds: ["wiki_documentation"],
    phaseWhy: [
      "Establish or refresh grounded local wiki coverage before any broader graph work.",
    ],
    verificationSteps: [
      "Re-read the saved local wiki page or search result and confirm the grounded facts are present.",
      "Confirm no graph mutation was required unless a later session explicitly asks for one.",
    ],
  },
  repair_state: {
    title: "Repair State",
    whenToUse:
      "Use when the focus node is missing current-state packet data or a canonical summary update.",
    phaseKinds: ["packet_repair"],
    phaseWhy: [
      "Close packet and summary gaps first so later relation or planning work starts from a stable local state.",
    ],
    verificationSteps: [
      "Re-read the focus node from the local graph and confirm the packet or summary fields changed as intended.",
      "Confirm there is no remaining version conflict on the repaired node.",
    ],
  },
  fill_relations: {
    title: "Fill Relations",
    whenToUse:
      "Use when the focus node is under-connected or has unresolved relation gaps such as orphan, weak-hub, or foreshadowing issues.",
    phaseKinds: ["relation_fill_in"],
    phaseWhy: [
      "Concentrate on grounded relation proposals without broadening into unrelated packet or wiki repairs.",
    ],
    verificationSteps: [
      "Review the resulting proposal set or relation mutation and verify the rationale is grounded in local context.",
      "Confirm any accepted relation change is reflected in the local graph or proposal queue.",
    ],
  },
  research_document_then_link: {
    title: "Research, Document, Then Link",
    whenToUse:
      "Use when a focus entity is poorly documented and relation work should happen only after local documentation is refreshed.",
    phaseKinds: ["wiki_documentation", "relation_fill_in"],
    phaseWhy: [
      "Capture grounded local documentation first so relation work does not rely on memory.",
      "After documentation is stable, fill the remaining grounded relation gaps.",
    ],
    verificationSteps: [
      "Confirm the documentation phase produced or refreshed a local wiki page before relation work begins.",
      "Review any relation proposal or mutation against the newly captured local documentation.",
    ],
  },
};

function buildPlaybookStarterPrompt(input: {
  playbookKind: GraphPlaybookKind;
  focusNodeId: string;
  recipe: PlaybookRecipe;
}) {
  return [
    `Use the ${input.playbookKind} playbook for focus node ${input.focusNodeId}.`,
    input.recipe.whenToUse,
    `Call seojeom_prepare_graph_playbook with { "playbookKind": "${input.playbookKind}", "focusNodeId": "${input.focusNodeId}" }.`,
    "Then follow the phased handoff prompt and keep all edits grounded in local wiki and local graph state.",
  ].join(" ");
}

function buildPlaybookCatalogRow(input: {
  playbookKind: GraphPlaybookKind;
  focusNodeId: string;
}): GraphPlaybookCatalogRow {
  const recipe = PLAYBOOK_RECIPES[input.playbookKind];
  return {
    playbookKind: input.playbookKind,
    title: recipe.title,
    whenToUse: recipe.whenToUse,
    phaseKinds: recipe.phaseKinds,
    recommendedFocus: input.focusNodeId,
    suggestedFirstTool: "seojeom_prepare_graph_playbook",
    argumentsHint: {
      playbookKind: input.playbookKind,
      focusNodeId: input.focusNodeId,
    },
    starterPrompt: buildPlaybookStarterPrompt({
      playbookKind: input.playbookKind,
      focusNodeId: input.focusNodeId,
      recipe,
    }),
  };
}

function renderGraphPlaybookCatalogText(result: GraphPlaybookCatalogResult) {
  const lines = [`[graph playbook catalog] ${result.rows.length} preset(s)`, `summary: ${result.summary}`];
  for (const row of result.rows) {
    lines.push(`- ${row.playbookKind} -> ${row.title}`);
    lines.push(`  ${preview(row.whenToUse, 180) ?? row.whenToUse}`);
  }
  return lines.join("\n");
}

function buildClaudeMcpAddCommand(projectRoot: string, focusNodeId: string | null) {
  const focusComment = focusNodeId ? ` # first focus: ${focusNodeId}` : "";
  return (
    "claude mcp add seojeom -- npx -y @seojeom/mcp-server " +
    `--project-root ${projectRoot} ` +
    "--project-id demo-project " +
    "--graph-authority local-snapshot " +
    "--approval-mode prompt" +
    focusComment
  );
}

function buildDirectRunCommand(projectRoot: string) {
  return (
    "seojeom-mcp " +
    `--project-root ${projectRoot} ` +
    "--project-id demo-project " +
    "--graph-authority local-snapshot " +
    "--approval-mode prompt"
  );
}

export function renderClaudeMcpOnboardingText(result: ClaudeMcpOnboardingResult) {
  const lines = [
    "[claude mcp onboarding]",
    `summary: ${result.summary}`,
    `claude mcp add: ${result.install.claudeMcpAddCommand}`,
    `direct run: ${result.install.directRunCommand}`,
  ];
  for (const call of result.firstCalls) {
    lines.push(`- [${call.order}] ${call.toolName}`);
    lines.push(`  ${preview(call.why, 180) ?? call.why}`);
  }
  return lines.join("\n");
}

function buildApprovalCheckpoints(phases: GraphPlaybookPhase[]) {
  const checkpoints = new Set<string>();

  for (const phase of phases) {
    for (const step of phase.toolSequence) {
      if (step.toolName === "seojeom_apply_graph_mutation") {
        checkpoints.add("Before local mutation, confirm the arguments still match the grounded local facts.");
      }
      if (step.toolName === "seojeom_propose_node" || step.toolName === "seojeom_propose_edge") {
        checkpoints.add("After proposal creation, review and approve/apply only if the grounded need still exists.");
      }
      if (step.toolName === "seojeom_write_wiki") {
        checkpoints.add("Before saving wiki changes, remove any ungrounded facts and keep the note aligned with current local context.");
      }
    }
  }

  return Array.from(checkpoints);
}

function buildPlaybookSummary(input: {
  playbookKind: GraphPlaybookKind;
  focusNodeId: string | null;
  phaseCount: number;
}) {
  const prefix = input.focusNodeId ? `node ${input.focusNodeId}` : "graph";
  return `${prefix} playbook ${input.playbookKind} prepared ${input.phaseCount} phase(s).`;
}

function buildHandoffPrompt(input: {
  playbookKind: GraphPlaybookKind;
  focusNodeId: string | null;
  recipe: PlaybookRecipe;
  phases: GraphPlaybookPhase[];
}) {
  const focusLine = input.focusNodeId ? `Focus node: ${input.focusNodeId}` : "Focus node: none";
  const phaseLines = input.phases.map((phase) => {
    const toolList = phase.toolSequence.slice(0, 5).map((step) => step.toolName).join(", ");
    return `${phase.order}. ${phase.title} (${phase.sessionKind}) — tools: ${toolList || "none"}`;
  });

  return [
    `Run the ${input.playbookKind} playbook.`,
    focusLine,
    input.recipe.whenToUse,
    "",
    "Execute phases in order:",
    ...phaseLines,
    "",
    "Keep all edits grounded in local wiki and local graph state before broadening with external research.",
  ].join("\n");
}

function renderGraphPlaybookText(result: GraphPlaybookToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[graph playbook] kind=${result.playbookKind} phases=${result.phases.length}`,
    `summary: ${result.summary}`,
    `whenToUse: ${result.whenToUse}`,
  ];
  if (result.focusNodeId) {
    lines.push(`focus: ${result.focusNodeId}`);
  }
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const phase of result.phases) {
    lines.push(`- [${phase.order}] ${phase.title} (${phase.sessionKind})`);
    lines.push(`  ${preview(phase.whyThisPhase, 180) ?? phase.whyThisPhase}`);
  }
  return lines.join("\n");
}

export async function prepareLocalGraphPlaybook(input: {
  context: DesktopMcpContext;
  playbookKind: GraphPlaybookKind;
  focusNodeId?: string | null;
  atEpisode?: number | null;
  neighborDepth?: 0 | 1 | 2;
  maxNodes?: number;
  maxFindings?: number;
}): Promise<GraphPlaybookToolResult> {
  const recipe = PLAYBOOK_RECIPES[input.playbookKind];
  const phases: GraphPlaybookPhase[] = [];
  const warnings = new Set<string>();
  let context: GraphContextResult | null = null;
  let focusNodeId: string | null = input.focusNodeId?.trim() || null;
  let atEpisode: number | null = input.atEpisode ?? null;

  for (const [index, sessionKind] of recipe.phaseKinds.entries()) {
    const session = await prepareFocusedLocalGraphSession({
      context: input.context,
      sessionKind,
      focusNodeId,
      atEpisode,
      neighborDepth: input.neighborDepth,
      maxNodes: input.maxNodes,
      maxFindings: input.maxFindings,
    });

    if (!session.ok) {
      return {
        ok: false,
        code: session.code,
        error: "seojeom_prepare_graph_playbook requires graphAuthority=local-snapshot.",
      };
    }

    context = context ?? session.context;
    focusNodeId = session.focusNodeId;
    atEpisode = session.atEpisode;
    for (const warning of session.warnings) {
      warnings.add(warning);
    }

    phases.push({
      order: index + 1,
      title: recipe.title,
      sessionKind,
      objective: session.objective,
      whyThisPhase: recipe.phaseWhy[index] ?? session.summary,
      toolSequence: session.toolSequence,
      completionChecklist: session.completionChecklist,
      operatorBrief: session.operatorBrief,
      copyablePrompt: session.copyablePrompt,
    });
  }

  if (!context) {
    return {
      ok: false,
      code: "GRAPH_AUTHORITY_UNSUPPORTED",
      error: "seojeom_prepare_graph_playbook requires graphAuthority=local-snapshot.",
    };
  }

  return {
    ok: true,
    authority: "local-snapshot",
    playbookKind: input.playbookKind,
    focusNodeId,
    atEpisode,
    summary: buildPlaybookSummary({
      playbookKind: input.playbookKind,
      focusNodeId,
      phaseCount: phases.length,
    }),
    whenToUse: recipe.whenToUse,
    context,
    phases,
    verificationSteps: recipe.verificationSteps,
    approvalCheckpoints: buildApprovalCheckpoints(phases),
    handoffPrompt: buildHandoffPrompt({
      playbookKind: input.playbookKind,
      focusNodeId,
      recipe,
      phases,
    }),
    warnings: Array.from(warnings),
  };
}

export function registerGraphPlaybookTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_get_claude_mcp_onboarding",
    {
      title: "Get Claude MCP Onboarding",
      description:
        "Return the install command, recommended flags, and first tool calls for a Claude operator using the local Seojeom MCP package.",
      inputSchema: {
        projectRootHint: z.string().min(1).optional(),
        focusNodeId: z.string().min(1).optional(),
      },
    },
    async ({ projectRootHint, focusNodeId }) => {
      const result = buildClaudeMcpOnboardingResult({
        projectRootHint,
        focusNodeId,
      });
      return {
        content: [{ type: "text" as const, text: renderClaudeMcpOnboardingText(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "seojeom_list_graph_playbooks",
    {
      title: "List Local Graph Playbooks",
      description:
        "List the available local graph playbook presets and return a starter prompt for Claude/Codex operators.",
      inputSchema: {
        focusNodeId: z.string().min(1).optional(),
      },
    },
    async ({ focusNodeId }) => {
      const resolvedFocusNodeId = focusNodeId?.trim() || "<focus-node-id>";
      const rows = (Object.keys(PLAYBOOK_RECIPES) as GraphPlaybookKind[]).map((playbookKind) =>
        buildPlaybookCatalogRow({
          playbookKind,
          focusNodeId: resolvedFocusNodeId,
        }),
      );
      const result: GraphPlaybookCatalogResult = {
        ok: true,
        summary:
          "Choose a preset, then call seojeom_prepare_graph_playbook with the same playbookKind and your real focus node id.",
        rows,
      };
      return {
        content: [{ type: "text" as const, text: renderGraphPlaybookCatalogText(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "seojeom_prepare_graph_playbook",
    {
      title: "Prepare Local Graph Playbook",
      description:
        "Prepare a named local-first graph operator playbook that wraps one or more focused sessions into a ready-to-run preset.",
      inputSchema: {
        playbookKind: z.enum([
          "document_entity",
          "repair_state",
          "fill_relations",
          "research_document_then_link",
        ]),
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        maxNodes: z.number().int().min(1).max(20).optional(),
        maxFindings: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ playbookKind, focusNodeId, atEpisode, neighborDepth, maxNodes, maxFindings }) => {
      const result = await prepareLocalGraphPlaybook({
        context,
        playbookKind,
        focusNodeId,
        atEpisode,
        neighborDepth,
        maxNodes,
        maxFindings,
      });

      return {
        content: [{ type: "text" as const, text: renderGraphPlaybookText(result) }],
        structuredContent: result,
      };
    },
  );
}
