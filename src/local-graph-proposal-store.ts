import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type LocalGraphProposalSetStatus =
  | "proposed"
  | "needs_revision"
  | "approved"
  | "rejected"
  | "applied"
  | "superseded"
  | "rolled_back";

export type LocalGraphProposalItemStatus =
  | "proposed"
  | "needs_revision"
  | "approved"
  | "rejected"
  | "applied"
  | "superseded"
  | "rolled_back"
  | "failed";

export type LocalGraphProposalItemRecord = {
  id: string;
  sequence: number;
  opKind: "create_node" | "create_edge";
  targetRef: string | null;
  status: LocalGraphProposalItemStatus;
  payload: Record<string, unknown>;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
};

export type LocalGraphProposalSetRecord = {
  id: string;
  title: string | null;
  sourceLabel: string | null;
  status: LocalGraphProposalSetStatus;
  decisionReason: string | null;
  items: LocalGraphProposalItemRecord[];
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
};

export type LocalGraphProposalPreviewEnvelope = {
  preview: {
    candidateNodes?: Array<Record<string, unknown>>;
    candidateEdges?: Array<Record<string, unknown>>;
    dropReasons?: Array<Record<string, unknown>>;
    warnings?: string[];
  };
  proposalSet: LocalGraphProposalSetRecord | null;
  job: null;
};

type LocalGraphProposalQueueFile = {
  schemaVersion: 1;
  proposalSets: LocalGraphProposalSetRecord[];
};

type ProposeNodeInput = {
  label: string;
  nodeTypeHint?: string;
  summary?: string | null;
  content?: string;
  tags?: string[];
  linkedEpisodeIds?: string[];
  linkedCharacterIds?: string[];
  attributes?: Record<string, unknown>;
  focusNodeIds?: string[];
  atEpisode?: number | null;
  sourceLabel?: string;
  forceOpus?: boolean;
};

type ProposeEdgeInput = {
  sourceNodeId?: string | null;
  sourceLabel?: string | null;
  targetNodeId?: string | null;
  targetLabel?: string | null;
  edgeType?: string | null;
  relationClass?: string | null;
  summary?: string | null;
  content?: string;
  isDirectional?: boolean;
  attributes?: Record<string, unknown>;
  focusNodeIds?: string[];
  atEpisode?: number | null;
  forceOpus?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizePathSeparators(value: string) {
  return value.replace(/\\/g, "/");
}

function toQueueFile(raw: string): LocalGraphProposalQueueFile {
  const parsed = asRecord(JSON.parse(raw));
  const proposalSets = Array.isArray(parsed.proposalSets)
    ? parsed.proposalSets
        .map((entry) => parseProposalSet(entry))
        .filter((entry): entry is LocalGraphProposalSetRecord => entry !== null)
    : [];

  return {
    schemaVersion: 1,
    proposalSets,
  };
}

function parseProposalSet(value: unknown): LocalGraphProposalSetRecord | null {
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) {
    return null;
  }

  const items = Array.isArray(record.items)
    ? record.items
        .map((item) => parseProposalItem(item))
        .filter((item): item is LocalGraphProposalItemRecord => item !== null)
    : [];

  return {
    id,
    title: asString(record.title),
    sourceLabel: asString(record.sourceLabel),
    status:
      asString(record.status) as LocalGraphProposalSetStatus | null ?? "proposed",
    decisionReason: asString(record.decisionReason),
    items,
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
    decidedAt: asString(record.decidedAt),
    appliedAt: asString(record.appliedAt),
    appliedBy: asString(record.appliedBy),
  };
}

function parseProposalItem(value: unknown): LocalGraphProposalItemRecord | null {
  const record = asRecord(value);
  const id = asString(record.id);
  const opKind = asString(record.opKind);
  if (!id || (opKind !== "create_node" && opKind !== "create_edge")) {
    return null;
  }

  return {
    id,
    sequence:
      typeof record.sequence === "number" && Number.isFinite(record.sequence)
        ? record.sequence
        : 1,
    opKind,
    targetRef: asString(record.targetRef),
    status:
      (asString(record.status) as LocalGraphProposalItemStatus | null) ??
      "proposed",
    payload: asRecord(record.payload),
    decisionReason: asString(record.decisionReason),
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
    decidedAt: asString(record.decidedAt),
    appliedAt: asString(record.appliedAt),
    appliedBy: asString(record.appliedBy),
  };
}

function emptyQueueFile(): LocalGraphProposalQueueFile {
  return {
    schemaVersion: 1,
    proposalSets: [],
  };
}

function decisionStatusFromAction(
  action: "approve" | "reject" | "needs_revision" | "supersede",
): LocalGraphProposalSetStatus {
  switch (action) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "needs_revision":
      return "needs_revision";
    case "supersede":
      return "superseded";
  }
}

export class LocalGraphProposalStore {
  private readonly projectRoot: string;
  private readonly projectId: string;
  private readonly relativeQueuePath = ".seojeom/graph/proposal-sets.json";

  constructor(input: { projectRoot: string; projectId: string }) {
    this.projectRoot = input.projectRoot;
    this.projectId = input.projectId;
  }

  getResolvedQueuePath() {
    return path.resolve(this.projectRoot, this.relativeQueuePath);
  }

  async listProposalSets(limit = 20) {
    const queue = await this.readQueue();
    return [...queue.proposalSets]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  async proposeNode(input: ProposeNodeInput): Promise<LocalGraphProposalPreviewEnvelope> {
    const queue = await this.readQueue();
    const now = new Date().toISOString();
    const proposalSet: LocalGraphProposalSetRecord = {
      id: `proposal-set:${randomUUID()}`,
      title: input.label,
      sourceLabel: input.sourceLabel?.trim() || "desktop_mcp_node_form",
      status: "proposed",
      decisionReason: null,
      items: [
        {
          id: `proposal-item:${randomUUID()}`,
          sequence: 1,
          opKind: "create_node",
          targetRef: null,
          status: "proposed",
          payload: {
            kind: "node_form",
            title: input.label,
            nodeTypeHint: input.nodeTypeHint ?? null,
            summary: input.summary ?? null,
            content: input.content?.trim() || null,
            tags: input.tags ?? [],
            linkedEpisodeIds: input.linkedEpisodeIds ?? [],
            linkedCharacterIds: input.linkedCharacterIds ?? [],
            attributes: input.attributes ?? {},
            focusNodeIds: input.focusNodeIds ?? [],
            atEpisode: input.atEpisode ?? null,
            forceOpus: Boolean(input.forceOpus),
          },
          decisionReason: null,
          createdAt: now,
          updatedAt: now,
          decidedAt: null,
          appliedAt: null,
          appliedBy: null,
        },
      ],
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      appliedAt: null,
      appliedBy: null,
    };

    queue.proposalSets.push(proposalSet);
    await this.writeQueue(queue);

    return {
      preview: {
        candidateNodes: [
          {
            label: input.label,
            nodeTypeHint: input.nodeTypeHint ?? null,
            summary: input.summary ?? null,
            tags: input.tags ?? [],
            linkedEpisodeIds: input.linkedEpisodeIds ?? [],
            linkedCharacterIds: input.linkedCharacterIds ?? [],
            focusNodeIds: input.focusNodeIds ?? [],
            atEpisode: input.atEpisode ?? null,
          },
        ],
        candidateEdges: [],
        dropReasons: [],
        warnings: [],
      },
      proposalSet,
      job: null,
    };
  }

  async proposeEdge(input: ProposeEdgeInput): Promise<LocalGraphProposalPreviewEnvelope> {
    const queue = await this.readQueue();
    const now = new Date().toISOString();
    const title = `${input.sourceNodeId ?? input.sourceLabel ?? "-"} -> ${
      input.targetNodeId ?? input.targetLabel ?? "-"
    }`;
    const proposalSet: LocalGraphProposalSetRecord = {
      id: `proposal-set:${randomUUID()}`,
      title,
      sourceLabel: input.sourceLabel?.trim() || "desktop_mcp_edge_form",
      status: "proposed",
      decisionReason: null,
      items: [
        {
          id: `proposal-item:${randomUUID()}`,
          sequence: 1,
          opKind: "create_edge",
          targetRef: null,
          status: "proposed",
          payload: {
            kind: "edge_form",
            sourceNodeId: input.sourceNodeId ?? null,
            sourceLabel: input.sourceLabel ?? null,
            targetNodeId: input.targetNodeId ?? null,
            targetLabel: input.targetLabel ?? null,
            edgeType: input.edgeType ?? null,
            relationClass: input.relationClass ?? null,
            summary: input.summary ?? null,
            content: input.content?.trim() || null,
            isDirectional: input.isDirectional ?? true,
            attributes: input.attributes ?? {},
            focusNodeIds: input.focusNodeIds ?? [],
            atEpisode: input.atEpisode ?? null,
            forceOpus: Boolean(input.forceOpus),
          },
          decisionReason: null,
          createdAt: now,
          updatedAt: now,
          decidedAt: null,
          appliedAt: null,
          appliedBy: null,
        },
      ],
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      appliedAt: null,
      appliedBy: null,
    };

    queue.proposalSets.push(proposalSet);
    await this.writeQueue(queue);

    return {
      preview: {
        candidateNodes: [],
        candidateEdges: [
          {
            sourceNodeId: input.sourceNodeId ?? null,
            sourceLabel: input.sourceLabel ?? null,
            targetNodeId: input.targetNodeId ?? null,
            targetLabel: input.targetLabel ?? null,
            edgeType: input.edgeType ?? null,
            relationClass: input.relationClass ?? null,
            summary: input.summary ?? null,
          },
        ],
        dropReasons: [],
        warnings: [],
      },
      proposalSet,
      job: null,
    };
  }

  async decideProposalSet(input: {
    proposalSetId: string;
    action: "approve" | "reject" | "needs_revision" | "supersede";
    itemIds?: string[];
    reason?: string | null;
  }): Promise<{ proposalSet: LocalGraphProposalSetRecord; assistantReceiptItem: null }> {
    const queue = await this.readQueue();
    const proposalSet = queue.proposalSets.find((entry) => entry.id === input.proposalSetId);
    if (!proposalSet) {
      throw new Error(`proposal set not found: ${input.proposalSetId}`);
    }

    const now = new Date().toISOString();
    const nextStatus = decisionStatusFromAction(input.action);
    const targetedItemIds = new Set(input.itemIds ?? []);

    proposalSet.status = nextStatus;
    proposalSet.decisionReason = input.reason ?? null;
    proposalSet.updatedAt = now;
    proposalSet.decidedAt = now;
    proposalSet.items = proposalSet.items.map((item) => {
      if (targetedItemIds.size > 0 && !targetedItemIds.has(item.id)) {
        return item;
      }

      return {
        ...item,
        status: nextStatus,
        decisionReason: input.reason ?? null,
        updatedAt: now,
        decidedAt: now,
      };
    });

    await this.writeQueue(queue);

    return {
      proposalSet,
      assistantReceiptItem: null,
    };
  }

  async applyProposalSet(input: {
    proposalSetId: string;
    itemIds?: string[];
    appliedBy?: string | null;
    applyItems: (
      proposalSet: LocalGraphProposalSetRecord,
      items: LocalGraphProposalItemRecord[],
    ) => Promise<{
      appliedAt: string;
      targetRefsByItemId: Record<string, string>;
    }>;
  }): Promise<{ proposalSet: LocalGraphProposalSetRecord; assistantReceiptItem: null }> {
    const queue = await this.readQueue();
    const proposalSet = queue.proposalSets.find((entry) => entry.id === input.proposalSetId);
    if (!proposalSet) {
      throw new Error(`proposal set not found: ${input.proposalSetId}`);
    }

    const targetedItemIds = new Set(input.itemIds ?? []);
    const targetItems = proposalSet.items.filter((item) => {
      if (targetedItemIds.size > 0 && !targetedItemIds.has(item.id)) {
        return false;
      }
      return item.status === "approved" || item.status === "proposed";
    });

    if (targetedItemIds.size > 0 && targetItems.length === 0) {
      throw new Error(
        "No applicable proposal items matched the requested local apply item ids.",
      );
    }
    if (targetItems.length === 0) {
      throw new Error("No applicable proposal items remain in this local proposal set.");
    }

    const applied = await input.applyItems(proposalSet, targetItems);
    const appliedBy = input.appliedBy ?? "seojeom-mcp-local";

    proposalSet.items = proposalSet.items.map((item) => {
      const targetRef = applied.targetRefsByItemId[item.id];
      if (!targetRef) {
        return item;
      }

      return {
        ...item,
        status: "applied",
        targetRef,
        updatedAt: applied.appliedAt,
        appliedAt: applied.appliedAt,
        appliedBy,
      };
    });
    proposalSet.updatedAt = applied.appliedAt;
    proposalSet.appliedAt = applied.appliedAt;
    proposalSet.appliedBy = appliedBy;
    proposalSet.status = proposalSet.items.every(
      (item) => item.status === "applied" || item.status === "rolled_back",
    )
      ? "applied"
      : proposalSet.status === "proposed"
        ? "approved"
        : proposalSet.status;

    await this.writeQueue(queue);

    return {
      proposalSet,
      assistantReceiptItem: null,
    };
  }

  private async readQueue(): Promise<LocalGraphProposalQueueFile> {
    const queuePath = this.getResolvedQueuePath();
    const raw = await readFile(queuePath, "utf8").catch(() => null);
    if (!raw) {
      return emptyQueueFile();
    }

    try {
      return toQueueFile(raw);
    } catch {
      return emptyQueueFile();
    }
  }

  private async writeQueue(queue: LocalGraphProposalQueueFile) {
    const queuePath = this.getResolvedQueuePath();
    await mkdir(path.dirname(queuePath), { recursive: true });
    await writeFile(
      queuePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projectId: this.projectId,
          proposalSets: queue.proposalSets,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}
