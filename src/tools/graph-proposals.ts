import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import type {
  LocalGraphProposalItemRecord as GraphProposalItemRecord,
  LocalGraphProposalSetRecord as GraphProposalSetRecord,
} from "../local-graph-proposal-store.js";

type GraphProposalListEnvelope = {
  proposalSets: GraphProposalSetRecord[];
};

type GraphProposalMutationEnvelope = {
  proposalSet: GraphProposalSetRecord;
  assistantReceiptItem?: unknown | null;
};

const PROPOSAL_DECISION_ACTION_VALUES = [
  "approve",
  "reject",
  "needs_revision",
  "supersede",
] as const;

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNullableString(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalStringArray(values: string[] | undefined) {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function buildApprovalDetails(lines: Array<string | null | undefined>) {
  return lines.map((entry) => entry?.trim() ?? "").filter((entry) => entry.length > 0);
}

function proposalSetTitle(proposalSet: GraphProposalSetRecord) {
  return proposalSet.title ?? proposalSet.sourceLabel ?? proposalSet.id;
}

function renderProposalSetListText(proposalSets: GraphProposalSetRecord[]) {
  const lines = [`[proposal sets] ${proposalSets.length}개`];
  for (const proposalSet of proposalSets) {
    lines.push(
      `- ${proposalSet.id} · ${proposalSet.status} · ${proposalSet.items.length} items · ${proposalSetTitle(proposalSet)}`,
    );
  }
  return lines.join("\n");
}

function renderProposalMutationText(input: {
  prefix: string;
  proposalSet: GraphProposalSetRecord;
  approvalSource?: string;
  rememberProject?: boolean;
}) {
  const lines = [
    `[${input.prefix}] ${proposalSetTitle(input.proposalSet)}`,
    `- proposalSet: ${input.proposalSet.id}`,
    `- status: ${input.proposalSet.status}`,
    `- items: ${input.proposalSet.items.length}`,
  ];

  if (input.proposalSet.decisionReason) {
    lines.push(`- reason: ${input.proposalSet.decisionReason}`);
  }

  if (input.approvalSource) {
    lines.push(
      `- approval: ${input.approvalSource}${input.rememberProject ? " (remembered)" : ""}`,
    );
  }

  return lines.join("\n");
}

export function registerGraphProposalTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_list_proposal_sets",
    {
      title: "List Graph Proposal Sets",
      description: "List persisted graph proposal sets for the current project.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ limit }) => {
      const payload = context.localProposalStore
        ? {
            proposalSets: await context.localProposalStore.listProposalSets(
              limit ?? 20,
            ),
          }
        : await context.apiBridge.getJson<GraphProposalListEnvelope>(
            `/api/projects/${context.config.projectId}/graph/proposals?limit=${limit ?? 20}`,
          );

      return {
        content: [
          {
            type: "text" as const,
            text: renderProposalSetListText(payload.proposalSets),
          },
        ],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "seojeom_decide_proposal_set",
    {
      title: "Decide Graph Proposal Set",
      description:
        "Request launcher approval, then mark a graph proposal set as approved, rejected, needs_revision, or superseded.",
      inputSchema: {
        proposalSetId: z.string().min(1),
        action: z.enum(PROPOSAL_DECISION_ACTION_VALUES),
        itemIds: z.array(z.string()).optional(),
        reason: z.string().optional(),
        assistantReceiptContent: z.string().optional(),
      },
    },
    async ({ proposalSetId, action, itemIds, reason, assistantReceiptContent }) => {
      const normalizedProposalSetId = proposalSetId.trim();
      const normalizedItemIds = normalizeOptionalStringArray(itemIds);
      const normalizedReason = normalizeNullableString(reason);
      const approval = await context.approval.requestApproval({
        action: "graph_decide_proposal_set",
        toolName: "seojeom_decide_proposal_set",
        title: normalizedProposalSetId,
        summary: normalizedReason,
        details: buildApprovalDetails([
          `action=${action}`,
          normalizedItemIds.length > 0 ? `itemIds=${normalizedItemIds.join(",")}` : null,
        ]),
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[graph proposal decision approval] ${normalizedProposalSetId}`,
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

      const payload = context.localProposalStore
        ? await context.localProposalStore.decideProposalSet({
            proposalSetId: normalizedProposalSetId,
            action,
            itemIds: normalizedItemIds,
            reason: normalizedReason,
          })
        : await context.apiBridge.postJson<GraphProposalMutationEnvelope>(
            `/api/projects/${context.config.projectId}/graph/proposals/${encodeURIComponent(normalizedProposalSetId)}/decision`,
            {
              action,
              itemIds: normalizedItemIds,
              reason: normalizedReason,
              assistantReceipt:
                normalizeOptionalString(assistantReceiptContent) != null
                  ? {
                      content: normalizeOptionalString(assistantReceiptContent),
                    }
                  : undefined,
            },
          );

      return {
        content: [
          {
            type: "text" as const,
            text: renderProposalMutationText({
              prefix: "graph proposal decision",
              proposalSet: payload.proposalSet,
              approvalSource: approval.source,
              rememberProject: approval.rememberProject,
            }),
          },
        ],
        structuredContent: {
          ...payload,
          approval,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_apply_proposal_set",
    {
      title: "Apply Graph Proposal Set",
      description:
        "Request launcher approval, then apply a persisted graph proposal set to the canonical graph.",
      inputSchema: {
        proposalSetId: z.string().min(1),
        itemIds: z.array(z.string()).optional(),
        triggerEpisodeId: z.string().optional(),
        currentEpisodeNumber: z.number().int().positive().optional(),
        factText: z.string().optional(),
        assistantReceiptContent: z.string().optional(),
      },
    },
    async ({
      proposalSetId,
      itemIds,
      triggerEpisodeId,
      currentEpisodeNumber,
      factText,
      assistantReceiptContent,
    }) => {
      const normalizedProposalSetId = proposalSetId.trim();
      const normalizedItemIds = normalizeOptionalStringArray(itemIds);
      const normalizedTriggerEpisodeId = normalizeOptionalString(triggerEpisodeId);
      const normalizedFactText = normalizeNullableString(factText);

      if ((normalizedTriggerEpisodeId == null) !== (currentEpisodeNumber == null)) {
        throw new Error(
          "triggerEpisodeId and currentEpisodeNumber must be provided together for temporalContext.",
        );
      }

      const approval = await context.approval.requestApproval({
        action: "graph_apply_proposal_set",
        toolName: "seojeom_apply_proposal_set",
        title: normalizedProposalSetId,
        summary:
          normalizedItemIds.length > 0
            ? `${normalizedItemIds.length} items selected`
            : "apply full proposal set",
        details: buildApprovalDetails([
          normalizedTriggerEpisodeId
            ? `triggerEpisodeId=${normalizedTriggerEpisodeId}`
            : null,
          currentEpisodeNumber != null
            ? `currentEpisodeNumber=${currentEpisodeNumber}`
            : null,
        ]),
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[graph proposal apply approval] ${normalizedProposalSetId}`,
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

      const payload =
        context.localProposalStore && context.localGraphStore
          ? await context.localProposalStore.applyProposalSet({
              proposalSetId: normalizedProposalSetId,
              itemIds: normalizedItemIds,
              appliedBy: "seojeom-mcp-local",
              applyItems: (proposalSet, items) =>
                context.localGraphStore!.applyProposalItems({
                  proposalSetId: proposalSet.id,
                  items,
                  temporalContext:
                    normalizedTriggerEpisodeId && currentEpisodeNumber != null
                      ? {
                          triggerEpisodeId: normalizedTriggerEpisodeId,
                          currentEpisodeNumber,
                          factText: normalizedFactText,
                        }
                      : undefined,
                }),
            })
          : await context.apiBridge.postJson<GraphProposalMutationEnvelope>(
              `/api/projects/${context.config.projectId}/graph/proposals/${encodeURIComponent(normalizedProposalSetId)}/apply`,
              {
                itemIds: normalizedItemIds,
                temporalContext:
                  normalizedTriggerEpisodeId && currentEpisodeNumber != null
                    ? {
                        triggerEpisodeId: normalizedTriggerEpisodeId,
                        currentEpisodeNumber,
                        factText: normalizedFactText,
                      }
                    : undefined,
                assistantReceipt:
                  normalizeOptionalString(assistantReceiptContent) != null
                    ? {
                        content: normalizeOptionalString(assistantReceiptContent),
                      }
                    : undefined,
              },
            );

      return {
        content: [
          {
            type: "text" as const,
            text: renderProposalMutationText({
              prefix: "graph proposal apply",
              proposalSet: payload.proposalSet,
              approvalSource: approval.source,
              rememberProject: approval.rememberProject,
            }),
          },
        ],
        structuredContent: {
          ...payload,
          approval,
        },
      };
    },
  );
}
