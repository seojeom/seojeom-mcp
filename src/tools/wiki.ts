import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DesktopMcpContext } from "../context.js";
import { preview } from "./shared.js";

type WikiPage = {
  id: string;
  slug: string;
  title: string;
  canonicalPath?: string | null;
  noteClass?: string | null;
  primaryNodeRef?: string | null;
  bodyMarkdown: string;
  tags: string[];
  updatedAt?: string | null;
};

type WikiSearchEnvelope = {
  projectId: string;
  query: string;
  results: Array<{
    documentId: string;
    title: string;
    canonicalPath: string | null;
    primaryNodeRef: string | null;
    matchedField: string;
    matchedSnippet: string | null;
    score: number;
    updatedAt: string | null;
  }>;
};

type WikiSectionsEnvelope = {
  pageId: string;
  sections: Array<{
    sectionKey: string;
    heading: string;
    headingPath: string;
    plainText: string;
    markdown: string;
  }>;
};

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === null) {
    return null;
  }

  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(values: string[] | undefined) {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function buildApprovalDetails(lines: Array<string | null | undefined>) {
  return lines.map((entry) => entry?.trim() ?? "").filter((entry) => entry.length > 0);
}

function buildWikiWriteResultText(input: {
  mode: "create" | "update";
  page: WikiPage;
  approvalSource: string;
  rememberProject: boolean;
}) {
  return [
    `[wiki write] ${input.page.title}`,
    `- mode: ${input.mode}`,
    `- id: ${input.page.id}`,
    `- slug: ${input.page.slug}`,
    `- path: ${input.page.canonicalPath ?? "-"}`,
    `- node: ${input.page.primaryNodeRef ?? "-"}`,
    `- tags: ${input.page.tags.length > 0 ? input.page.tags.join(", ") : "-"}`,
    `- approval: ${input.approvalSource}${input.rememberProject ? " (remembered)" : ""}`,
  ].join("\n");
}

export function registerWikiTools(server: McpServer, context: DesktopMcpContext) {
  server.registerTool(
    "seojeom_list_wiki_pages",
    {
      title: "List Wiki Pages",
      description: "List wiki pages for the current project.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit }) => {
      const pages = context.localWikiStore
        ? await context.localWikiStore.listPages(limit ?? 50)
        : await context.apiBridge.getJson<WikiPage[]>(
            `/api/projects/${context.config.projectId}/wiki`,
          );
      const rows = pages.slice(0, limit ?? 50).map((page) => ({
        id: page.id,
        title: page.title,
        slug: page.slug,
        canonicalPath: page.canonicalPath ?? null,
        primaryNodeRef: page.primaryNodeRef ?? null,
        noteClass: page.noteClass ?? null,
        updatedAt: page.updatedAt ?? null,
      }));

      const lines = [`[wiki pages] ${rows.length}/${pages.length}개`];
      for (const row of rows) {
        lines.push(`- ${row.title} (${row.id})`);
        lines.push(
          `  slug=${row.slug} · path=${row.canonicalPath ?? "-"} · node=${row.primaryNodeRef ?? "-"}`,
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          rows,
          totalMatched: pages.length,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_read_wiki",
    {
      title: "Read Wiki Page",
      description: "Read a single wiki page and optionally its section index.",
      inputSchema: {
        pageId: z.string().min(1),
        includeSections: z.boolean().optional(),
      },
    },
    async ({ pageId, includeSections }) => {
      const page = context.localWikiStore
        ? await context.localWikiStore.readPage(pageId)
        : await context.apiBridge.getJson<WikiPage>(
            `/api/projects/${context.config.projectId}/wiki/${encodeURIComponent(pageId)}`,
          );
      const sections = includeSections
        ? context.localWikiStore
          ? await context.localWikiStore.readSections(pageId)
          : await context.apiBridge.getJson<WikiSectionsEnvelope>(
              `/api/projects/${context.config.projectId}/wiki/${encodeURIComponent(pageId)}/sections`,
            )
        : null;

      const lines = [
        `[wiki] ${page.title}`,
        `- id: ${page.id}`,
        `- slug: ${page.slug}`,
        `- path: ${page.canonicalPath ?? "-"}`,
        `- node: ${page.primaryNodeRef ?? "-"}`,
        `- tags: ${page.tags.length > 0 ? page.tags.join(", ") : "-"}`,
        "",
        page.bodyMarkdown,
      ];

      if (sections) {
        lines.push("");
        lines.push(`[sections] ${sections.sections.length}개`);
        for (const section of sections.sections.slice(0, 20)) {
          lines.push(`- ${section.headingPath} (${section.sectionKey})`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          page,
          sections: sections?.sections ?? null,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_write_wiki",
    {
      title: "Write Wiki Page",
      description:
        "Create or update a wiki page for the current project. Mutations always pass through the launcher approval queue.",
      inputSchema: {
        mode: z.enum(["create", "update"]),
        pageId: z.string().optional(),
        title: z.string().optional(),
        bodyMarkdown: z.string().optional(),
        category: z.string().nullable().optional(),
        noteClass: z.string().nullable().optional(),
        nodeType: z.string().nullable().optional(),
        slug: z.string().optional(),
        tags: z.array(z.string()).optional(),
        canonicalPath: z.string().nullable().optional(),
        primaryNodeRef: z.string().nullable().optional(),
        canonLevel: z.string().nullable().optional(),
        isStructured: z.boolean().optional(),
        rootKind: z.enum(["raw", "wiki", "schema"]).nullable().optional(),
        linkedEpisodeIds: z.array(z.string()).optional(),
        linkedCharacterIds: z.array(z.string()).optional(),
        graphEdges: z.unknown().optional(),
        timeline: z.unknown().optional(),
        baseVersion: z.number().int().optional(),
        sourceProposalSetId: z.string().nullable().optional(),
        snapshotSource: z.string().optional(),
      },
    },
    async ({
      mode,
      pageId,
      title,
      bodyMarkdown,
      category,
      noteClass,
      nodeType,
      slug,
      tags,
      canonicalPath,
      primaryNodeRef,
      canonLevel,
      isStructured,
      rootKind,
      linkedEpisodeIds,
      linkedCharacterIds,
      graphEdges,
      timeline,
      baseVersion,
      sourceProposalSetId,
      snapshotSource,
    }) => {
      const normalizedTitle = normalizeOptionalString(title);
      const normalizedPageId = normalizeOptionalString(pageId);
      const normalizedCategory = normalizeNullableString(category);
      const normalizedNoteClass = normalizeNullableString(noteClass);
      const normalizedNodeType = normalizeNullableString(nodeType);
      const normalizedSlug = normalizeOptionalString(slug);
      const normalizedCanonicalPath = normalizeNullableString(canonicalPath);
      const normalizedPrimaryNodeRef = normalizeNullableString(primaryNodeRef);
      const normalizedCanonLevel = normalizeNullableString(canonLevel);
      const normalizedTags = normalizeStringArray(tags);
      const normalizedLinkedEpisodeIds = normalizeStringArray(linkedEpisodeIds);
      const normalizedLinkedCharacterIds = normalizeStringArray(linkedCharacterIds);
      const normalizedSourceProposalSetId = normalizeNullableString(sourceProposalSetId);
      const normalizedSnapshotSource = normalizeOptionalString(snapshotSource);

      if (mode === "create") {
        if (!normalizedTitle) {
          throw new Error("title is required for wiki create");
        }
        if (normalizedCategory == null && normalizedNoteClass == null) {
          throw new Error("category or noteClass is required for wiki create");
        }
      }

      if (mode === "update") {
        if (!normalizedPageId) {
          throw new Error("pageId is required for wiki update");
        }
        if (typeof bodyMarkdown !== "string") {
          throw new Error("bodyMarkdown is required for wiki update");
        }
      }

      const approval = await context.approval.requestApproval({
        action: "wiki_write",
        toolName: "seojeom_write_wiki",
        title: mode === "create" ? normalizedTitle ?? "new wiki page" : normalizedPageId ?? "wiki page",
        summary:
          mode === "create"
            ? normalizedCategory ?? normalizedNoteClass ?? "create wiki page"
            : normalizedTitle ?? "update wiki page",
        details: buildApprovalDetails([
          `mode=${mode}`,
          normalizedSlug ? `slug=${normalizedSlug}` : null,
          normalizedCategory != null ? `category=${normalizedCategory}` : null,
          normalizedNoteClass != null ? `noteClass=${normalizedNoteClass}` : null,
        ]),
      });

      if (!approval.approved) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[wiki write approval] ${mode === "create" ? normalizedTitle ?? "new wiki page" : normalizedPageId ?? "wiki page"}`,
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

      const payload: Record<string, unknown> = {};

      if (normalizedTitle !== undefined) {
        payload.title = normalizedTitle;
      }
      if (typeof bodyMarkdown === "string") {
        payload.bodyMarkdown = bodyMarkdown;
      } else if (mode === "create") {
        payload.bodyMarkdown = "";
      }
      if (normalizedCategory !== undefined) {
        payload.category = normalizedCategory;
      }
      if (normalizedNoteClass !== undefined) {
        payload.noteClass = normalizedNoteClass;
      }
      if (normalizedNodeType !== undefined) {
        payload.nodeType = normalizedNodeType;
      }
      if (normalizedSlug !== undefined) {
        payload.slug = normalizedSlug;
      }
      if (tags !== undefined) {
        payload.tags = normalizedTags;
      }
      if (normalizedCanonicalPath !== undefined) {
        payload.canonicalPath = normalizedCanonicalPath;
      }
      if (normalizedPrimaryNodeRef !== undefined) {
        payload.primaryNodeRef = normalizedPrimaryNodeRef;
      }
      if (normalizedCanonLevel !== undefined) {
        payload.canonLevel = normalizedCanonLevel;
      }
      if (typeof isStructured === "boolean") {
        payload.isStructured = isStructured;
      }
      if (rootKind !== undefined) {
        payload.rootKind = rootKind;
      }
      if (linkedEpisodeIds !== undefined) {
        payload.linkedEpisodeIds = normalizedLinkedEpisodeIds;
      }
      if (linkedCharacterIds !== undefined) {
        payload.linkedCharacterIds = normalizedLinkedCharacterIds;
      }
      if (graphEdges !== undefined) {
        payload.graphEdges = graphEdges;
      }
      if (timeline !== undefined) {
        payload.timeline = timeline;
      }
      if (typeof baseVersion === "number") {
        payload.baseVersion = baseVersion;
      }
      if (normalizedSourceProposalSetId !== undefined) {
        payload.sourceProposalSetId = normalizedSourceProposalSetId;
      }
      if (normalizedSnapshotSource !== undefined) {
        payload.snapshotSource = normalizedSnapshotSource;
      }

      const page = context.localWikiStore
        ? await context.localWikiStore.writePage({
            mode,
            pageId: normalizedPageId,
            title: normalizedTitle,
            bodyMarkdown:
              typeof bodyMarkdown === "string"
                ? bodyMarkdown
                : mode === "create"
                  ? ""
                  : undefined,
            category: normalizedCategory,
            noteClass: normalizedNoteClass,
            nodeType: normalizedNodeType,
            slug: normalizedSlug,
            tags: normalizedTags,
            canonicalPath: normalizedCanonicalPath,
            primaryNodeRef: normalizedPrimaryNodeRef,
            canonLevel: normalizedCanonLevel,
            isStructured,
            rootKind: rootKind ?? undefined,
            linkedEpisodeIds: normalizedLinkedEpisodeIds,
            linkedCharacterIds: normalizedLinkedCharacterIds,
            graphEdges,
            timeline,
            baseVersion,
            sourceProposalSetId: normalizedSourceProposalSetId,
            snapshotSource:
              normalizedSnapshotSource ?? undefined,
          })
        : mode === "create"
          ? await context.apiBridge.postJson<WikiPage>(
              `/api/projects/${context.config.projectId}/wiki`,
              payload,
            )
          : await context.apiBridge.putJson<WikiPage>(
              `/api/projects/${context.config.projectId}/wiki/${encodeURIComponent(normalizedPageId ?? "")}`,
              payload,
            );

      return {
        content: [
          {
            type: "text" as const,
            text: buildWikiWriteResultText({
              mode,
              page,
              approvalSource: approval.source,
              rememberProject: approval.rememberProject,
            }),
          },
        ],
        structuredContent: {
          page,
          mode,
          approval,
        },
      };
    },
  );

  server.registerTool(
    "seojeom_search_wiki_pages",
    {
      title: "Search Wiki Pages",
      description: "Search wiki pages by title, path, tags, or section text.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, limit }) => {
      const envelope = context.localWikiStore
        ? await context.localWikiStore.searchPages(query, limit ?? 20)
        : await context.apiBridge.getJson<WikiSearchEnvelope>(
            `/api/projects/${context.config.projectId}/wiki/search?q=${encodeURIComponent(query)}&limit=${String(limit ?? 20)}`,
          );

      const lines = [`[wiki search] "${envelope.query}" · ${envelope.results.length}개`];
      for (const row of envelope.results) {
        lines.push(`- ${row.title} (${row.documentId})`);
        lines.push(
          `  field=${row.matchedField} · score=${row.score} · path=${row.canonicalPath ?? "-"}`,
        );
        const snippet = preview(row.matchedSnippet, 180);
        if (snippet) {
          lines.push(`  ${snippet}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: envelope,
      };
    },
  );
}
