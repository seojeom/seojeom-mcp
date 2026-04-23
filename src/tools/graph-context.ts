import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import { preview } from "./shared.js";

type CanonicalGraphNode = {
  id: string;
  label: string;
  type: string;
  plane: string;
  summary: string;
  scopeLevel?: string | null;
  scopeRef?: string | null;
  status?: string | null;
  timeline?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
};

type CanonicalGraphEdge = {
  id: string;
  sourceRef: string;
  targetRef: string;
  relationType: string;
  relationFamily: string;
  summary?: string | null;
};

type CanonicalGraphPacket = {
  ref: string;
  packetKind: string;
  ownerRef: string;
  scopeLevel: string;
  scopeRef: string;
  summaryText?: string | null;
  payload?: Record<string, unknown>;
};

type GraphQueryResponse = {
  nodes: CanonicalGraphNode[];
  edges: CanonicalGraphEdge[];
  packets: CanonicalGraphPacket[];
  meta?: Record<string, unknown>;
  warnings?: string[];
};

export type GraphContextNodeRow = {
  id: string;
  label: string;
  type: string;
  plane: string;
  summary: string | null;
  status: string | null;
  role: string | null;
  scope: string | null;
  timeLabel: string | null;
  currentStateRef: string | null;
  tags: string[];
  linkedEpisodeIds: string[];
  connectedRelations: string[];
};

export type GraphContextEdgeRow = {
  id: string;
  relationType: string;
  relationFamily: string;
  sourceRef: string;
  sourceLabel: string;
  targetRef: string;
  targetLabel: string;
  summary: string | null;
};

export type GraphContextPacketRow = {
  ref: string;
  packetKind: string;
  ownerRef: string;
  ownerLabel: string;
  scopeLevel: string;
  scopeRef: string;
  summaryText: string | null;
  payloadHighlights: string[];
};

export type UnsupportedGraphContextResult = {
  ok: false;
  code: "GRAPH_AUTHORITY_UNSUPPORTED";
  error: string;
};

export type GraphContextResult = {
  ok: true;
  authority: "local-snapshot";
  snapshot: {
    versionToken: string | null;
    snapshotPath: string | null;
  };
  focusNodeId: string | null;
  atEpisode: number | null;
  neighborDepth: 0 | 1 | 2;
  counts: {
    nodeCount: number;
    edgeCount: number;
    packetCount: number;
  };
  focusNode: GraphContextNodeRow | null;
  nodes: GraphContextNodeRow[];
  edges: GraphContextEdgeRow[];
  packets: GraphContextPacketRow[];
  promptContext: string;
  warnings: string[];
};

type GraphContextToolResult = GraphContextResult | UnsupportedGraphContextResult;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function buildConnectedRelations(
  nodeId: string,
  edges: CanonicalGraphEdge[],
  nodeLabels: Map<string, string>,
  maxRelations = 6,
) {
  return edges
    .filter((edge) => edge.sourceRef === nodeId || edge.targetRef === nodeId)
    .slice(0, maxRelations)
    .map((edge) => {
      if (edge.sourceRef === nodeId) {
        return `${edge.relationType} -> ${nodeLabels.get(edge.targetRef) ?? edge.targetRef}`;
      }
      return `${edge.relationType} <- ${nodeLabels.get(edge.sourceRef) ?? edge.sourceRef}`;
    });
}

function summarizePacketPayload(packet: CanonicalGraphPacket, maxItems = 4) {
  const payload = asRecord(packet.payload);
  const preferredKeys = [
    "currentLocationRef",
    "currentAllegianceRef",
    "headquartersRef",
    "emotionalBaseline",
    "cohesionStatus",
    "publicStanding",
    "activeGoalRefs",
    "activeConflictRefs",
    "currentPressureSources",
  ];
  const highlights: string[] = [];
  for (const key of preferredKeys) {
    const rawValue = payload[key];
    if (typeof rawValue === "string" && rawValue.trim()) {
      highlights.push(`${key}=${rawValue.trim()}`);
    } else if (Array.isArray(rawValue) && rawValue.length > 0) {
      const values = rawValue
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 4);
      if (values.length > 0) {
        highlights.push(`${key}=${values.join(", ")}`);
      }
    }
    if (highlights.length >= maxItems) {
      break;
    }
  }
  return highlights;
}

function buildNodeRow(
  node: CanonicalGraphNode,
  edges: CanonicalGraphEdge[],
  nodeLabels: Map<string, string>,
): GraphContextNodeRow {
  const meta = asRecord(node.meta);
  const scope = node.scopeLevel
    ? `${node.scopeLevel}${node.scopeRef ? ` (${node.scopeRef})` : ""}`
    : null;
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    plane: node.plane,
    summary: asString(node.summary),
    status: asString(node.status),
    role: asString(meta.role),
    scope,
    timeLabel: asString(asRecord(node.timeline).timeLabel),
    currentStateRef: asString(meta.currentStateRef),
    tags: asStringArray(meta.tags),
    linkedEpisodeIds: asStringArray(meta.linkedEpisodeIds),
    connectedRelations: buildConnectedRelations(node.id, edges, nodeLabels),
  };
}

function buildPromptContext(input: {
  focusNode: GraphContextNodeRow | null;
  nodes: GraphContextNodeRow[];
  edges: GraphContextEdgeRow[];
  packets: GraphContextPacketRow[];
}) {
  const lines = ["## Local Graph Context"];
  if (input.focusNode) {
    lines.push(`- focus_node: ${input.focusNode.label} (${input.focusNode.id})`);
  }
  lines.push(
    `- nodes: ${input.nodes.length}`,
    `- edges: ${input.edges.length}`,
    `- packets: ${input.packets.length}`,
    "",
    "## Node Facts",
  );

  for (const node of input.nodes) {
    lines.push(
      [
        `- ${node.label} (${node.id})`,
        `  type=${node.type}`,
        node.summary ? `  summary=${preview(node.summary, 180)}` : null,
        node.status ? `  status=${node.status}` : null,
        node.role ? `  role=${node.role}` : null,
        node.scope ? `  scope=${node.scope}` : null,
        node.timeLabel ? `  time=${node.timeLabel}` : null,
        node.currentStateRef ? `  currentStateRef=${node.currentStateRef}` : null,
        node.tags.length > 0 ? `  tags=${node.tags.join(", ")}` : null,
        node.linkedEpisodeIds.length > 0
          ? `  linkedEpisodes=${node.linkedEpisodeIds.join(", ")}`
          : null,
        node.connectedRelations.length > 0
          ? `  relations=${node.connectedRelations.join(" | ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (input.packets.length > 0) {
    lines.push("", "## Active Packets");
    for (const packet of input.packets) {
      lines.push(
        [
          `- ${packet.packetKind} ${packet.ref}`,
          `  owner=${packet.ownerLabel} (${packet.ownerRef})`,
          `  scope=${packet.scopeLevel}:${packet.scopeRef}`,
          packet.summaryText ? `  summary=${preview(packet.summaryText, 180)}` : null,
          packet.payloadHighlights.length > 0
            ? `  payload=${packet.payloadHighlights.join(" | ")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (input.edges.length > 0) {
    lines.push("", "## Edge Facts");
    for (const edge of input.edges) {
      lines.push(
        `- ${edge.sourceLabel} --${edge.relationType}/${edge.relationFamily}--> ${edge.targetLabel}` +
          (edge.summary ? ` | ${preview(edge.summary, 160)}` : ""),
      );
    }
  }

  return lines.join("\n");
}

function renderGraphContextText(result: GraphContextToolResult) {
  if (!result.ok) {
    return result.error;
  }

  const lines = [
    `[graph context] nodes=${result.counts.nodeCount} edges=${result.counts.edgeCount} packets=${result.counts.packetCount}`,
    `snapshot: ${result.snapshot.versionToken ?? "-"} @ ${result.snapshot.snapshotPath ?? "-"}`,
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
  for (const node of result.nodes) {
    lines.push(`- ${node.type} · ${node.label} (${node.id})`);
  }
  return lines.join("\n");
}

export function registerGraphContextTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_build_graph_context",
    {
      title: "Build Local Graph Context",
      description:
        "Build a prompt-ready local graph context bundle from the canonical snapshot around an optional focus node and episode filter.",
      inputSchema: {
        focusNodeId: z.string().min(1).optional(),
        atEpisode: z.number().int().min(0).optional(),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        maxNodes: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ focusNodeId, atEpisode, neighborDepth, maxNodes }) => {
      if (!context.localGraphStore) {
        const unsupportedResult: UnsupportedGraphContextResult = {
          ok: false,
          code: "GRAPH_AUTHORITY_UNSUPPORTED",
          error: "seojeom_build_graph_context requires graphAuthority=local-snapshot.",
        };
        return {
          content: [{ type: "text" as const, text: renderGraphContextText(unsupportedResult) }],
          structuredContent: unsupportedResult,
        };
      }

      const result = await buildLocalGraphContext({
        context,
        focusNodeId: focusNodeId ?? null,
        atEpisode: atEpisode ?? null,
        neighborDepth,
        maxNodes,
      });

      return {
        content: [{ type: "text" as const, text: renderGraphContextText(result) }],
        structuredContent: result,
      };
    },
  );
}

export async function buildLocalGraphContext(input: {
  context: DesktopMcpContext;
  focusNodeId?: string | null;
  atEpisode?: number | null;
  neighborDepth?: 0 | 1 | 2;
  maxNodes?: number;
}): Promise<GraphContextResult> {
  if (!input.context.localGraphStore) {
    throw new Error("local graph context requires graphAuthority=local-snapshot");
  }

  const resolvedFocusNodeId = input.focusNodeId?.trim() || null;
  const resolvedNeighborDepth = input.neighborDepth ?? (resolvedFocusNodeId ? 1 : 0);
  const payload = (await input.context.localGraphStore.query({
    mode: resolvedFocusNodeId ? "node_detail" : "slice",
    filters: {
      focusRef: resolvedFocusNodeId,
      focusRefs: resolvedFocusNodeId ? [resolvedFocusNodeId] : undefined,
      neighborDepth: resolvedNeighborDepth,
      atEpisode: input.atEpisode ?? null,
    },
    include: {
      nodes: true,
      edges: true,
      packets: true,
    },
    pagination: {
      limit: input.maxNodes ?? 8,
    },
  })) as GraphQueryResponse;

  const nodeLabels = new Map(payload.nodes.map((node) => [node.id, node.label] as const));
  const nodeRows = payload.nodes.map((node) => buildNodeRow(node, payload.edges, nodeLabels));
  const edgeRows: GraphContextEdgeRow[] = payload.edges.map((edge) => ({
    id: edge.id,
    relationType: edge.relationType,
    relationFamily: edge.relationFamily,
    sourceRef: edge.sourceRef,
    sourceLabel: nodeLabels.get(edge.sourceRef) ?? edge.sourceRef,
    targetRef: edge.targetRef,
    targetLabel: nodeLabels.get(edge.targetRef) ?? edge.targetRef,
    summary: asString(edge.summary),
  }));
  const packetRows: GraphContextPacketRow[] = payload.packets.map((packet) => ({
    ref: packet.ref,
    packetKind: packet.packetKind,
    ownerRef: packet.ownerRef,
    ownerLabel: nodeLabels.get(packet.ownerRef) ?? packet.ownerRef,
    scopeLevel: packet.scopeLevel,
    scopeRef: packet.scopeRef,
    summaryText: asString(packet.summaryText),
    payloadHighlights: summarizePacketPayload(packet),
  }));
  const focusNode = resolvedFocusNodeId
    ? nodeRows.find((node) => node.id === resolvedFocusNodeId) ?? null
    : null;

  return {
    ok: true,
    authority: "local-snapshot",
    snapshot: {
      versionToken:
        typeof payload.meta?.revisionHint === "string" ? payload.meta.revisionHint : null,
      snapshotPath:
        typeof payload.meta?.snapshotPath === "string" ? payload.meta.snapshotPath : null,
    },
    focusNodeId: resolvedFocusNodeId,
    atEpisode: input.atEpisode ?? null,
    neighborDepth: resolvedNeighborDepth,
    counts: {
      nodeCount: nodeRows.length,
      edgeCount: edgeRows.length,
      packetCount: packetRows.length,
    },
    focusNode,
    nodes: nodeRows,
    edges: edgeRows,
    packets: packetRows,
    promptContext: buildPromptContext({
      focusNode,
      nodes: nodeRows,
      edges: edgeRows,
      packets: packetRows,
    }),
    warnings: payload.warnings ?? [],
  };
}
