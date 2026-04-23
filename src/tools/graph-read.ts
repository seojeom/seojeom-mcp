import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import { renderGraphNodeListText, summarizeGraphNodeRows } from "./shared.js";

type CanonicalGraphNode = {
  id: string;
  label: string;
  type: string;
  plane: string;
  summary: string;
};

type CanonicalGraphEdge = {
  id: string;
  sourceRef: string;
  targetRef: string;
  relationType: string;
  relationFamily: string;
  summary?: string | null;
};

type GraphQueryResponse = {
  nodes: CanonicalGraphNode[];
  edges: CanonicalGraphEdge[];
  packets: Array<Record<string, unknown>>;
  aggregateDetails?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown>;
  warnings?: string[];
};

function listNodesRequest(input: {
  nodeTypes?: string[];
  planes?: string[];
  textSearch?: string | null;
  limit?: number;
}): {
  mode: "slice";
  filters: {
    nodeTypes?: string[];
    planes?: string[];
    textSearch: string | null;
  };
  include: {
    nodes: true;
    edges: false;
    packets: false;
  };
  pagination: {
    limit: number;
  };
} {
  return {
    mode: "slice",
    filters: {
      nodeTypes: input.nodeTypes,
      planes: input.planes,
      textSearch: input.textSearch ?? null,
    },
    include: {
      nodes: true,
      edges: false,
      packets: false,
    },
    pagination: {
      limit: input.limit ?? 50,
    },
  };
}

export function registerGraphReadTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_list_nodes",
    {
      title: "List Graph Nodes",
      description: "List graph nodes with optional node type, plane, and text filters.",
      inputSchema: {
        nodeTypes: z.array(z.string()).optional(),
        planes: z.array(z.string()).optional(),
        labelContains: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ nodeTypes, planes, labelContains, limit }) => {
      const payload = context.localGraphStore
        ? await context.localGraphStore.query(
            listNodesRequest({
              nodeTypes,
              planes,
              textSearch: labelContains ?? null,
              limit: limit ?? 50,
            }),
          )
        : await context.apiBridge.postJson<GraphQueryResponse>(
            `/api/projects/${context.config.projectId}/graph/query`,
            listNodesRequest({
              nodeTypes,
              planes,
              textSearch: labelContains ?? null,
              limit: limit ?? 50,
            }),
          );
      const rows = summarizeGraphNodeRows(payload.nodes);

      return {
        content: [
          {
            type: "text" as const,
            text: renderGraphNodeListText("graph nodes", rows),
          },
        ],
        structuredContent: {
          rows,
          warnings: payload.warnings ?? [],
          meta: payload.meta ?? null,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_search_nodes",
    {
      title: "Search Graph Nodes",
      description: "Search graph nodes by text query, with optional type filters.",
      inputSchema: {
        query: z.string().min(1),
        nodeTypes: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query, nodeTypes, limit }) => {
      const payload = context.localGraphStore
        ? await context.localGraphStore.query(
            listNodesRequest({
              nodeTypes,
              textSearch: query,
              limit: limit ?? 20,
            }),
          )
        : await context.apiBridge.postJson<GraphQueryResponse>(
            `/api/projects/${context.config.projectId}/graph/query`,
            listNodesRequest({
              nodeTypes,
              textSearch: query,
              limit: limit ?? 20,
            }),
          );
      const rows = summarizeGraphNodeRows(payload.nodes);

      return {
        content: [
          {
            type: "text" as const,
            text: renderGraphNodeListText(`graph search: ${query}`, rows),
          },
        ],
        structuredContent: {
          query,
          rows,
          warnings: payload.warnings ?? [],
          meta: payload.meta ?? null,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_get_node",
    {
      title: "Get Graph Node",
      description: "Load one node plus neighboring edges and aggregate detail by graph ref.",
      inputSchema: {
        nodeRef: z.string().min(1),
      },
    },
    async ({ nodeRef }) => {
      const payload = context.localGraphStore
        ? await context.localGraphStore.query({
            mode: "node_detail",
            filters: {
              focusRef: nodeRef,
              focusRefs: [nodeRef],
              neighborDepth: 1,
            },
            include: {
              nodes: true,
              edges: true,
              packets: true,
            },
          })
        : await context.apiBridge.postJson<GraphQueryResponse>(
            `/api/projects/${context.config.projectId}/graph/query`,
            {
              mode: "node_detail",
              filters: {
                focusRef: nodeRef,
                focusRefs: [nodeRef],
                neighborDepth: 1,
              },
              include: {
                nodes: true,
                edges: true,
                packets: true,
              },
            },
          );

      const focusNode = payload.nodes.find((node) => node.id === nodeRef) ?? payload.nodes[0] ?? null;
      const connectedEdges = payload.edges.filter(
        (edge) => edge.sourceRef === nodeRef || edge.targetRef === nodeRef,
      );

      const lines = [
        `[graph node] ${focusNode?.label ?? nodeRef}`,
        `- ref: ${nodeRef}`,
        `- type: ${focusNode?.type ?? "-"}`,
        `- plane: ${focusNode?.plane ?? "-"}`,
        `- summary: ${focusNode?.summary ?? "-"}`,
        `- connectedEdges: ${connectedEdges.length}`,
      ];

      for (const edge of connectedEdges.slice(0, 20)) {
        lines.push(
          `  - ${edge.sourceRef} ${edge.relationType} ${edge.targetRef} (${edge.relationFamily})`,
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          focusNode,
          nodes: payload.nodes,
          edges: connectedEdges,
          packets: payload.packets,
          aggregateDetails: payload.aggregateDetails ?? null,
          warnings: payload.warnings ?? [],
          meta: payload.meta ?? null,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_neighborhood",
    {
      title: "Get Graph Neighborhood",
      description: "Load a graph neighborhood around one focus ref with configurable depth.",
      inputSchema: {
        focusRef: z.string().min(1),
        neighborDepth: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
      },
    },
    async ({ focusRef, neighborDepth }) => {
      const payload = context.localGraphStore
        ? await context.localGraphStore.query({
            mode: "slice",
            filters: {
              focusRef,
              focusRefs: [focusRef],
              neighborDepth: neighborDepth ?? 1,
            },
            include: {
              nodes: true,
              edges: true,
              packets: false,
            },
            pagination: {
              limit: 100,
            },
          })
        : await context.apiBridge.postJson<GraphQueryResponse>(
            `/api/projects/${context.config.projectId}/graph/query`,
            {
              mode: "slice",
              filters: {
                focusRef,
                focusRefs: [focusRef],
                neighborDepth: neighborDepth ?? 1,
              },
              include: {
                nodes: true,
                edges: true,
                packets: false,
              },
              pagination: {
                limit: 100,
              },
            },
          );

      const rows = summarizeGraphNodeRows(payload.nodes);
      const lines = [
        renderGraphNodeListText(`graph neighborhood: ${focusRef}`, rows),
        "",
        `[edges] ${payload.edges.length}개`,
      ];
      for (const edge of payload.edges.slice(0, 30)) {
        lines.push(`- ${edge.sourceRef} ${edge.relationType} ${edge.targetRef}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          focusRef,
          nodes: rows,
          edges: payload.edges,
          warnings: payload.warnings ?? [],
          meta: payload.meta ?? null,
        },
      };
    },
  );
}
