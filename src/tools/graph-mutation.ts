import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import { UpstreamApiError } from "../http-bridge.js";
import { LocalGraphMutationVersionConflictError } from "../local-graph-store.js";
import type { LocalGraphProposalPreviewEnvelope } from "../local-graph-proposal-store.js";

const EDGE_RELATION_CLASS_VALUES = [
  "organizational",
  "evidence",
  "proposal",
  "derived",
  "participation",
  "temporal",
  "causal",
  "motivational",
  "thematic",
  "epistemic",
] as const;

const LOCAL_GRAPH_MUTATION_KIND_VALUES = [
  "create_node",
  "update_node",
  "patch_node_timeline",
  "delete_node",
  "create_edge",
  "create_packet",
  "update_edge",
  "update_packet",
  "delete_edge",
] as const;

type LocalGraphMutationKind = (typeof LOCAL_GRAPH_MUTATION_KIND_VALUES)[number];
type GraphMutationErrorCode =
  | "VERSION_CONFLICT"
  | "GRAPH_MUTATION_INVALID"
  | "GRAPH_MUTATION_RULE_VIOLATION";

function countArray(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function buildProposalSummaryText(
  title: string,
  envelope: LocalGraphProposalPreviewEnvelope,
  extraLines: string[],
) {
  const proposalSetId = envelope.proposalSet?.id ?? "-";
  const proposalStatus = envelope.proposalSet?.status ?? "unknown";

  return [
    `[graph proposal] ${title}`,
    `- proposalSet: ${proposalSetId} (${proposalStatus})`,
    `- candidateNodes: ${countArray(envelope.preview?.candidateNodes)}`,
    `- candidateEdges: ${countArray(envelope.preview?.candidateEdges)}`,
    `- dropReasons: ${countArray(envelope.preview?.dropReasons)}`,
    ...extraLines,
  ].join("\n");
}

function buildApprovalDetails(lines: Array<string | null | undefined>) {
  return lines.map((entry) => entry?.trim() ?? "").filter((entry) => entry.length > 0);
}

function normalizeStringArray(values: string[] | undefined) {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNullableString(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function isLocalGraphMutationKind(value: string): value is LocalGraphMutationKind {
  return (LOCAL_GRAPH_MUTATION_KIND_VALUES as readonly string[]).includes(value);
}

function describeGraphMutationTitle(mutation: Record<string, unknown>) {
  const kind = normalizeOptionalString(
    typeof mutation.kind === "string" ? mutation.kind : undefined,
  );
  if (!kind) {
    return "graph mutation";
  }

  if (kind === "create_node") {
    const node = asRecord(mutation.node);
    return normalizeOptionalString(typeof node.label === "string" ? node.label : undefined) ?? kind;
  }

  if (kind === "create_edge") {
    const edge = asRecord(mutation.edge);
    const source =
      normalizeOptionalString(typeof edge.sourceNodeId === "string" ? edge.sourceNodeId : undefined) ??
      "-";
    const target =
      normalizeOptionalString(typeof edge.targetNodeId === "string" ? edge.targetNodeId : undefined) ??
      "-";
    const relation =
      normalizeOptionalString(typeof edge.edgeType === "string" ? edge.edgeType : undefined) ??
      "related_to";
    return `${source} -[${relation}]-> ${target}`;
  }

  if (kind === "update_node" || kind === "patch_node_timeline" || kind === "delete_node") {
    return (
      normalizeOptionalString(typeof mutation.nodeId === "string" ? mutation.nodeId : undefined) ??
      kind
    );
  }

  if (kind === "update_edge" || kind === "delete_edge") {
    return (
      normalizeOptionalString(typeof mutation.edgeId === "string" ? mutation.edgeId : undefined) ??
      kind
    );
  }

  if (kind === "create_packet" || kind === "update_packet") {
    const packet = asRecord(mutation.packet);
    const scopeLevel =
      normalizeOptionalString(
        typeof packet.scopeLevel === "string" ? packet.scopeLevel : undefined,
      ) ?? "-";
    return `${normalizeOptionalString(typeof mutation.nodeId === "string" ? mutation.nodeId : undefined) ?? kind} @ ${scopeLevel}`;
  }

  return kind;
}

function describeGraphMutationDetails(mutation: Record<string, unknown>) {
  const kind = normalizeOptionalString(
    typeof mutation.kind === "string" ? mutation.kind : undefined,
  );
  const baseVersion =
    typeof mutation.baseVersion === "number" && Number.isFinite(mutation.baseVersion)
      ? mutation.baseVersion
      : null;

  const details: Array<string | null> = [
    kind ? `kind=${kind}` : "kind=-",
    baseVersion != null ? `baseVersion=${baseVersion}` : null,
  ];

  if (kind === "create_node") {
    const node = asRecord(mutation.node);
    details.push(
      `nodeType=${normalizeOptionalString(typeof node.type === "string" ? node.type : undefined) ?? "-"}`,
    );
  }

  if (kind === "create_edge") {
    const edge = asRecord(mutation.edge);
    details.push(
      `edgeType=${normalizeOptionalString(typeof edge.edgeType === "string" ? edge.edgeType : undefined) ?? "-"}`,
      `relationClass=${normalizeOptionalString(typeof edge.relationClass === "string" ? edge.relationClass : undefined) ?? "-"}`,
    );
  }

  if (kind === "create_packet" || kind === "update_packet") {
    const packet = asRecord(mutation.packet);
    details.push(
      `scopeLevel=${normalizeOptionalString(typeof packet.scopeLevel === "string" ? packet.scopeLevel : undefined) ?? "-"}`,
      `scopeRef=${normalizeOptionalString(typeof packet.scopeRef === "string" ? packet.scopeRef : undefined) ?? "-"}`,
      kind === "update_packet"
        ? `packetRef=${normalizeOptionalString(typeof mutation.packetRef === "string" ? mutation.packetRef : undefined) ?? "-"}`
        : null,
    );
  }

  return buildApprovalDetails(details);
}

function renderGraphMutationText(input: {
  prefix: string;
  title: string;
  kind?: string | null;
  state?: string | null;
  resultId?: string | null;
  nodeRef?: string | null;
  packetRef?: string | null;
  sourceRef?: string | null;
  targetRef?: string | null;
  relationType?: string | null;
  code?: GraphMutationErrorCode | null;
  error?: string | null;
  approvalSource?: string;
  rememberProject?: boolean;
  snapshotPath?: string | null;
  versionToken?: string | null;
  actualVersion?: number | null;
  expectedVersion?: number | null;
}) {
  const lines = [`[${input.prefix}] ${input.title}`];
  if (input.kind) {
    lines.push(`- kind: ${input.kind}`);
  }
  if (input.state) {
    lines.push(`- state: ${input.state}`);
  }
  if (input.resultId) {
    lines.push(`- id: ${input.resultId}`);
  }
  if (input.nodeRef) {
    lines.push(`- nodeRef: ${input.nodeRef}`);
  }
  if (input.packetRef) {
    lines.push(`- packetRef: ${input.packetRef}`);
  }
  if (input.sourceRef || input.targetRef) {
    lines.push(`- edge: ${input.sourceRef ?? "-"} -> ${input.targetRef ?? "-"}`);
  }
  if (input.relationType) {
    lines.push(`- relationType: ${input.relationType}`);
  }
  if (input.code) {
    lines.push(`- code: ${input.code}`);
  }
  if (input.error) {
    lines.push(`- error: ${input.error}`);
  }
  if (input.expectedVersion != null || input.actualVersion != null) {
    lines.push(
      `- version: expected=${input.expectedVersion ?? "-"} actual=${input.actualVersion ?? "-"}`,
    );
  }
  if (input.versionToken) {
    lines.push(`- versionToken: ${input.versionToken}`);
  }
  if (input.snapshotPath) {
    lines.push(`- snapshotPath: ${input.snapshotPath}`);
  }
  if (input.approvalSource) {
    lines.push(
      `- approval: ${input.approvalSource}${input.rememberProject ? " (remembered)" : ""}`,
    );
  }
  return lines.join("\n");
}

function parseGraphMutationUpstreamError(error: unknown): {
  code: GraphMutationErrorCode;
  error: string | null;
  targetRef?: string | null;
  expectedVersion?: number | null;
  actualVersion?: number | null;
} | null {
  if (!(error instanceof UpstreamApiError)) {
    return null;
  }

  const parsedBody = (() => {
    if (!error.bodyText?.trim()) {
      return {};
    }
    try {
      return asRecord(JSON.parse(error.bodyText));
    } catch {
      return {};
    }
  })();

  const code =
    normalizeOptionalString(
      typeof parsedBody.code === "string" ? parsedBody.code : undefined,
    ) ?? (error.status === 409 ? "VERSION_CONFLICT" : "GRAPH_MUTATION_INVALID");
  if (
    code !== "VERSION_CONFLICT" &&
    code !== "GRAPH_MUTATION_INVALID" &&
    code !== "GRAPH_MUTATION_RULE_VIOLATION"
  ) {
    return null;
  }

  const message =
    normalizeOptionalString(
      typeof parsedBody.error === "string" ? parsedBody.error : undefined,
    ) ?? error.message;

  return {
    code,
    error: message,
    targetRef:
      typeof parsedBody.targetRef === "string" ? parsedBody.targetRef : null,
    expectedVersion:
      typeof parsedBody.expectedVersion === "number"
        ? parsedBody.expectedVersion
        : null,
    actualVersion:
      typeof parsedBody.actualVersion === "number"
        ? parsedBody.actualVersion
        : null,
  };
}

export function registerGraphMutationTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_apply_graph_mutation",
    {
      title: "Apply Graph Mutation",
      description:
        "Apply a direct canonical graph mutation for the current project. In local-snapshot mode this mutates the local canonical snapshot without using the web API.",
      inputSchema: {
        mutation: z.record(z.string(), z.unknown()),
      },
    },
    async ({ mutation }) => {
      const normalizedMutation = asRecord(mutation);
      const normalizedKind = normalizeOptionalString(
        typeof normalizedMutation.kind === "string" ? normalizedMutation.kind : undefined,
      );
      const title = describeGraphMutationTitle(normalizedMutation);

      if (!normalizedKind) {
        return {
          content: [
            {
              type: "text" as const,
              text: renderGraphMutationText({
                prefix: "graph mutation",
                title,
                code: "GRAPH_MUTATION_INVALID",
                error: "graph mutation kind is required",
              }),
            },
          ],
          structuredContent: {
            ok: false,
            code: "GRAPH_MUTATION_INVALID",
            error: "graph mutation kind is required",
          },
        };
      }

      if (context.localGraphStore && !isLocalGraphMutationKind(normalizedKind)) {
        return {
          content: [
            {
              type: "text" as const,
              text: renderGraphMutationText({
                prefix: "graph mutation",
                title,
                kind: normalizedKind,
                code: "GRAPH_MUTATION_INVALID",
                error: `local graph mutation kind is not supported: ${normalizedKind}`,
              }),
            },
          ],
          structuredContent: {
            ok: false,
            code: "GRAPH_MUTATION_INVALID",
            error: `local graph mutation kind is not supported: ${normalizedKind}`,
          },
        };
      }

      const approval = await context.approval.requestApproval({
        action: "graph_apply_mutation",
        toolName: "seojeom_apply_graph_mutation",
        title,
        summary: normalizedKind,
        details: describeGraphMutationDetails(normalizedMutation),
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[graph mutation approval] ${title}`,
                `- status: denied`,
                `- reason: ${approval.reason ?? "approval denied"}`,
              ].join("\n"),
            },
          ],
          structuredContent: {
            ok: false,
            approval,
          },
        };
      }

      try {
        if (context.localGraphStore) {
          const envelope = await context.localGraphStore.applyMutation(normalizedMutation);
          return {
            content: [
              {
                type: "text" as const,
                text: renderGraphMutationText({
                  prefix: "graph mutation",
                  title,
                  kind: normalizedKind,
                  state: envelope.result.state,
                  resultId: envelope.result.id,
                  nodeRef: envelope.result.nodeRef,
                  packetRef: envelope.result.packetRef,
                  sourceRef: envelope.result.sourceRef,
                  targetRef: envelope.result.targetRef,
                  relationType: envelope.result.relationType,
                  approvalSource: approval.source,
                  rememberProject: approval.rememberProject,
                  snapshotPath: envelope.snapshotPath,
                  versionToken: envelope.versionToken,
                }),
              },
            ],
            structuredContent: {
              ok: true,
              authority: "local-snapshot",
              approval,
              ...envelope,
            },
          };
        }

        const envelope = await context.apiBridge.postJson<{
          result: {
            id: string;
            nodeRef?: string | null;
            packetRef?: string | null;
            sourceRef?: string | null;
            targetRef?: string | null;
            relationType?: string | null;
            state?: string | null;
            timeline?: unknown;
          };
        }>(`/api/projects/${context.config.projectId}/graph`, normalizedMutation);

        return {
          content: [
            {
              type: "text" as const,
              text: renderGraphMutationText({
                prefix: "graph mutation",
                title,
                kind: normalizedKind,
                state: envelope.result.state,
                resultId: envelope.result.id,
                nodeRef: envelope.result.nodeRef,
                packetRef: envelope.result.packetRef,
                sourceRef: envelope.result.sourceRef,
                targetRef: envelope.result.targetRef,
                relationType: envelope.result.relationType,
                approvalSource: approval.source,
                rememberProject: approval.rememberProject,
              }),
            },
          ],
          structuredContent: {
            ok: true,
            authority: "api-bridge",
            approval,
            ...envelope,
          },
        };
      } catch (error) {
        if (error instanceof LocalGraphMutationVersionConflictError) {
          return {
            content: [
              {
                type: "text" as const,
                text: renderGraphMutationText({
                  prefix: "graph mutation",
                  title,
                  kind: normalizedKind,
                  code: "VERSION_CONFLICT",
                  error: error.message,
                  expectedVersion: error.expectedVersion,
                  actualVersion: error.actualVersion,
                  approvalSource: approval.source,
                  rememberProject: approval.rememberProject,
                }),
              },
            ],
            structuredContent: {
              ok: false,
              code: "VERSION_CONFLICT",
              error: error.message,
              targetRef: error.targetRef,
              expectedVersion: error.expectedVersion,
              actualVersion: error.actualVersion,
              approval,
            },
          };
        }

        if (context.localGraphStore && error instanceof Error) {
          return {
            content: [
              {
                type: "text" as const,
                text: renderGraphMutationText({
                  prefix: "graph mutation",
                  title,
                  kind: normalizedKind,
                  code: "GRAPH_MUTATION_INVALID",
                  error: error.message,
                  approvalSource: approval.source,
                  rememberProject: approval.rememberProject,
                }),
              },
            ],
            structuredContent: {
              ok: false,
              code: "GRAPH_MUTATION_INVALID",
              error: error.message,
              approval,
            },
          };
        }

        const upstreamError = parseGraphMutationUpstreamError(error);
        if (upstreamError) {
          return {
            content: [
              {
                type: "text" as const,
                text: renderGraphMutationText({
                  prefix: "graph mutation",
                  title,
                  kind: normalizedKind,
                  code: upstreamError.code,
                  error: upstreamError.error,
                  expectedVersion: upstreamError.expectedVersion,
                  actualVersion: upstreamError.actualVersion,
                  approvalSource: approval.source,
                  rememberProject: approval.rememberProject,
                }),
              },
            ],
            structuredContent: {
              ok: false,
              code: upstreamError.code,
              error: upstreamError.error,
              targetRef: upstreamError.targetRef ?? null,
              expectedVersion: upstreamError.expectedVersion ?? null,
              actualVersion: upstreamError.actualVersion ?? null,
              approval,
            },
          };
        }

        throw error;
      }
    },
  );

  server.registerTool(
    "seojeom_propose_node",
    {
      title: "Propose Graph Node",
      description:
        "Persist a node_form proposal into the graph proposal queue for the current project.",
      inputSchema: {
        label: z.string().min(1),
        nodeTypeHint: z.string().optional(),
        summary: z.string().optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        linkedEpisodeIds: z.array(z.string()).optional(),
        linkedCharacterIds: z.array(z.string()).optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
        focusNodeIds: z.array(z.string()).optional(),
        atEpisode: z.number().int().positive().optional(),
        includeNeighbors: z.number().int().min(0).max(20).optional(),
        sourceLabel: z.string().optional(),
        forceOpus: z.boolean().optional(),
      },
    },
    async ({
      label,
      nodeTypeHint,
      summary,
      content,
      tags,
      linkedEpisodeIds,
      linkedCharacterIds,
      attributes,
      focusNodeIds,
      atEpisode,
      includeNeighbors,
      sourceLabel,
      forceOpus,
    }) => {
      const normalizedLabel = label.trim();
      const approval = await context.approval.requestApproval({
        action: "graph_propose_node",
        toolName: "seojeom_propose_node",
        title: normalizedLabel,
        summary: normalizeNullableString(summary),
        details: buildApprovalDetails([
          `nodeTypeHint=${normalizeOptionalString(nodeTypeHint) ?? "-"}`,
          `sourceLabel=${normalizeOptionalString(sourceLabel) ?? "-"}`,
        ]),
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[graph proposal approval] ${normalizedLabel}`,
                `- status: denied`,
                `- reason: ${approval.reason ?? "approval denied"}`,
              ].join("\n"),
            },
          ],
          structuredContent: {
            ok: false,
            approval,
          },
        };
      }

      const envelope = context.localProposalStore
        ? await context.localProposalStore.proposeNode({
            label: normalizedLabel,
            nodeTypeHint: normalizeOptionalString(nodeTypeHint),
            summary: normalizeNullableString(summary),
            content: normalizeOptionalString(content),
            tags: normalizeStringArray(tags),
            linkedEpisodeIds: normalizeStringArray(linkedEpisodeIds),
            linkedCharacterIds: normalizeStringArray(linkedCharacterIds),
            attributes,
            sourceLabel: normalizeOptionalString(sourceLabel),
            forceOpus: Boolean(forceOpus),
            focusNodeIds: normalizeStringArray(focusNodeIds),
            atEpisode: atEpisode ?? null,
          })
        : await context.apiBridge.postJson<LocalGraphProposalPreviewEnvelope>(
            `/api/projects/${context.config.projectId}/graph/proposals`,
            {
              persist: true,
              includeNeighbors: includeNeighbors ?? 6,
              sourceKind: "desktop_mcp_node_form",
              source: {
                kind: "node_form",
                title: normalizedLabel,
                nodeTypeHint: normalizeOptionalString(nodeTypeHint),
                summary: normalizeNullableString(summary),
                content: normalizeOptionalString(content),
                tags: normalizeStringArray(tags),
                linkedEpisodeIds: normalizeStringArray(linkedEpisodeIds),
                linkedCharacterIds: normalizeStringArray(linkedCharacterIds),
                attributes,
                sourceLabel: normalizeOptionalString(sourceLabel),
                forceOpus: Boolean(forceOpus),
                focusNodeIds: normalizeStringArray(focusNodeIds),
                atEpisode: atEpisode ?? null,
              },
            },
          );

      return {
        content: [
          {
            type: "text" as const,
            text: buildProposalSummaryText(normalizedLabel, envelope, [
              `- nodeTypeHint: ${normalizeOptionalString(nodeTypeHint) ?? "-"}`,
              `- approval: ${approval.source}${approval.rememberProject ? " (remembered)" : ""}`,
            ]),
          },
        ],
        structuredContent: {
          ...envelope,
          approval,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_propose_edge",
    {
      title: "Propose Graph Edge",
      description:
        "Persist an edge_form proposal into the graph proposal queue for the current project.",
      inputSchema: {
        sourceNodeId: z.string().optional(),
        sourceLabel: z.string().optional(),
        targetNodeId: z.string().optional(),
        targetLabel: z.string().optional(),
        edgeType: z.string().optional(),
        relationClass: z.enum(EDGE_RELATION_CLASS_VALUES).optional(),
        summary: z.string().optional(),
        content: z.string().optional(),
        isDirectional: z.boolean().optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
        focusNodeIds: z.array(z.string()).optional(),
        atEpisode: z.number().int().positive().optional(),
        includeNeighbors: z.number().int().min(0).max(20).optional(),
        forceOpus: z.boolean().optional(),
      },
    },
    async ({
      sourceNodeId,
      sourceLabel,
      targetNodeId,
      targetLabel,
      edgeType,
      relationClass,
      summary,
      content,
      isDirectional,
      attributes,
      focusNodeIds,
      atEpisode,
      includeNeighbors,
      forceOpus,
    }) => {
      const normalizedSourceNodeId = normalizeNullableString(sourceNodeId);
      const normalizedSourceLabel = normalizeNullableString(sourceLabel);
      const normalizedTargetNodeId = normalizeNullableString(targetNodeId);
      const normalizedTargetLabel = normalizeNullableString(targetLabel);
      const normalizedEdgeType = normalizeNullableString(edgeType);
      const approval = await context.approval.requestApproval({
        action: "graph_propose_edge",
        toolName: "seojeom_propose_edge",
        title: `${normalizedSourceNodeId ?? normalizedSourceLabel ?? "-"} -> ${normalizedTargetNodeId ?? normalizedTargetLabel ?? "-"}`,
        summary: normalizeNullableString(summary),
        details: buildApprovalDetails([
          `edgeType=${normalizedEdgeType ?? "-"}`,
          `relationClass=${relationClass ?? "-"}`,
        ]),
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[graph proposal approval] ${normalizedSourceNodeId ?? normalizedSourceLabel ?? "-"} -> ${normalizedTargetNodeId ?? normalizedTargetLabel ?? "-"}`,
                `- status: denied`,
                `- reason: ${approval.reason ?? "approval denied"}`,
              ].join("\n"),
            },
          ],
          structuredContent: {
            ok: false,
            approval,
          },
        };
      }

      const envelope = context.localProposalStore
        ? await context.localProposalStore.proposeEdge({
            sourceNodeId: normalizedSourceNodeId,
            sourceLabel: normalizedSourceLabel,
            targetNodeId: normalizedTargetNodeId,
            targetLabel: normalizedTargetLabel,
            edgeType: normalizedEdgeType,
            relationClass: relationClass ?? null,
            summary: normalizeNullableString(summary),
            content: normalizeOptionalString(content),
            isDirectional,
            attributes,
            forceOpus: Boolean(forceOpus),
            focusNodeIds: normalizeStringArray(focusNodeIds),
            atEpisode: atEpisode ?? null,
          })
        : await context.apiBridge.postJson<LocalGraphProposalPreviewEnvelope>(
            `/api/projects/${context.config.projectId}/graph/proposals`,
            {
              persist: true,
              includeNeighbors: includeNeighbors ?? 6,
              sourceKind: "desktop_mcp_edge_form",
              source: {
                kind: "edge_form",
                sourceNodeId: normalizedSourceNodeId,
                sourceLabel: normalizedSourceLabel,
                targetNodeId: normalizedTargetNodeId,
                targetLabel: normalizedTargetLabel,
                edgeType: normalizedEdgeType,
                relationClass: relationClass ?? null,
                summary: normalizeNullableString(summary),
                content: normalizeOptionalString(content),
                isDirectional,
                attributes,
                forceOpus: Boolean(forceOpus),
                focusNodeIds: normalizeStringArray(focusNodeIds),
                atEpisode: atEpisode ?? null,
              },
            },
          );

      return {
        content: [
          {
            type: "text" as const,
            text: buildProposalSummaryText(
              `${normalizedSourceNodeId ?? normalizedSourceLabel ?? "-"} -> ${normalizedTargetNodeId ?? normalizedTargetLabel ?? "-"}`,
              envelope,
              [
                `- edgeType: ${normalizedEdgeType ?? "-"}`,
                `- relationClass: ${relationClass ?? "-"}`,
                `- approval: ${approval.source}${approval.rememberProject ? " (remembered)" : ""}`,
              ],
            ),
          },
        ],
        structuredContent: {
          ...envelope,
          approval,
        },
      };
    },
  );
}
