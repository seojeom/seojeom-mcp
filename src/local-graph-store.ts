import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalGraphProposalItemRecord } from "./local-graph-proposal-store.js";

type LocalCanonicalGraphNode = {
  id: string;
  currentVersion?: number | null;
  type: string;
  plane: string;
  nodeClass: string;
  primaryDimension: string;
  label: string;
  aliases: string[];
  summary: string;
  authorityLevel: string;
  typePath: string[];
  referenceRefIds?: string[];
  evidenceRefIds?: string[];
  description?: string | null;
  scopeLevel?: string | null;
  scopeRef?: string | null;
  status?: string | null;
  sourceRef?: string | null;
  sourceTurnRefs?: string[];
  sourceMessageRefs?: string[];
  sourceAtomRefs?: string[];
  ownerDocumentId?: string | null;
  updatedAt?: string | null;
  timeline?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
};

type LocalCanonicalGraphEdge = {
  id: string;
  currentVersion?: number | null;
  sourceRef: string;
  targetRef: string;
  relationType: string;
  relationFamily: string;
  primaryDimension: string;
  sourceRole: string;
  targetRole: string;
  directional: boolean;
  authorityLevel: string;
  summary?: string | null;
  updatedAt?: string | null;
  timeline?: Record<string, unknown> | null;
  evidenceRefIds?: string[];
  properties?: Record<string, unknown> | null;
  scopeLevel?: string | null;
  scopeRef?: string | null;
};

type LocalCanonicalGraphPacket = {
  id: string;
  currentVersion?: number | null;
  ref: string;
  packetKind: string;
  ownerRef: string;
  scopeLevel: string;
  scopeRef: string;
  authorityLevel: string;
  state: string;
  summaryText?: string | null;
  payload: Record<string, unknown>;
  evidenceRefIds: string[];
  updatedAt?: string | null;
};

type LocalCanonicalGraphSlice = {
  version: {
    versionToken: string;
    snapshotAt: string;
  };
  nodes: LocalCanonicalGraphNode[];
  edges: LocalCanonicalGraphEdge[];
  packets: LocalCanonicalGraphPacket[];
};

type LocalGraphQueryRequest = {
  mode: "slice" | "node_detail";
  filters?: {
    nodeRefs?: string[];
    planes?: string[];
    nodeTypes?: string[];
    focusRef?: string | null;
    focusRefs?: string[];
    neighborDepth?: 0 | 1 | 2;
    textSearch?: string | null;
    atEpisode?: number | null;
  };
  include?: {
    nodes?: boolean;
    edges?: boolean;
    packets?: boolean;
  };
  pagination?: {
    limit?: number;
  };
};

export type LocalGraphQueryResponse = {
  versionToken: string;
  snapshotAt: string;
  nodes: LocalCanonicalGraphNode[];
  edges: LocalCanonicalGraphEdge[];
  packets: LocalCanonicalGraphPacket[];
  aggregateDetails?: null;
  warnings: string[];
  meta: Record<string, unknown>;
};

export type LocalGraphMutationApplyResult = {
  id: string;
  nodeRef?: string | null;
  packetRef?: string | null;
  sourceRef?: string | null;
  targetRef?: string | null;
  relationType?: string | null;
  state?: string | null;
  timeline?: unknown;
};

export type LocalGraphMutationApplyEnvelope = {
  result: LocalGraphMutationApplyResult;
  appliedAt: string;
  snapshotAt: string;
  versionToken: string;
  snapshotPath: string;
};

export class LocalGraphMutationVersionConflictError extends Error {
  readonly targetRef: string | null;
  readonly expectedVersion: number | null;
  readonly actualVersion: number | null;

  constructor(input: {
    targetRef?: string | null;
    expectedVersion?: number | null;
    actualVersion?: number | null;
  }) {
    super("graph mutation version conflict");
    this.name = "LocalGraphMutationVersionConflictError";
    this.targetRef = input.targetRef ?? null;
    this.expectedVersion = input.expectedVersion ?? null;
    this.actualVersion = input.actualVersion ?? null;
  }
}

const EMPTY_SNAPSHOT_AT = new Date(0).toISOString();
const DEFAULT_GRAPH_SLICE_CANDIDATES = [
  ".seojeom/graph/canonical-slice.json",
  ".seojeom/canonical-graph-slice.json",
  ".seojeom/graph/canonical-slice.json",
  ".seojeom/canonical-graph-slice.json",
] as const;
const ITEM_APPLY_ORDER: Record<LocalGraphProposalItemRecord["opKind"], number> = {
  create_node: 10,
  create_edge: 20,
};
const LOCAL_GRAPH_PACKET_KIND_BY_NODE_TYPE: Record<string, string> = {
  character: "character_state_packet",
  organization: "organization_state_packet",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizePathSeparators(value: string) {
  return value.replace(/\\/g, "/");
}

function normalizeIdSegment(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || randomUUID().slice(0, 8);
}

function createUniqueRef(existingRefs: Set<string>, baseRef: string) {
  if (!existingRefs.has(baseRef)) {
    existingRefs.add(baseRef);
    return baseRef;
  }

  let suffix = 2;
  while (existingRefs.has(`${baseRef}-${suffix}`)) {
    suffix += 1;
  }
  const nextRef = `${baseRef}-${suffix}`;
  existingRefs.add(nextRef);
  return nextRef;
}

function sortByUpdatedAt<T extends { updatedAt?: string | null }>(items: T[]) {
  return [...items].sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
  );
}

function nextVersion(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value + 1 : 1;
}

function buildConflictError(input: {
  targetRef: string;
  expectedVersion?: number | null;
  actualVersion?: number | null;
}) {
  throw new LocalGraphMutationVersionConflictError(input);
}

function emptyGraphSlice(): LocalCanonicalGraphSlice {
  return {
    version: {
      versionToken: "local-snapshot:empty",
      snapshotAt: EMPTY_SNAPSHOT_AT,
    },
    nodes: [],
    edges: [],
    packets: [],
  };
}

function parseNode(value: unknown): LocalCanonicalGraphNode | null {
  const record = asRecord(value);
  const id = asString(record.id).trim();
  const label = asString(record.label).trim();
  const type = asString(record.type).trim();
  const plane = asString(record.plane).trim();
  if (!id || !label || !type || !plane) {
    return null;
  }

  return {
    id,
    currentVersion: asNumberOrNull(record.currentVersion),
    type,
    plane,
    nodeClass: asString(record.nodeClass, "aggregate_root"),
    primaryDimension: asString(record.primaryDimension, "canon_entity"),
    label,
    aliases: asStringArray(record.aliases),
    summary: asString(record.summary),
    authorityLevel: asString(record.authorityLevel, "user"),
    typePath: asStringArray(record.typePath),
    referenceRefIds: asStringArray(record.referenceRefIds),
    evidenceRefIds: asStringArray(record.evidenceRefIds),
    description: asNullableString(record.description),
    scopeLevel: asNullableString(record.scopeLevel),
    scopeRef: asNullableString(record.scopeRef),
    status: asNullableString(record.status),
    sourceRef: asNullableString(record.sourceRef),
    sourceTurnRefs: asStringArray(record.sourceTurnRefs),
    sourceMessageRefs: asStringArray(record.sourceMessageRefs),
    sourceAtomRefs: asStringArray(record.sourceAtomRefs),
    ownerDocumentId: asNullableString(record.ownerDocumentId),
    updatedAt: asNullableString(record.updatedAt),
    timeline: record.timeline ? asRecord(record.timeline) : null,
    meta: asRecord(record.meta),
  };
}

function parseEdge(value: unknown): LocalCanonicalGraphEdge | null {
  const record = asRecord(value);
  const id = asString(record.id).trim();
  const sourceRef = asString(record.sourceRef).trim();
  const targetRef = asString(record.targetRef).trim();
  const relationType = asString(record.relationType).trim();
  if (!id || !sourceRef || !targetRef || !relationType) {
    return null;
  }

  return {
    id,
    currentVersion: asNumberOrNull(record.currentVersion),
    sourceRef,
    targetRef,
    relationType,
    relationFamily: asString(record.relationFamily, "derived"),
    primaryDimension: asString(record.primaryDimension, "canon_entity"),
    sourceRole: asString(record.sourceRole, "source"),
    targetRole: asString(record.targetRole, "target"),
    directional: asBoolean(record.directional, true),
    authorityLevel: asString(record.authorityLevel, "user"),
    summary: asNullableString(record.summary),
    updatedAt: asNullableString(record.updatedAt),
    timeline: record.timeline ? asRecord(record.timeline) : null,
    evidenceRefIds: asStringArray(record.evidenceRefIds),
    properties: asObjectRecord(record.properties),
    scopeLevel: asNullableString(record.scopeLevel),
    scopeRef: asNullableString(record.scopeRef),
  };
}

function parsePacket(value: unknown): LocalCanonicalGraphPacket | null {
  const record = asRecord(value);
  const id = asString(record.id).trim();
  const ref = asString(record.ref).trim();
  const ownerRef = asString(record.ownerRef).trim();
  const scopeRef = asString(record.scopeRef).trim();
  if (!id || !ref || !ownerRef || !scopeRef) {
    return null;
  }

  return {
    id,
    currentVersion: asNumberOrNull(record.currentVersion),
    ref,
    packetKind: asString(record.packetKind, "state"),
    ownerRef,
    scopeLevel: asString(record.scopeLevel, "episode"),
    scopeRef,
    authorityLevel: asString(record.authorityLevel, "user"),
    state: asString(record.state, "active"),
    summaryText: asNullableString(record.summaryText),
    payload: asRecord(record.payload),
    evidenceRefIds: asStringArray(record.evidenceRefIds),
    updatedAt: asNullableString(record.updatedAt),
  };
}

function parseGraphSlice(raw: string): LocalCanonicalGraphSlice {
  const parsed = asRecord(JSON.parse(raw));
  const version = asRecord(parsed.version);

  return {
    version: {
      versionToken: asString(version.versionToken, "local-snapshot"),
      snapshotAt: asString(version.snapshotAt, new Date().toISOString()),
    },
    nodes: Array.isArray(parsed.nodes)
      ? parsed.nodes
          .map((entry) => parseNode(entry))
          .filter((entry): entry is LocalCanonicalGraphNode => entry !== null)
      : [],
    edges: Array.isArray(parsed.edges)
      ? parsed.edges
          .map((entry) => parseEdge(entry))
          .filter((entry): entry is LocalCanonicalGraphEdge => entry !== null)
      : [],
    packets: Array.isArray(parsed.packets)
      ? parsed.packets
          .map((entry) => parsePacket(entry))
          .filter((entry): entry is LocalCanonicalGraphPacket => entry !== null)
      : [],
  };
}

function applyTextSearch(
  nodes: LocalCanonicalGraphNode[],
  textSearch: string | null | undefined,
): LocalCanonicalGraphNode[] {
  const normalized = textSearch?.trim().toLowerCase();
  if (!normalized) {
    return nodes;
  }

  return nodes.filter((node) => {
    const haystack = [
      node.id,
      node.label,
      node.type,
      node.summary,
      node.description ?? "",
      node.sourceRef ?? "",
      ...node.aliases,
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function applyEpisodeFilter(
  slice: LocalCanonicalGraphSlice,
  atEpisode: number | null | undefined,
): LocalCanonicalGraphSlice {
  if (atEpisode == null) {
    return slice;
  }

  return {
    version: slice.version,
    nodes: slice.nodes.filter((node) => {
      const anchor = asNumberOrNull(node.timeline?.anchorEpisodeNumber);
      return anchor == null || anchor <= atEpisode;
    }),
    edges: slice.edges.filter((edge) => {
      const validFrom = asNumberOrNull(edge.timeline?.validFromEpisode);
      const validUntil = asNumberOrNull(edge.timeline?.validUntilEpisode);
      if (validFrom != null && validFrom > atEpisode) {
        return false;
      }
      if (validUntil != null && validUntil < atEpisode) {
        return false;
      }
      return true;
    }),
    packets: slice.packets,
  };
}

function collectNeighborhood(
  nodes: LocalCanonicalGraphNode[],
  edges: LocalCanonicalGraphEdge[],
  focusRefs: string[],
  neighborDepth: 0 | 1 | 2,
) {
  const allowed = new Set<string>(focusRefs);
  let frontier = new Set<string>(focusRefs);

  for (let depth = 0; depth < neighborDepth; depth += 1) {
    if (frontier.size === 0) {
      break;
    }

    const nextFrontier = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.sourceRef) && !allowed.has(edge.targetRef)) {
        nextFrontier.add(edge.targetRef);
      }
      if (frontier.has(edge.targetRef) && !allowed.has(edge.sourceRef)) {
        nextFrontier.add(edge.sourceRef);
      }
    }

    for (const ref of nextFrontier) {
      allowed.add(ref);
    }
    frontier = nextFrontier;
  }

  const nodeRefs = new Set(nodes.map((node) => node.id).filter((id) => allowed.has(id)));
  return {
    nodes: nodes.filter((node) => nodeRefs.has(node.id)),
    edges: edges.filter(
      (edge) => nodeRefs.has(edge.sourceRef) && nodeRefs.has(edge.targetRef),
    ),
    allowedRefs: nodeRefs,
  };
}

export class LocalGraphSnapshotStore {
  private readonly projectId: string;
  private readonly projectRoot: string;
  private readonly explicitSlicePath: string | null;

  constructor(input: {
    projectId: string;
    projectRoot: string;
    graphSlicePath?: string | null;
  }) {
    this.projectId = input.projectId;
    this.projectRoot = input.projectRoot;
    this.explicitSlicePath = input.graphSlicePath?.trim() ?? null;
  }

  async getResolvedSnapshotPath(): Promise<string | null> {
    if (this.explicitSlicePath) {
      const explicitPath = path.isAbsolute(this.explicitSlicePath)
        ? this.explicitSlicePath
        : path.resolve(this.projectRoot, this.explicitSlicePath);
      const stats = await stat(explicitPath).catch(() => null);
      if (!stats?.isFile()) {
        throw new Error(`local graph snapshot not found: ${explicitPath}`);
      }
      return explicitPath;
    }

    for (const candidate of DEFAULT_GRAPH_SLICE_CANDIDATES) {
      const absolutePath = path.resolve(this.projectRoot, candidate);
      const stats = await stat(absolutePath).catch(() => null);
      if (stats?.isFile()) {
        return absolutePath;
      }
    }

    return null;
  }

  private async getWritableSnapshotPath(): Promise<string> {
    const existingPath = await this.getResolvedSnapshotPath();
    if (existingPath) {
      return existingPath;
    }

    if (this.explicitSlicePath) {
      return path.isAbsolute(this.explicitSlicePath)
        ? this.explicitSlicePath
        : path.resolve(this.projectRoot, this.explicitSlicePath);
    }

    return path.resolve(this.projectRoot, DEFAULT_GRAPH_SLICE_CANDIDATES[0]);
  }

  async loadSlice(): Promise<LocalCanonicalGraphSlice> {
    const snapshotPath = await this.getResolvedSnapshotPath();
    if (!snapshotPath) {
      return emptyGraphSlice();
    }

    const raw = await readFile(snapshotPath, "utf8");
    return parseGraphSlice(raw);
  }

  private async writeSlice(slicePath: string, slice: LocalCanonicalGraphSlice) {
    await mkdir(path.dirname(slicePath), { recursive: true });
    await writeFile(slicePath, `${JSON.stringify(slice, null, 2)}\n`, "utf8");
  }

  private resolveNodeRefFromPayload(
    slice: LocalCanonicalGraphSlice,
    input: {
      nodeId?: string | null;
      nodeLabel?: string | null;
      role: "source" | "target";
    },
  ) {
    if (input.nodeId?.trim()) {
      const matchedNode = slice.nodes.find((node) => node.id === input.nodeId);
      if (!matchedNode) {
        throw new Error(
          `${input.role} node not found in local graph snapshot: ${input.nodeId}`,
        );
      }
      return matchedNode.id;
    }

    const normalizedLabel = input.nodeLabel?.trim();
    if (!normalizedLabel) {
      throw new Error(`${input.role} node reference is missing`);
    }

    const exactMatches = slice.nodes.filter((node) => node.label.trim() === normalizedLabel);
    if (exactMatches.length === 1) {
      return exactMatches[0].id;
    }
    if (exactMatches.length > 1) {
      throw new Error(
        `${input.role} node label is ambiguous in local graph snapshot: ${normalizedLabel}`,
      );
    }

    const foldedMatches = slice.nodes.filter(
      (node) => node.label.trim().toLowerCase() === normalizedLabel.toLowerCase(),
    );
    if (foldedMatches.length === 1) {
      return foldedMatches[0].id;
    }
    if (foldedMatches.length > 1) {
      throw new Error(
        `${input.role} node label is ambiguous in local graph snapshot: ${normalizedLabel}`,
      );
    }

    throw new Error(
      `${input.role} node label not found in local graph snapshot: ${normalizedLabel}`,
    );
  }

  private resolveNodeIndex(slice: LocalCanonicalGraphSlice, nodeRef: string) {
    const index = slice.nodes.findIndex((node) => node.id === nodeRef);
    if (index === -1) {
      throw new Error(`local graph node not found: ${nodeRef}`);
    }
    return index;
  }

  private resolveEdgeIndex(slice: LocalCanonicalGraphSlice, edgeRef: string) {
    const index = slice.edges.findIndex((edge) => edge.id === edgeRef);
    if (index === -1) {
      throw new Error(`local graph edge not found: ${edgeRef}`);
    }
    return index;
  }

  private ensureNodeBaseVersion(
    node: LocalCanonicalGraphNode,
    expectedVersion: number | null | undefined,
  ) {
    if (
      typeof expectedVersion === "number" &&
      typeof node.currentVersion === "number" &&
      expectedVersion !== node.currentVersion
    ) {
      buildConflictError({
        targetRef: node.id,
        expectedVersion,
        actualVersion: node.currentVersion,
      });
    }
  }

  private ensureEdgeBaseVersion(
    edge: LocalCanonicalGraphEdge,
    expectedVersion: number | null | undefined,
  ) {
    if (
      typeof expectedVersion === "number" &&
      typeof edge.currentVersion === "number" &&
      expectedVersion !== edge.currentVersion
    ) {
      buildConflictError({
        targetRef: edge.id,
        expectedVersion,
        actualVersion: edge.currentVersion,
      });
    }
  }

  private resolvePacketIndex(slice: LocalCanonicalGraphSlice, packetRef: string) {
    const index = slice.packets.findIndex((packet) => packet.ref === packetRef);
    if (index === -1) {
      throw new Error(`local graph packet not found: ${packetRef}`);
    }
    return index;
  }

  private ensurePacketBaseVersion(
    packet: LocalCanonicalGraphPacket,
    expectedVersion: number | null | undefined,
  ) {
    if (
      typeof expectedVersion === "number" &&
      typeof packet.currentVersion === "number" &&
      expectedVersion !== packet.currentVersion
    ) {
      buildConflictError({
        targetRef: packet.ref,
        expectedVersion,
        actualVersion: packet.currentVersion,
      });
    }
  }

  private resolvePacketKindForNodeType(nodeType: string) {
    return LOCAL_GRAPH_PACKET_KIND_BY_NODE_TYPE[nodeType] ?? null;
  }

  private resolvePacketScopeRef(packet: Record<string, unknown>) {
    const explicitScopeRef = asNullableString(packet.scopeRef);
    if (explicitScopeRef) {
      return explicitScopeRef;
    }

    const explicitScopeEpisodeId = asNullableString(packet.scopeEpisodeId);
    if (explicitScopeEpisodeId) {
      return `episode:${explicitScopeEpisodeId}`;
    }

    const scopeLevel = asString(packet.scopeLevel).trim();
    if (!scopeLevel) {
      throw new Error("local graph packet mutation is missing packet.scopeLevel");
    }

    return `scope:${scopeLevel}`;
  }

  private buildPacketRef(input: {
    nodeRef: string;
    packetKind: string;
    packet: Record<string, unknown>;
  }) {
    const scopeLevel = asString(input.packet.scopeLevel).trim();
    if (!scopeLevel) {
      throw new Error("local graph packet mutation is missing packet.scopeLevel");
    }

    const scopeRef = this.resolvePacketScopeRef(input.packet);
    const aggregateId = input.nodeRef.includes(":")
      ? input.nodeRef.slice(input.nodeRef.indexOf(":") + 1)
      : input.nodeRef;
    return `${input.packetKind}:${aggregateId}:${scopeLevel}:${scopeRef}`;
  }

  private buildPacketSummary(packet: Record<string, unknown>) {
    const summaryParts = [
      asNullableString(packet.summaryText),
      asNullableString(packet.emotionalBaseline)
        ? `감정: ${asNullableString(packet.emotionalBaseline)}`
        : null,
      asNullableString(packet.currentLocationRef)
        ? `장소: ${asNullableString(packet.currentLocationRef)}`
        : null,
      asNullableString(packet.headquartersRef)
        ? `거점: ${asNullableString(packet.headquartersRef)}`
        : null,
    ].filter((value): value is string => Boolean(value));

    return summaryParts.join(" | ") || "state packet";
  }

  private buildPacketPayload(nodeType: string, packet: Record<string, unknown>) {
    if (nodeType === "organization") {
      return {
        headquartersRef: asNullableString(packet.headquartersRef),
        activeTerritoryRefs: asStringArray(packet.activeTerritoryRefs),
        activeGoalRefs: asStringArray(packet.activeGoalRefs),
        activeConflictRefs: asStringArray(packet.activeConflictRefs),
        currentPressureSources: asStringArray(packet.currentPressureSources),
        cohesionStatus: asNullableString(packet.cohesionStatus),
        publicStanding: asNullableString(packet.publicStanding),
        anchorEpisodeNumber: null,
      };
    }

    return {
      currentLocationRef: asNullableString(packet.currentLocationRef),
      currentAllegianceRef: asNullableString(packet.currentAllegianceRef),
      activeGoalRefs: asStringArray(packet.activeGoalRefs),
      activeConflictRefs: asStringArray(packet.activeConflictRefs),
      emotionalBaseline: asNullableString(packet.emotionalBaseline),
      activeSecretRefs: asStringArray(packet.activeSecretRefs),
      recentRelationshipShifts: asStringArray(packet.recentRelationshipShifts),
      currentPressureSources: asStringArray(packet.currentPressureSources),
      voiceDriftNotes: asStringArray(packet.voiceDriftNotes),
      audienceKnowledgeSplit: asStringArray(packet.audienceKnowledgeSplit),
      lastUpdatedFromEvidenceRef: asNullableString(packet.lastUpdatedFromEvidenceRef),
      anchorEpisodeNumber: null,
    };
  }

  private applyCreateNodeItem(
    slice: LocalCanonicalGraphSlice,
    item: LocalGraphProposalItemRecord,
    appliedAt: string,
  ) {
    const payload = asRecord(item.payload);
    const label = asString(payload.title).trim();
    if (!label) {
      throw new Error(`local create_node payload is missing title for ${item.id}`);
    }

    const nodeType = asString(payload.nodeTypeHint, "note").trim() || "note";
    const episodeAnchor = asNumberOrNull(payload.atEpisode);
    const plane = nodeType === "event" ? "event" : "entity";
    const primaryDimension =
      plane === "event" || episodeAnchor != null ? "timeline" : "canon_entity";
    const existingRefs = new Set(slice.nodes.map((node) => node.id));
    const nodeRef = createUniqueRef(
      existingRefs,
      `${normalizeIdSegment(nodeType)}:${normalizeIdSegment(label)}`,
    );

    slice.nodes.push({
      id: nodeRef,
      type: nodeType,
      plane,
      nodeClass: "aggregate_root",
      primaryDimension,
      label,
      aliases: [],
      summary: asString(payload.summary),
      authorityLevel: "approved_ai",
      typePath: [nodeType],
      description: asNullableString(payload.content),
      sourceRef: item.id,
      ownerDocumentId: null,
      updatedAt: appliedAt,
      timeline:
        episodeAnchor != null
          ? {
              anchorEpisodeNumber: episodeAnchor,
            }
          : null,
      meta: {
        localProposalItemId: item.id,
        tags: asStringArray(payload.tags),
        linkedEpisodeIds: asStringArray(payload.linkedEpisodeIds),
        linkedCharacterIds: asStringArray(payload.linkedCharacterIds),
        focusNodeIds: asStringArray(payload.focusNodeIds),
        attributes: asRecord(payload.attributes),
      },
    });

    return nodeRef;
  }

  private applyCreateEdgeItem(
    slice: LocalCanonicalGraphSlice,
    item: LocalGraphProposalItemRecord,
    appliedAt: string,
    temporalContext?: {
      triggerEpisodeId?: string | null;
      currentEpisodeNumber?: number | null;
      factText?: string | null;
    },
  ) {
    const payload = asRecord(item.payload);
    const sourceRef = this.resolveNodeRefFromPayload(slice, {
      nodeId: asNullableString(payload.sourceNodeId),
      nodeLabel: asNullableString(payload.sourceLabel),
      role: "source",
    });
    const targetRef = this.resolveNodeRefFromPayload(slice, {
      nodeId: asNullableString(payload.targetNodeId),
      nodeLabel: asNullableString(payload.targetLabel),
      role: "target",
    });
    const relationType = asString(payload.edgeType, "related_to").trim() || "related_to";
    const relationFamily =
      asString(payload.relationClass, "derived").trim() || "derived";
    const episodeNumber =
      asNumberOrNull(payload.atEpisode) ?? temporalContext?.currentEpisodeNumber ?? null;
    const existingRefs = new Set(slice.edges.map((edge) => edge.id));
    const edgeRef = createUniqueRef(
      existingRefs,
      `edge:${normalizeIdSegment(sourceRef)}:${normalizeIdSegment(relationType)}:${normalizeIdSegment(targetRef)}`,
    );

    slice.edges.push({
      id: edgeRef,
      sourceRef,
      targetRef,
      relationType,
      relationFamily,
      primaryDimension: episodeNumber != null ? "timeline" : "canon_entity",
      sourceRole: relationFamily === "participation" ? "participant" : "source",
      targetRole:
        relationFamily === "participation" && relationType === "participates_in"
          ? "event"
          : "target",
      directional: asBoolean(payload.isDirectional, true),
      authorityLevel: "approved_ai",
      summary: asNullableString(payload.summary) ?? asNullableString(payload.content),
      updatedAt: appliedAt,
      timeline:
        episodeNumber != null ||
        temporalContext?.triggerEpisodeId != null ||
        temporalContext?.factText != null
          ? {
              validFromEpisode: episodeNumber,
              validUntilEpisode: null,
              triggerEpisodeId: temporalContext?.triggerEpisodeId ?? null,
              timeLabel: temporalContext?.factText ?? null,
            }
          : null,
    });

    return edgeRef;
  }

  private applyCreateNodeMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
    appliedAt: string,
  ): LocalGraphMutationApplyResult {
    const node = asRecord(mutation.node);
    const label = asString(node.label).trim();
    if (!label) {
      throw new Error("local create_node mutation is missing node.label");
    }

    const nodeType = asString(node.type, "note").trim() || "note";
    const timeline = asObjectRecord(node.timeline);
    const plane =
      asString(node.layer).trim() ||
      (nodeType === "event" ? "event" : "entity");
    const primaryDimension =
      plane === "event" || timeline ? "timeline" : "canon_entity";
    const existingRefs = new Set(slice.nodes.map((candidate) => candidate.id));
    const nodeRef = createUniqueRef(
      existingRefs,
      `${normalizeIdSegment(nodeType)}:${normalizeIdSegment(label)}`,
    );

    slice.nodes.push({
      id: nodeRef,
      currentVersion: 1,
      type: nodeType,
      plane,
      nodeClass: "aggregate_root",
      primaryDimension,
      label,
      aliases: asStringArray(node.tags),
      summary: asString(node.summary),
      authorityLevel: "user",
      typePath: [nodeType],
      referenceRefIds: [],
      evidenceRefIds: asStringArray(mutation.evidenceRefs),
      description: asNullableString(node.description),
      scopeLevel: asNullableString(timeline?.scopeLevel),
      scopeRef: null,
      status: null,
      sourceRef: null,
      sourceTurnRefs: asStringArray(mutation.sourceTurnRefs),
      sourceMessageRefs: asStringArray(mutation.sourceMessageRefs),
      sourceAtomRefs: asStringArray(mutation.sourceAtomRefs),
      ownerDocumentId: null,
      updatedAt: appliedAt,
      timeline,
      meta: {
        linkedEpisodeIds: asStringArray(node.linkedEpisodeIds),
        linkedCharacterIds: asStringArray(node.linkedCharacterIds),
        attributes: asRecord(node.attributes),
        ...(node.facets ? { facets: node.facets } : {}),
        ...(asNullableString(node.currentStateRef)
          ? { currentStateRef: asNullableString(node.currentStateRef) }
          : {}),
      },
    });

    return {
      id: nodeRef,
      nodeRef,
      packetRef: null,
      sourceRef: null,
      targetRef: null,
      relationType: null,
      state: "created",
      timeline: null,
    };
  }

  private applyUpdateNodeMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
    appliedAt: string,
  ): LocalGraphMutationApplyResult {
    const nodeRef = asString(mutation.nodeId).trim();
    if (!nodeRef) {
      throw new Error("local update_node mutation is missing nodeId");
    }
    const patch = asRecord(mutation.patch);
    const index = this.resolveNodeIndex(slice, nodeRef);
    const node = slice.nodes[index]!;
    this.ensureNodeBaseVersion(node, asNumberOrNull(mutation.baseVersion));

    if (asString(patch.label).trim()) {
      node.label = asString(patch.label).trim();
    }
    if ("summary" in patch) {
      node.summary = asString(patch.summary);
    }
    if ("description" in patch) {
      node.description = asNullableString(patch.description);
    }
    if ("tags" in patch) {
      node.aliases = asStringArray(patch.tags);
    }

    node.meta = node.meta ?? {};
    for (const key of [
      "linkedEpisodeIds",
      "linkedCharacterIds",
      "attributes",
      "facets",
      "category",
      "role",
      "statusTag",
      "slug",
      "lane",
      "currentStateRef",
    ]) {
      if (key in patch) {
        node.meta[key] = patch[key];
      }
    }

    node.currentVersion = nextVersion(node.currentVersion);
    node.updatedAt = appliedAt;

    return {
      id: node.id,
      nodeRef: node.id,
      packetRef: null,
      sourceRef: null,
      targetRef: null,
      relationType: null,
      state: "updated",
      timeline: null,
    };
  }

  private applyPatchNodeTimelineMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
    appliedAt: string,
  ): LocalGraphMutationApplyResult {
    const nodeRef = asString(mutation.nodeId).trim();
    if (!nodeRef) {
      throw new Error("local patch_node_timeline mutation is missing nodeId");
    }

    const index = this.resolveNodeIndex(slice, nodeRef);
    const node = slice.nodes[index]!;
    this.ensureNodeBaseVersion(node, asNumberOrNull(mutation.baseVersion));
    const nextTimeline = mutation.timeline ? asObjectRecord(mutation.timeline) : null;
    node.scopeLevel = asNullableString(nextTimeline?.scopeLevel);
    node.timeline = nextTimeline;
    node.currentVersion = nextVersion(node.currentVersion);
    node.updatedAt = appliedAt;

    return {
      id: node.id,
      nodeRef: node.id,
      packetRef: null,
      sourceRef: null,
      targetRef: null,
      relationType: null,
      state: "timeline_patched",
      timeline: nextTimeline,
    };
  }

  private applyDeleteNodeMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
  ): LocalGraphMutationApplyResult {
    const nodeRef = asString(mutation.nodeId).trim();
    if (!nodeRef) {
      throw new Error("local delete_node mutation is missing nodeId");
    }
    const index = this.resolveNodeIndex(slice, nodeRef);
    const existing = slice.nodes[index]!;
    this.ensureNodeBaseVersion(existing, asNumberOrNull(mutation.baseVersion));
    const [removed] = slice.nodes.splice(index, 1);
    slice.edges = slice.edges.filter(
      (edge) => edge.sourceRef !== removed.id && edge.targetRef !== removed.id,
    );

    return {
      id: removed.id,
      nodeRef: removed.id,
      packetRef: null,
      sourceRef: null,
      targetRef: null,
      relationType: null,
      state: "deleted",
      timeline: null,
    };
  }

  private applyCreateEdgeMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
    appliedAt: string,
  ): LocalGraphMutationApplyResult {
    const edge = asRecord(mutation.edge);
    const sourceRef = this.resolveNodeRefFromPayload(slice, {
      nodeId: asNullableString(edge.sourceNodeId),
      nodeLabel: null,
      role: "source",
    });
    const targetRef = this.resolveNodeRefFromPayload(slice, {
      nodeId: asNullableString(edge.targetNodeId),
      nodeLabel: null,
      role: "target",
    });
    const relationType = asString(edge.edgeType, "related_to").trim() || "related_to";
    const relationFamily = asString(edge.relationClass, "derived").trim() || "derived";
    const edgeId =
      asString(edge.id).trim() ||
      `edge:${normalizeIdSegment(sourceRef)}:${normalizeIdSegment(relationType)}:${normalizeIdSegment(targetRef)}`;

    slice.edges.push({
      id: edgeId,
      currentVersion: 1,
      sourceRef,
      targetRef,
      relationType,
      relationFamily,
      primaryDimension: edge.timeline ? "timeline" : "canon_entity",
      sourceRole: relationFamily === "participation" ? "participant" : "source",
      targetRole:
        relationFamily === "participation" && relationType === "participates_in"
          ? "event"
          : "target",
      directional: asBoolean(edge.isDirectional, true),
      authorityLevel: "user",
      summary: asNullableString(edge.summary),
      updatedAt: appliedAt,
      timeline: asObjectRecord(edge.timeline),
      evidenceRefIds: asStringArray(edge.evidenceRefs),
      properties: asObjectRecord(edge.properties),
      scopeLevel: null,
      scopeRef: null,
    });

    return {
      id: edgeId,
      nodeRef: null,
      packetRef: null,
      sourceRef,
      targetRef,
      relationType,
      state: "created",
      timeline: null,
    };
  }

  private applyUpdateEdgeMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
    appliedAt: string,
  ): LocalGraphMutationApplyResult {
    const edgeRef = asString(mutation.edgeId).trim();
    if (!edgeRef) {
      throw new Error("local update_edge mutation is missing edgeId");
    }
    const patch = asRecord(mutation.patch);
    const nextSourceRef =
      typeof patch.sourceNodeId === "string"
        ? this.resolveNodeRefFromPayload(slice, {
            nodeId: patch.sourceNodeId,
            nodeLabel: null,
            role: "source",
          })
        : null;
    const nextTargetRef =
      typeof patch.targetNodeId === "string"
        ? this.resolveNodeRefFromPayload(slice, {
            nodeId: patch.targetNodeId,
            nodeLabel: null,
            role: "target",
          })
        : null;
    const index = this.resolveEdgeIndex(slice, edgeRef);
    const edge = slice.edges[index]!;
    this.ensureEdgeBaseVersion(edge, asNumberOrNull(mutation.baseVersion));

    if (asString(patch.edgeType).trim()) {
      edge.relationType = asString(patch.edgeType).trim();
    }
    if (asString(patch.relationClass).trim()) {
      edge.relationFamily = asString(patch.relationClass).trim();
    }
    if (typeof patch.isDirectional === "boolean") {
      edge.directional = patch.isDirectional;
    }
    if ("summary" in patch) {
      edge.summary = asNullableString(patch.summary);
    }
    if ("properties" in patch) {
      edge.properties = asObjectRecord(patch.properties);
    }
    if ("timeline" in patch) {
      edge.timeline = patch.timeline ? asObjectRecord(patch.timeline) : null;
    }
    if (nextSourceRef) {
      edge.sourceRef = nextSourceRef;
    }
    if (nextTargetRef) {
      edge.targetRef = nextTargetRef;
    }
    edge.currentVersion = nextVersion(edge.currentVersion);
    edge.updatedAt = appliedAt;

    return {
      id: edge.id,
      nodeRef: null,
      packetRef: null,
      sourceRef: edge.sourceRef,
      targetRef: edge.targetRef,
      relationType: edge.relationType,
      state: "updated",
      timeline: edge.timeline,
    };
  }

  private applyDeleteEdgeMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
  ): LocalGraphMutationApplyResult {
    const edgeRef = asString(mutation.edgeId).trim();
    if (!edgeRef) {
      throw new Error("local delete_edge mutation is missing edgeId");
    }

    const index = this.resolveEdgeIndex(slice, edgeRef);
    const existing = slice.edges[index]!;
    this.ensureEdgeBaseVersion(existing, asNumberOrNull(mutation.baseVersion));
    const [removed] = slice.edges.splice(index, 1);

    return {
      id: removed.id,
      nodeRef: null,
      packetRef: null,
      sourceRef: removed.sourceRef,
      targetRef: removed.targetRef,
      relationType: removed.relationType,
      state: "deleted",
      timeline: removed.timeline,
    };
  }

  private applyCreatePacketMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
    appliedAt: string,
  ): LocalGraphMutationApplyResult {
    const nodeRef = asString(mutation.nodeId).trim();
    if (!nodeRef) {
      throw new Error("local create_packet mutation is missing nodeId");
    }

    const nodeIndex = this.resolveNodeIndex(slice, nodeRef);
    const node = slice.nodes[nodeIndex]!;
    const packet = asRecord(mutation.packet);
    const packetKind = this.resolvePacketKindForNodeType(node.type);
    if (!packetKind) {
      throw new Error(`local graph packets are not supported for node type: ${node.type}`);
    }

    const packetRef = this.buildPacketRef({
      nodeRef: node.id,
      packetKind,
      packet,
    });
    const nextPayload = this.buildPacketPayload(node.type, packet);
    const nextSummaryText = this.buildPacketSummary(packet);
    const nextEvidenceRefIds =
      "evidenceRefs" in packet
        ? asStringArray(packet.evidenceRefs)
        : asStringArray(mutation.evidenceRefs);
    const existingIndex = slice.packets.findIndex((entry) => entry.ref === packetRef);

    if (existingIndex >= 0) {
      const existingPacket = slice.packets[existingIndex]!;
      existingPacket.currentVersion = nextVersion(existingPacket.currentVersion);
      existingPacket.packetKind = packetKind;
      existingPacket.ownerRef = node.id;
      existingPacket.scopeLevel = asString(packet.scopeLevel, existingPacket.scopeLevel);
      existingPacket.scopeRef = this.resolvePacketScopeRef(packet);
      existingPacket.authorityLevel = "user";
      existingPacket.state = "active";
      existingPacket.summaryText = nextSummaryText;
      existingPacket.payload = nextPayload;
      existingPacket.evidenceRefIds = nextEvidenceRefIds;
      existingPacket.updatedAt = appliedAt;
      node.meta = node.meta ?? {};
      node.meta.currentStateRef = existingPacket.ref;

      return {
        id: existingPacket.ref,
        nodeRef: node.id,
        packetRef: existingPacket.ref,
        sourceRef: null,
        targetRef: null,
        relationType: null,
        state: "updated",
        timeline: null,
      };
    }

    slice.packets.push({
      id: `packet:${normalizeIdSegment(packetRef)}`,
      currentVersion: 1,
      ref: packetRef,
      packetKind,
      ownerRef: node.id,
      scopeLevel: asString(packet.scopeLevel),
      scopeRef: this.resolvePacketScopeRef(packet),
      authorityLevel: "user",
      state: "active",
      summaryText: nextSummaryText,
      payload: nextPayload,
      evidenceRefIds: nextEvidenceRefIds,
      updatedAt: appliedAt,
    });
    node.meta = node.meta ?? {};
    node.meta.currentStateRef = packetRef;

    return {
      id: packetRef,
      nodeRef: node.id,
      packetRef,
      sourceRef: null,
      targetRef: null,
      relationType: null,
      state: "created",
      timeline: null,
    };
  }

  private applyUpdatePacketMutation(
    slice: LocalCanonicalGraphSlice,
    mutation: Record<string, unknown>,
    appliedAt: string,
  ): LocalGraphMutationApplyResult {
    const nodeRef = asString(mutation.nodeId).trim();
    if (!nodeRef) {
      throw new Error("local update_packet mutation is missing nodeId");
    }

    const nodeIndex = this.resolveNodeIndex(slice, nodeRef);
    const node = slice.nodes[nodeIndex]!;
    const packet = asRecord(mutation.packet);
    const packetKind = this.resolvePacketKindForNodeType(node.type);
    if (!packetKind) {
      throw new Error(`local graph packets are not supported for node type: ${node.type}`);
    }

    const requestedPacketRef = asNullableString(mutation.packetRef);
    if (requestedPacketRef) {
      const requestedPacketIndex = this.resolvePacketIndex(slice, requestedPacketRef);
      const requestedPacket = slice.packets[requestedPacketIndex]!;
      this.ensurePacketBaseVersion(
        requestedPacket,
        asNumberOrNull(mutation.baseVersion),
      );
    }

    const nextPacketRef = this.buildPacketRef({
      nodeRef: node.id,
      packetKind,
      packet,
    });
    const nextPayload = this.buildPacketPayload(node.type, packet);
    const nextSummaryText = this.buildPacketSummary(packet);
    const nextEvidenceRefIds =
      "evidenceRefs" in packet
        ? asStringArray(packet.evidenceRefs)
        : asStringArray(mutation.evidenceRefs);
    const existingIndex = slice.packets.findIndex((entry) => entry.ref === nextPacketRef);

    if (existingIndex >= 0) {
      const existingPacket = slice.packets[existingIndex]!;
      existingPacket.currentVersion = nextVersion(existingPacket.currentVersion);
      existingPacket.packetKind = packetKind;
      existingPacket.ownerRef = node.id;
      existingPacket.scopeLevel = asString(packet.scopeLevel, existingPacket.scopeLevel);
      existingPacket.scopeRef = this.resolvePacketScopeRef(packet);
      existingPacket.authorityLevel = "user";
      existingPacket.state = "active";
      existingPacket.summaryText = nextSummaryText;
      existingPacket.payload = nextPayload;
      existingPacket.evidenceRefIds = nextEvidenceRefIds;
      existingPacket.updatedAt = appliedAt;
      node.meta = node.meta ?? {};
      node.meta.currentStateRef = existingPacket.ref;

      return {
        id: existingPacket.ref,
        nodeRef: node.id,
        packetRef: existingPacket.ref,
        sourceRef: null,
        targetRef: null,
        relationType: null,
        state: "updated",
        timeline: null,
      };
    }

    slice.packets.push({
      id: `packet:${normalizeIdSegment(nextPacketRef)}`,
      currentVersion: 1,
      ref: nextPacketRef,
      packetKind,
      ownerRef: node.id,
      scopeLevel: asString(packet.scopeLevel),
      scopeRef: this.resolvePacketScopeRef(packet),
      authorityLevel: "user",
      state: "active",
      summaryText: nextSummaryText,
      payload: nextPayload,
      evidenceRefIds: nextEvidenceRefIds,
      updatedAt: appliedAt,
    });
    node.meta = node.meta ?? {};
    node.meta.currentStateRef = nextPacketRef;

    return {
      id: nextPacketRef,
      nodeRef: node.id,
      packetRef: nextPacketRef,
      sourceRef: null,
      targetRef: null,
      relationType: null,
      state: "created",
      timeline: null,
    };
  }

  async applyMutation(
    mutation: Record<string, unknown>,
  ): Promise<LocalGraphMutationApplyEnvelope> {
    const kind = asString(mutation.kind).trim();
    if (!kind) {
      throw new Error("local graph mutation is missing kind");
    }

    const slicePath = await this.getWritableSnapshotPath();
    const baseSlice = await this.loadSlice();
    const nextSlice = structuredClone(baseSlice);
    const appliedAt = new Date().toISOString();

    let result: LocalGraphMutationApplyResult;
    switch (kind) {
      case "create_node":
        result = this.applyCreateNodeMutation(nextSlice, mutation, appliedAt);
        break;
      case "update_node":
        result = this.applyUpdateNodeMutation(nextSlice, mutation, appliedAt);
        break;
      case "patch_node_timeline":
        result = this.applyPatchNodeTimelineMutation(nextSlice, mutation, appliedAt);
        break;
      case "delete_node":
        result = this.applyDeleteNodeMutation(nextSlice, mutation);
        break;
      case "create_edge":
        result = this.applyCreateEdgeMutation(nextSlice, mutation, appliedAt);
        break;
      case "create_packet":
        result = this.applyCreatePacketMutation(nextSlice, mutation, appliedAt);
        break;
      case "update_edge":
        result = this.applyUpdateEdgeMutation(nextSlice, mutation, appliedAt);
        break;
      case "update_packet":
        result = this.applyUpdatePacketMutation(nextSlice, mutation, appliedAt);
        break;
      case "delete_edge":
        result = this.applyDeleteEdgeMutation(nextSlice, mutation);
        break;
      default:
        throw new Error(`local graph mutation kind is not supported: ${kind}`);
    }

    nextSlice.version = {
      versionToken: `local-snapshot:${appliedAt}`,
      snapshotAt: appliedAt,
    };
    await this.writeSlice(slicePath, nextSlice);

    return {
      result,
      appliedAt,
      snapshotAt: nextSlice.version.snapshotAt,
      versionToken: nextSlice.version.versionToken,
      snapshotPath: slicePath,
    };
  }

  async applyProposalItems(input: {
    proposalSetId: string;
    items: LocalGraphProposalItemRecord[];
    temporalContext?: {
      triggerEpisodeId?: string | null;
      currentEpisodeNumber?: number | null;
      factText?: string | null;
    };
  }) {
    const slicePath = await this.getWritableSnapshotPath();
    const baseSlice = await this.loadSlice();
    const nextSlice = structuredClone(baseSlice);
    const appliedAt = new Date().toISOString();
    const targetRefsByItemId: Record<string, string> = {};

    const sortedItems = [...input.items].sort(
      (left, right) =>
        (ITEM_APPLY_ORDER[left.opKind] ?? Number.MAX_SAFE_INTEGER) -
          (ITEM_APPLY_ORDER[right.opKind] ?? Number.MAX_SAFE_INTEGER) ||
        left.sequence - right.sequence,
    );

    for (const item of sortedItems) {
      switch (item.opKind) {
        case "create_node":
          targetRefsByItemId[item.id] = this.applyCreateNodeItem(
            nextSlice,
            item,
            appliedAt,
          );
          break;
        case "create_edge":
          targetRefsByItemId[item.id] = this.applyCreateEdgeItem(
            nextSlice,
            item,
            appliedAt,
            input.temporalContext,
          );
          break;
        default:
          throw new Error(
            `local graph apply does not support proposal opKind: ${item.opKind}`,
          );
      }
    }

    nextSlice.version = {
      versionToken: `local-snapshot:${appliedAt}`,
      snapshotAt: appliedAt,
    };
    await this.writeSlice(slicePath, nextSlice);

    return {
      appliedAt,
      snapshotAt: nextSlice.version.snapshotAt,
      versionToken: nextSlice.version.versionToken,
      snapshotPath: slicePath,
      targetRefsByItemId,
    };
  }

  async query(request: LocalGraphQueryRequest): Promise<LocalGraphQueryResponse> {
    const snapshotPath = await this.getResolvedSnapshotPath();
    const baseSlice = await this.loadSlice();
    const warnings: string[] = [];
    const nodeByRef = new Map(baseSlice.nodes.map((node) => [node.id, node]));

    for (const edge of baseSlice.edges) {
      if (!nodeByRef.has(edge.sourceRef) || !nodeByRef.has(edge.targetRef)) {
        warnings.push(
          `Local graph edge ${edge.id} references missing node refs (${edge.sourceRef} -> ${edge.targetRef}).`,
        );
      }
    }

    let slice = applyEpisodeFilter(baseSlice, request.filters?.atEpisode);
    let nodes = slice.nodes;
    let edges = slice.edges;
    let packets = slice.packets;

    if (request.filters?.nodeRefs?.length) {
      const allowed = new Set(request.filters.nodeRefs);
      nodes = nodes.filter((node) => allowed.has(node.id));
      edges = edges.filter(
        (edge) => allowed.has(edge.sourceRef) || allowed.has(edge.targetRef),
      );
      packets = packets.filter(
        (packet) => allowed.has(packet.ownerRef) || allowed.has(packet.scopeRef),
      );
    }

    if (request.filters?.planes?.length) {
      const allowed = new Set(request.filters.planes);
      nodes = nodes.filter((node) => allowed.has(node.plane));
    }

    if (request.filters?.nodeTypes?.length) {
      const allowed = new Set(request.filters.nodeTypes);
      nodes = nodes.filter((node) => allowed.has(node.type));
    }

    nodes = applyTextSearch(nodes, request.filters?.textSearch);
    const nodeRefSet = new Set(nodes.map((node) => node.id));
    edges = edges.filter(
      (edge) => nodeRefSet.has(edge.sourceRef) || nodeRefSet.has(edge.targetRef),
    );
    packets = packets.filter(
      (packet) => nodeRefSet.has(packet.ownerRef) || nodeRefSet.has(packet.scopeRef),
    );

    const focusRefs = Array.from(
      new Set(
        [
          ...(request.filters?.focusRef ? [request.filters.focusRef] : []),
          ...(request.filters?.focusRefs ?? []),
        ].filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        ),
      ),
    );

    if (focusRefs.length > 0) {
      const neighborDepth =
        request.filters?.neighborDepth ?? (request.mode === "node_detail" ? 1 : 0);
      const neighborhood = collectNeighborhood(nodes, edges, focusRefs, neighborDepth);
      nodes = neighborhood.nodes;
      edges = neighborhood.edges;
      packets = packets.filter(
        (packet) =>
          neighborhood.allowedRefs.has(packet.ownerRef) ||
          neighborhood.allowedRefs.has(packet.scopeRef),
      );
    } else {
      edges = edges.filter(
        (edge) => nodeRefSet.has(edge.sourceRef) && nodeRefSet.has(edge.targetRef),
      );
    }

    const limit = request.pagination?.limit;
    if (typeof limit === "number" && limit > 0) {
      const limitedNodes = sortByUpdatedAt(nodes).slice(0, limit);
      const allowedRefs = new Set(limitedNodes.map((node) => node.id));
      nodes = limitedNodes;
      edges = edges.filter(
        (edge) => allowedRefs.has(edge.sourceRef) && allowedRefs.has(edge.targetRef),
      );
      packets = packets.filter(
        (packet) => allowedRefs.has(packet.ownerRef) || allowedRefs.has(packet.scopeRef),
      );
    } else {
      nodes = sortByUpdatedAt(nodes);
      edges = sortByUpdatedAt(edges);
      packets = sortByUpdatedAt(packets);
    }

    return {
      versionToken: baseSlice.version.versionToken,
      snapshotAt: baseSlice.version.snapshotAt,
      nodes: request.include?.nodes === false ? [] : nodes,
      edges: request.include?.edges === false ? [] : edges,
      packets: request.include?.packets === false ? [] : packets,
      aggregateDetails: null,
      warnings,
      meta: {
        authority: "local-snapshot",
        readSource: "local-json",
        projectId: this.projectId,
        snapshotPath: snapshotPath
          ? normalizePathSeparators(path.relative(this.projectRoot, snapshotPath))
          : null,
        revisionHint: baseSlice.version.versionToken,
      },
    };
  }
}
