import type { LocalGraphSnapshotStore } from "./local-graph-store.js";

const CORE_NODE_TYPES = ["character", "conflict", "premise"] as const;
const STRUCTURAL_NODE_TYPES = new Set([
  "story_root",
  "part",
  "arc",
  "chapter",
  "episode",
  "scene",
  "beat",
]);
const PACKET_EXPECTED_NODE_TYPES = new Set(["character", "organization"]);

type LocalGraphSlice = Awaited<ReturnType<LocalGraphSnapshotStore["loadSlice"]>>;
type LocalGraphNode = LocalGraphSlice["nodes"][number];
type LocalGraphEdge = LocalGraphSlice["edges"][number];
type LocalGraphPacket = LocalGraphSlice["packets"][number];

export type LocalGraphGapFinding = {
  id: string;
  kind:
    | "missing_core_type"
    | "orphan_node"
    | "weak_hub"
    | "unresolved_foreshadowing"
    | "missing_state_packet"
    | "empty_summary";
  severity: "critical" | "warning" | "suggestion";
  title: string;
  message: string;
  targetRef: string | null;
  targetKind: "graph" | "node";
  suggestedAction: "add_node" | "add_relation" | "add_packet" | "update_node" | null;
  relatedNodeRefs: string[];
  prompt: string;
};

export type LocalGraphGapAnalysisResult = {
  authority: "local-snapshot";
  snapshot: {
    versionToken: string;
    snapshotAt: string;
    snapshotPath: string | null;
  };
  focusNodeId: string | null;
  atEpisode: number | null;
  counts: {
    nodeCount: number;
    edgeCount: number;
    packetCount: number;
    findingCount: number;
    criticalCount: number;
    warningCount: number;
    suggestionCount: number;
  };
  summary: string;
  findings: LocalGraphGapFinding[];
  warnings: string[];
};

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function episodeFilterMatchesTimeline(
  timeline: Record<string, unknown> | null | undefined,
  atEpisode: number | null,
) {
  if (atEpisode == null) {
    return true;
  }

  const anchorEpisodeNumber = asNumberOrNull(timeline?.anchorEpisodeNumber);
  if (anchorEpisodeNumber != null && anchorEpisodeNumber > atEpisode) {
    return false;
  }

  const validFromEpisode = asNumberOrNull(timeline?.validFromEpisode);
  if (validFromEpisode != null && validFromEpisode > atEpisode) {
    return false;
  }

  const validUntilEpisode = asNumberOrNull(timeline?.validUntilEpisode);
  if (validUntilEpisode != null && validUntilEpisode < atEpisode) {
    return false;
  }

  return true;
}

function packetMatchesEpisode(packet: LocalGraphPacket, atEpisode: number | null) {
  if (atEpisode == null || packet.scopeLevel !== "episode") {
    return true;
  }

  const match = /^episode:(\d+)$/.exec(packet.scopeRef);
  if (!match) {
    return true;
  }

  return Number.parseInt(match[1] ?? "", 10) <= atEpisode;
}

function filterSliceByEpisode(slice: LocalGraphSlice, atEpisode: number | null): LocalGraphSlice {
  if (atEpisode == null) {
    return slice;
  }

  return {
    version: slice.version,
    nodes: slice.nodes.filter((node) => episodeFilterMatchesTimeline(node.timeline ?? null, atEpisode)),
    edges: slice.edges.filter((edge) => episodeFilterMatchesTimeline(edge.timeline ?? null, atEpisode)),
    packets: slice.packets.filter((packet) => packetMatchesEpisode(packet, atEpisode)),
  };
}

function countEdgesByNodeRef(edges: LocalGraphEdge[]) {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    counts.set(edge.sourceRef, (counts.get(edge.sourceRef) ?? 0) + 1);
    counts.set(edge.targetRef, (counts.get(edge.targetRef) ?? 0) + 1);
  }
  return counts;
}

function formatNodeDisplay(node: LocalGraphNode) {
  return node.label.trim() || node.id;
}

function summarizeCounts(input: {
  focusNodeId: string | null;
  counts: LocalGraphGapAnalysisResult["counts"];
}) {
  const prefix = input.focusNodeId ? `node ${input.focusNodeId}` : "graph";
  if (input.counts.findingCount === 0) {
    return `${prefix} has no structural or snapshot-derived gap findings.`;
  }

  const severityParts = [
    input.counts.criticalCount > 0 ? `critical ${input.counts.criticalCount}` : null,
    input.counts.warningCount > 0 ? `warning ${input.counts.warningCount}` : null,
    input.counts.suggestionCount > 0 ? `suggestion ${input.counts.suggestionCount}` : null,
  ].filter((value): value is string => Boolean(value));

  return `${prefix} gap analysis found ${input.counts.findingCount} finding(s) (${severityParts.join(", ")}).`;
}

function findingPriority(finding: LocalGraphGapFinding) {
  switch (finding.kind) {
    case "missing_core_type":
      return 0;
    case "orphan_node":
      return 10;
    case "missing_state_packet":
      return 20;
    case "weak_hub":
      return 30;
    case "unresolved_foreshadowing":
      return 40;
    case "empty_summary":
      return 50;
  }
}

function buildMissingCoreTypeFinding(missingCoreTypes: string[]): LocalGraphGapFinding | null {
  if (missingCoreTypes.length === 0) {
    return null;
  }

  return {
    id: `local-gap:missing-core:${missingCoreTypes.join(",")}`,
    kind: "missing_core_type",
    severity: "critical",
    title: "핵심 노드 타입 누락",
    message: `핵심 노드 타입이 비어 있습니다: ${missingCoreTypes.join(", ")}.`,
    targetRef: null,
    targetKind: "graph",
    suggestedAction: "add_node",
    relatedNodeRefs: [],
    prompt:
      `현재 local canonical snapshot에 ${missingCoreTypes.join(", ")} 타입 노드가 없습니다. ` +
      "기존 wiki/graph 근거만 사용해서 최소 핵심 노드를 제안하세요.",
  };
}

function buildOrphanFinding(node: LocalGraphNode): LocalGraphGapFinding {
  const label = formatNodeDisplay(node);
  return {
    id: `local-gap:orphan:${node.id}`,
    kind: "orphan_node",
    severity: "warning",
    title: `고아 노드 · ${label}`,
    message: `"${label}" (${node.id}) 노드에 연결된 edge가 없습니다.`,
    targetRef: node.id,
    targetKind: "node",
    suggestedAction: "add_relation",
    relatedNodeRefs: [node.id],
    prompt:
      `노드 "${label}"를 현재 그래프와 연결하세요. ` +
      "이미 존재하는 counterpart가 있으면 relation만 추가하고, 꼭 필요할 때만 새 node를 함께 제안하세요.",
  };
}

function buildWeakHubFinding(node: LocalGraphNode, edgeCount: number): LocalGraphGapFinding {
  const label = formatNodeDisplay(node);
  return {
    id: `local-gap:weak-hub:${node.id}`,
    kind: "weak_hub",
    severity: "warning",
    title: `관계 부족 · ${label}`,
    message: `캐릭터 "${label}" (${node.id})의 관계 수가 ${edgeCount}개뿐입니다.`,
    targetRef: node.id,
    targetKind: "node",
    suggestedAction: "add_relation",
    relatedNodeRefs: [node.id],
    prompt:
      `캐릭터 "${label}"를 story-useful relation으로 더 연결하세요. ` +
      "goal, conflict, organization, item, location 중 현재 맥락에 맞는 최소 연결부터 제안하세요.",
  };
}

function buildForeshadowingFinding(node: LocalGraphNode): LocalGraphGapFinding {
  const label = formatNodeDisplay(node);
  return {
    id: `local-gap:foreshadowing:${node.id}`,
    kind: "unresolved_foreshadowing",
    severity: "warning",
    title: `복선 미회수 · ${label}`,
    message: `복선 "${label}" (${node.id})에 foreshadows relation이 없습니다.`,
    targetRef: node.id,
    targetKind: "node",
    suggestedAction: "add_relation",
    relatedNodeRefs: [node.id],
    prompt:
      `복선 "${label}"가 가리키는 대상 node 또는 relation을 연결하세요. ` +
      "이미 존재하는 사실이면 edge만 추가하고, 아직 대상이 없다면 최소 대응 node를 함께 제안하세요.",
  };
}

function buildMissingPacketFinding(node: LocalGraphNode): LocalGraphGapFinding {
  const label = formatNodeDisplay(node);
  return {
    id: `local-gap:packet:${node.id}`,
    kind: "missing_state_packet",
    severity: "warning",
    title: `상태 패킷 없음 · ${label}`,
    message: `"${label}" (${node.id})에 현재 상태 packet이 없습니다.`,
    targetRef: node.id,
    targetKind: "node",
    suggestedAction: "add_packet",
    relatedNodeRefs: [node.id],
    prompt:
      `노드 "${label}"의 현재 상태 packet을 보강하세요. ` +
      "현재 시점에 필요한 location, pressure, goal, allegiance 같은 상태 필드만 최소한으로 제안하세요.",
  };
}

function buildEmptySummaryFinding(node: LocalGraphNode): LocalGraphGapFinding {
  const label = formatNodeDisplay(node);
  return {
    id: `local-gap:summary:${node.id}`,
    kind: "empty_summary",
    severity: "suggestion",
    title: `요약 보강 · ${label}`,
    message: `"${label}" (${node.id}) 노드에 summary가 비어 있습니다.`,
    targetRef: node.id,
    targetKind: "node",
    suggestedAction: "update_node",
    relatedNodeRefs: [node.id],
    prompt:
      `노드 "${label}"의 canonical summary를 한두 문장으로 보강하세요. ` +
      "현재 그래프와 wiki에 있는 정보만 사용하고, 새 사실은 만들지 마세요.",
  };
}

export async function analyzeLocalGraphGaps(input: {
  store: LocalGraphSnapshotStore;
  focusNodeId?: string | null;
  maxFindings?: number;
  atEpisode?: number | null;
}): Promise<LocalGraphGapAnalysisResult> {
  const snapshotPath = await input.store.getResolvedSnapshotPath();
  const fullSlice = await input.store.loadSlice();
  const slice = filterSliceByEpisode(fullSlice, input.atEpisode ?? null);
  const focusNodeId = input.focusNodeId?.trim() || null;
  const maxFindings = Math.max(1, Math.min(input.maxFindings ?? 8, 20));
  const warnings: string[] = [];

  if (!snapshotPath) {
    warnings.push("local graph snapshot file was not found; analyzed the empty in-memory slice.");
  }

  if (focusNodeId && !slice.nodes.some((node) => node.id === focusNodeId)) {
    throw new Error(`focus node not found in local graph snapshot: ${focusNodeId}`);
  }

  const edgeCounts = countEdgesByNodeRef(slice.edges);
  const findings: LocalGraphGapFinding[] = [];

  if (!focusNodeId) {
    const presentTypes = new Set(slice.nodes.map((node) => node.type));
    const missingCoreTypes = CORE_NODE_TYPES.filter((nodeType) => !presentTypes.has(nodeType));
    const missingCoreTypeFinding = buildMissingCoreTypeFinding(missingCoreTypes);
    if (missingCoreTypeFinding) {
      findings.push(missingCoreTypeFinding);
    }
  }

  for (const node of slice.nodes) {
    if (focusNodeId && node.id !== focusNodeId) {
      continue;
    }

    const edgeCount = edgeCounts.get(node.id) ?? 0;
    if (!STRUCTURAL_NODE_TYPES.has(node.type) && edgeCount === 0) {
      findings.push(buildOrphanFinding(node));
    }

    if (node.type === "character" && edgeCount <= 1) {
      findings.push(buildWeakHubFinding(node, edgeCount));
    }

    if (node.type === "foreshadowing") {
      const hasForeshadowEdge = slice.edges.some(
        (edge) => edge.sourceRef === node.id && edge.relationType === "foreshadows",
      );
      if (!hasForeshadowEdge) {
        findings.push(buildForeshadowingFinding(node));
      }
    }

    if (PACKET_EXPECTED_NODE_TYPES.has(node.type)) {
      const hasPacket = slice.packets.some((packet) => packet.ownerRef === node.id);
      if (!hasPacket) {
        findings.push(buildMissingPacketFinding(node));
      }
    }

    if (!node.summary.trim()) {
      findings.push(buildEmptySummaryFinding(node));
    }
  }

  const orderedFindings = findings
    .sort((left, right) => {
      const priorityDiff = findingPriority(left) - findingPriority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return left.title.localeCompare(right.title, "ko");
    })
    .slice(0, maxFindings);

  const counts = {
    nodeCount: slice.nodes.length,
    edgeCount: slice.edges.length,
    packetCount: slice.packets.length,
    findingCount: orderedFindings.length,
    criticalCount: orderedFindings.filter((finding) => finding.severity === "critical").length,
    warningCount: orderedFindings.filter((finding) => finding.severity === "warning").length,
    suggestionCount: orderedFindings.filter((finding) => finding.severity === "suggestion").length,
  };

  return {
    authority: "local-snapshot",
    snapshot: {
      versionToken: slice.version.versionToken,
      snapshotAt: slice.version.snapshotAt,
      snapshotPath,
    },
    focusNodeId,
    atEpisode: input.atEpisode ?? null,
    counts,
    summary: summarizeCounts({
      focusNodeId,
      counts,
    }),
    findings: orderedFindings,
    warnings,
  };
}
