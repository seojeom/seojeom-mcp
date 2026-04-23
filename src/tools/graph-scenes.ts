import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import {
  LocalGraphSceneStore,
  LocalGraphSceneVersionConflictError,
} from "../local-graph-scene-store.js";

function requireLocalGraphSceneStore(context: DesktopMcpContext) {
  if (!context.localGraphSceneStore) {
    throw new Error(
      "Local graph scene tools require graphAuthority=local-snapshot.",
    );
  }

  return context.localGraphSceneStore;
}

function summarizeScene(store: LocalGraphSceneStore, scene: {
  id: string;
  name: string;
  version: number;
  objects: unknown[];
  links: unknown[];
  isDefault: boolean;
}) {
  return [
    `[graph scene] ${scene.name}`,
    `- id: ${scene.id}`,
    `- version: ${scene.version}`,
    `- default: ${scene.isDefault ? "yes" : "no"}`,
    `- objects: ${scene.objects.length}`,
    `- links: ${scene.links.length}`,
    `- store: ${store.getResolvedSceneStorePath()}`,
  ].join("\n");
}

function summarizeSceneList(store: LocalGraphSceneStore, scenes: {
  id: string;
  name: string;
  version: number;
  objectCount: number;
  linkCount: number;
  isDefault: boolean;
}[]) {
  return [
    `[graph scenes] ${scenes.length} total`,
    `- store: ${store.getResolvedSceneStorePath()}`,
    ...scenes.slice(0, 8).map((scene) =>
      `- ${scene.isDefault ? "[default] " : ""}${scene.name} (${scene.id}) v${scene.version} objects=${scene.objectCount} links=${scene.linkCount}`,
    ),
  ].join("\n");
}

export function registerGraphSceneTools(
  server: McpServer,
  context: DesktopMcpContext,
) {
  server.registerTool(
    "seojeom_list_graph_scenes",
    {
      title: "List Graph Scenes",
      description:
        "List locally persisted graph scene summaries for the current project.",
      inputSchema: {},
    },
    async () => {
      const store = requireLocalGraphSceneStore(context);
      const scenes = await store.listScenes();

      return {
        content: [
          {
            type: "text" as const,
            text: summarizeSceneList(store, scenes),
          },
        ],
        structuredContent: {
          storePath: store.getResolvedSceneStorePath(),
          scenes,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_get_default_graph_scene",
    {
      title: "Get Default Graph Scene",
      description:
        "Read or create the default local graph scene for the current project.",
      inputSchema: {},
    },
    async () => {
      const store = requireLocalGraphSceneStore(context);
      const scene = await store.getOrCreateDefaultScene();

      return {
        content: [
          {
            type: "text" as const,
            text: summarizeScene(store, scene),
          },
        ],
        structuredContent: {
          storePath: store.getResolvedSceneStorePath(),
          scene,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_read_graph_scene",
    {
      title: "Read Graph Scene",
      description:
        "Read a local graph scene by id, or fall back to the default scene when no id is provided.",
      inputSchema: {
        sceneId: z.string().optional(),
      },
    },
    async ({ sceneId }) => {
      const store = requireLocalGraphSceneStore(context);
      const scene = sceneId?.trim()
        ? await store.getScene(sceneId.trim())
        : await store.getOrCreateDefaultScene();

      if (!scene) {
        return {
          content: [
            {
              type: "text" as const,
              text: `[graph scene] not found: ${sceneId?.trim() ?? "-"}`,
            },
          ],
          structuredContent: {
            ok: false,
            storePath: store.getResolvedSceneStorePath(),
            scene: null,
          },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: summarizeScene(store, scene),
          },
        ],
        structuredContent: {
          ok: true,
          storePath: store.getResolvedSceneStorePath(),
          scene,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_create_graph_scene",
    {
      title: "Create Graph Scene",
      description:
        "Create a new local graph scene for the current project.",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async ({ name }) => {
      const store = requireLocalGraphSceneStore(context);
      const approval = await context.approval.requestApproval({
        action: "graph_scene_create",
        toolName: "seojeom_create_graph_scene",
        title: name?.trim() || "new graph scene",
        summary: null,
        details: [],
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[graph scene approval] ${name?.trim() || "new graph scene"}`,
                "- status: denied",
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

      const scene = await store.createScene({ name });
      return {
        content: [
          {
            type: "text" as const,
            text: summarizeScene(store, scene),
          },
        ],
        structuredContent: {
          ok: true,
          approval,
          storePath: store.getResolvedSceneStorePath(),
          scene,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_save_graph_scene",
    {
      title: "Save Graph Scene",
      description:
        "Persist local graph scene objects, links, and viewport state for the current project.",
      inputSchema: {
        sceneId: z.string().min(1),
        baseVersion: z.number().int().positive().optional(),
        lastSeenSemanticVersionToken: z.string().nullable().optional(),
        objects: z.array(
          z.object({
            id: z.string().optional(),
            objectKind: z.enum([
              "canonical_node",
              "proposal_node",
              "ghost_node",
              "note_anchor",
            ]),
            canonicalRef: z.string().nullable().optional(),
            proposalItemId: z.string().nullable().optional(),
            extractionRunId: z.string().nullable().optional(),
            tempKey: z.string().nullable().optional(),
            x: z.number(),
            y: z.number(),
            width: z.number().nullable().optional(),
            height: z.number().nullable().optional(),
            pinned: z.boolean().optional(),
            collapsed: z.boolean().optional(),
            zIndex: z.number().int().optional(),
            styleJson: z.record(z.string(), z.unknown()).nullable().optional(),
          }),
        ),
        links: z.array(
          z.object({
            id: z.string().optional(),
            tempKey: z.string().nullable().optional(),
            sourceCanonicalRef: z.string().nullable().optional(),
            targetCanonicalRef: z.string().nullable().optional(),
            sourceTempKey: z.string().nullable().optional(),
            targetTempKey: z.string().nullable().optional(),
            canonicalEdgeRef: z.string().nullable().optional(),
            proposalItemId: z.string().nullable().optional(),
            hidden: z.boolean().optional(),
            labelVisible: z.boolean().optional(),
            waypointsJson: z.array(z.unknown()).nullable().optional(),
            styleJson: z.record(z.string(), z.unknown()).nullable().optional(),
          }),
        ),
        viewport: z
          .object({
            x: z.number().optional(),
            y: z.number().optional(),
            zoom: z.number().optional(),
            selectedObjectIds: z.array(z.string()).optional(),
            selectedSelectionToken: z.string().nullable().optional(),
          })
          .optional(),
      },
    },
    async ({
      sceneId,
      baseVersion,
      lastSeenSemanticVersionToken,
      objects,
      links,
      viewport,
    }) => {
      const store = requireLocalGraphSceneStore(context);
      const approval = await context.approval.requestApproval({
        action: "graph_scene_save",
        toolName: "seojeom_save_graph_scene",
        title: sceneId.trim(),
        summary: null,
        details: [
          `objects=${objects.length}`,
          `links=${links.length}`,
          `baseVersion=${typeof baseVersion === "number" ? baseVersion : "-"}`,
        ],
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[graph scene approval] ${sceneId.trim()}`,
                "- status: denied",
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
        const scene = await store.saveScene(sceneId.trim(), {
          baseVersion,
          lastSeenSemanticVersionToken,
          objects,
          links,
          viewport,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: summarizeScene(store, scene),
            },
          ],
          structuredContent: {
            ok: true,
            approval,
            storePath: store.getResolvedSceneStorePath(),
            scene,
          },
        };
      } catch (error) {
        if (error instanceof LocalGraphSceneVersionConflictError) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `[graph scene] version conflict`,
                  `- sceneId: ${sceneId.trim()}`,
                  `- currentVersion: ${error.currentVersion}`,
                ].join("\n"),
              },
            ],
            structuredContent: {
              ok: false,
              code: "VERSION_CONFLICT",
              currentVersion: error.currentVersion,
              approval,
            },
          };
        }

        throw error;
      }
    },
  );
}
