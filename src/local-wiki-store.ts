import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type LocalWikiPage = {
  id: string;
  slug: string;
  title: string;
  rootKind?: "raw" | "wiki" | "schema";
  canonicalPath?: string | null;
  noteClass?: string | null;
  primaryNodeRef?: string | null;
  canonLevel?: string | null;
  isStructured?: boolean;
  category:
    | "world"
    | "rule"
    | "location"
    | "organization"
    | "faction"
    | "item"
    | "custom";
  nodeType?: string | null;
  bodyMarkdown: string;
  tags: string[];
  linkedEpisodeIds: string[];
  linkedCharacterIds: string[];
  updatedAt: string | null;
};

export type LocalWikiSearchEnvelope = {
  projectId: string;
  query: string;
  results: Array<{
    documentId: string;
    title: string;
    canonicalPath: string | null;
    primaryNodeRef: string | null;
    matchedField:
      | "title"
      | "canonical_path"
      | "tag"
      | "section_heading"
      | "section_body"
      | "body";
    matchedSnippet: string | null;
    score: number;
    updatedAt: string | null;
  }>;
};

export type LocalWikiSectionsEnvelope = {
  pageId: string;
  sections: Array<{
    sectionKey: string;
    heading: string;
    headingPath: string;
    plainText: string;
    markdown: string;
  }>;
};

type ParsedWikiFile = {
  page: LocalWikiPage;
  sections: LocalWikiSectionsEnvelope["sections"];
};

type LocalWikiWriteInput = {
  mode: "create" | "update";
  pageId?: string | null;
  title?: string | null;
  bodyMarkdown?: string;
  category?: string | null;
  noteClass?: string | null;
  nodeType?: string | null;
  slug?: string | null;
  tags?: string[];
  canonicalPath?: string | null;
  primaryNodeRef?: string | null;
  canonLevel?: string | null;
  isStructured?: boolean;
  rootKind?: "raw" | "wiki" | "schema" | null;
  linkedEpisodeIds?: string[];
  linkedCharacterIds?: string[];
  graphEdges?: unknown;
  timeline?: unknown;
  baseVersion?: number;
  sourceProposalSetId?: string | null;
  snapshotSource?: string | null;
};

const FRONTMATTER_BOUNDARY = "---";

function toCamelCaseKey(value: string) {
  return value.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function toSnakeCaseKey(value: string) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function normalizePathSeparators(value: string) {
  return value.replace(/\\/g, "/");
}

function slugifyTitle(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

function basenameWithoutExtension(value: string) {
  return value.replace(/\.[^.]+$/u, "");
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "null") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_BOUNDARY}\n`)) {
    return {
      data: {} as Record<string, unknown>,
      bodyMarkdown: normalized,
    };
  }

  const endBoundary = normalized.indexOf(
    `\n${FRONTMATTER_BOUNDARY}\n`,
    FRONTMATTER_BOUNDARY.length + 1,
  );
  if (endBoundary < 0) {
    return {
      data: {} as Record<string, unknown>,
      bodyMarkdown: normalized,
    };
  }

  const rawFrontmatter = normalized.slice(
    FRONTMATTER_BOUNDARY.length + 1,
    endBoundary,
  );
  const bodyMarkdown = normalized.slice(
    endBoundary + `\n${FRONTMATTER_BOUNDARY}\n`.length,
  );
  const data: Record<string, unknown> = {};
  let activeListKey: string | null = null;

  for (const line of rawFrontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const listMatch = trimmed.match(/^-\s+(.*)$/);
    if (listMatch) {
      if (!activeListKey) {
        continue;
      }
      const nextValue = parseScalar(listMatch[1]);
      const current = data[activeListKey];
      if (Array.isArray(current)) {
        current.push(nextValue);
      } else {
        data[activeListKey] = [nextValue];
      }
      continue;
    }

    const fieldMatch = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (!fieldMatch) {
      activeListKey = null;
      continue;
    }

    const key = toCamelCaseKey(fieldMatch[1]);
    const rawValue = fieldMatch[2] ?? "";
    if (!rawValue.trim()) {
      data[key] = [];
      activeListKey = key;
      continue;
    }

    data[key] = parseScalar(rawValue);
    activeListKey = null;
  }

  return {
    data,
    bodyMarkdown,
  };
}

function serializeFrontmatterValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => `  - ${JSON.stringify(entry).replace(/\n/g, " ")}`)
      .join("\n");
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return JSON.stringify(String(value).replace(/\n/g, " "));
}

function renderMarkdownWithFrontmatter(
  frontmatter: Record<string, unknown>,
  bodyMarkdown: string,
) {
  const normalizedFrontmatter = Object.fromEntries(
    Object.entries(frontmatter).map(([key, value]) => [toSnakeCaseKey(key), value]),
  );
  const lines = Object.entries(normalizedFrontmatter)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return [`${key}:`];
        }
        return [`${key}:`, serializeFrontmatterValue(value)];
      }
      return [`${key}: ${serializeFrontmatterValue(value)}`];
    });

  const body = bodyMarkdown.trim();
  if (lines.length === 0) {
    return body;
  }

  return `${FRONTMATTER_BOUNDARY}\n${lines.join("\n")}\n${FRONTMATTER_BOUNDARY}\n\n${body}`.trim();
}

function markdownToPlainText(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSections(markdown: string): LocalWikiSectionsEnvelope["sections"] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: LocalWikiSectionsEnvelope["sections"] = [];
  const headingStack: string[] = [];
  let current:
    | {
        heading: string;
        sectionKey: string;
        headingPath: string;
        lines: string[];
      }
    | null = null;

  function flushCurrent() {
    if (!current) {
      return;
    }
    const sectionMarkdown = current.lines.join("\n").trim();
    sections.push({
      sectionKey: current.sectionKey,
      heading: current.heading,
      headingPath: current.headingPath,
      markdown: sectionMarkdown,
      plainText: markdownToPlainText(sectionMarkdown),
    });
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!headingMatch) {
      if (current) {
        current.lines.push(line);
      }
      continue;
    }

    flushCurrent();

    const depth = headingMatch[1].length;
    const heading = headingMatch[2].trim();
    headingStack.length = depth - 1;
    headingStack.push(heading);
    current = {
      heading,
      sectionKey: headingStack.map(slugifyTitle).join("."),
      headingPath: headingStack.join(" > "),
      lines: [],
    };
  }

  flushCurrent();
  return sections;
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function inferCategory(noteClass: string | null | undefined) {
  switch (noteClass) {
    case "world_rule":
      return "rule";
    case "location":
      return "location";
    case "organization":
      return "organization";
    case "item":
      return "item";
    case "world_system":
      return "world";
    default:
      return "custom";
  }
}

function inferNodeType(noteClass: string | null | undefined) {
  switch (noteClass) {
    case "world_rule":
    case "world_system":
    case "location":
    case "organization":
    case "item":
      return noteClass;
    default:
      return null;
  }
}

function inferCanonLevel(noteClass: string | null | undefined) {
  return noteClass === "project_brief" ? "project" : "structured";
}

function inferCanonicalPath(input: {
  noteClass?: string | null;
  category?: string | null;
  title: string;
  slug?: string | null;
  rootKind?: "raw" | "wiki" | "schema" | null;
}) {
  const slug = input.slug?.trim() || slugifyTitle(input.title);
  const rootKind = input.rootKind ?? "wiki";
  if (rootKind === "raw") {
    return `raw/${input.noteClass ?? input.category ?? "custom"}/${slug}.md`;
  }
  if (rootKind === "schema") {
    return `schema/${slug}.md`;
  }

  switch (input.noteClass) {
    case "project_brief":
      return "wiki/00_meta/project-brief.md";
    case "part_outline":
      return `wiki/25_story/parts/${slug}.md`;
    case "character_sheet":
      return `wiki/10_characters/${slug}.md`;
    case "world_rule":
    case "world_system":
    case "location":
    case "organization":
    case "item":
      return `wiki/20_world/${input.noteClass}/${slug}.md`;
    case "arc_outline":
      return `wiki/30_story/arcs/${slug}.md`;
    case "chapter_outline":
      return `wiki/35_story/chapters/${slug}.md`;
    case "episode_outline":
      return `wiki/40_episodes/${slug}.md`;
    case "scene_outline":
      return `wiki/42_scenes/${slug}.md`;
    case "beat_outline":
      return `wiki/43_beats/${slug}.md`;
    case "timeline_note":
      return `wiki/50_timelines/${slug}.md`;
    case "review_note":
      return `wiki/80_reviews/${slug}.md`;
    default:
      return `wiki/${input.category ?? "custom"}/${slug}.md`;
  }
}

function normalizeRelativeProjectPath(value: string) {
  const normalized = normalizePathSeparators(value).replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`invalid wiki path: ${value}`);
  }
  return parts.join("/");
}

export class LocalFilesystemWikiStore {
  private readonly projectId: string;
  private readonly projectRoot: string;

  constructor(input: { projectId: string; projectRoot: string }) {
    this.projectId = input.projectId;
    this.projectRoot = input.projectRoot;
  }

  async listPages(limit?: number): Promise<LocalWikiPage[]> {
    const pages = await this.readAllPages();
    pages.sort((left: ParsedWikiFile, right: ParsedWikiFile) =>
      (right.page.updatedAt ?? "").localeCompare(left.page.updatedAt ?? ""),
    );
    return (limit ? pages.slice(0, limit) : pages).map((entry) => entry.page);
  }

  async readPage(pageId: string): Promise<LocalWikiPage> {
    const parsed = await this.readPageRecord(pageId);
    if (!parsed) {
      throw new Error(`wiki page not found: ${pageId}`);
    }
    return parsed.page;
  }

  async readSections(pageId: string): Promise<LocalWikiSectionsEnvelope> {
    const parsed = await this.readPageRecord(pageId);
    if (!parsed) {
      throw new Error(`wiki page not found: ${pageId}`);
    }
    return {
      pageId: parsed.page.id,
      sections: parsed.sections,
    } satisfies LocalWikiSectionsEnvelope;
  }

  async searchPages(query: string, limit = 20): Promise<LocalWikiSearchEnvelope> {
    const normalizedQuery = query.trim().toLowerCase();
    const pages = await this.readAllPages();
    const results: LocalWikiSearchEnvelope["results"] = [];

    for (const entry of pages) {
      const page = entry.page;
      const title = page.title.toLowerCase();
      const canonicalPath = (page.canonicalPath ?? page.id).toLowerCase();
      const body = page.bodyMarkdown.toLowerCase();
      const matchingTag = page.tags.find((tag) =>
        tag.toLowerCase().includes(normalizedQuery),
      );
      const matchingSectionHeading = entry.sections.find((section) =>
        section.heading.toLowerCase().includes(normalizedQuery),
      );
      const matchingSectionBody = entry.sections.find((section) =>
        section.plainText.toLowerCase().includes(normalizedQuery),
      );

      if (title.includes(normalizedQuery)) {
        results.push({
          documentId: page.id,
          title: page.title,
          canonicalPath: page.canonicalPath ?? null,
          primaryNodeRef: page.primaryNodeRef ?? null,
          matchedField: "title",
          matchedSnippet: page.title,
          score: 100,
          updatedAt: page.updatedAt,
        });
        continue;
      }

      if (canonicalPath.includes(normalizedQuery)) {
        results.push({
          documentId: page.id,
          title: page.title,
          canonicalPath: page.canonicalPath ?? null,
          primaryNodeRef: page.primaryNodeRef ?? null,
          matchedField: "canonical_path",
          matchedSnippet: page.canonicalPath ?? page.id,
          score: 90,
          updatedAt: page.updatedAt,
        });
        continue;
      }

      if (matchingTag) {
        results.push({
          documentId: page.id,
          title: page.title,
          canonicalPath: page.canonicalPath ?? null,
          primaryNodeRef: page.primaryNodeRef ?? null,
          matchedField: "tag",
          matchedSnippet: matchingTag,
          score: 80,
          updatedAt: page.updatedAt,
        });
        continue;
      }

      if (matchingSectionHeading) {
        results.push({
          documentId: page.id,
          title: page.title,
          canonicalPath: page.canonicalPath ?? null,
          primaryNodeRef: page.primaryNodeRef ?? null,
          matchedField: "section_heading",
          matchedSnippet: matchingSectionHeading.headingPath,
          score: 75,
          updatedAt: page.updatedAt,
        });
        continue;
      }

      if (matchingSectionBody) {
        results.push({
          documentId: page.id,
          title: page.title,
          canonicalPath: page.canonicalPath ?? null,
          primaryNodeRef: page.primaryNodeRef ?? null,
          matchedField: "section_body",
          matchedSnippet: matchingSectionBody.plainText.slice(0, 180),
          score: 70,
          updatedAt: page.updatedAt,
        });
        continue;
      }

      if (body.includes(normalizedQuery)) {
        const plain = markdownToPlainText(page.bodyMarkdown);
        const index = plain.toLowerCase().indexOf(normalizedQuery);
        const snippet =
          index >= 0
            ? plain.slice(Math.max(0, index - 40), index + 140).trim()
            : plain.slice(0, 180);
        results.push({
          documentId: page.id,
          title: page.title,
          canonicalPath: page.canonicalPath ?? null,
          primaryNodeRef: page.primaryNodeRef ?? null,
          matchedField: "body",
          matchedSnippet: snippet,
          score: 60,
          updatedAt: page.updatedAt,
        });
      }
    }

    results.sort(
      (
        left: LocalWikiSearchEnvelope["results"][number],
        right: LocalWikiSearchEnvelope["results"][number],
      ) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
      },
    );

    return {
      projectId: this.projectId,
      query,
      results: results.slice(0, limit),
    };
  }

  async writePage(input: LocalWikiWriteInput): Promise<LocalWikiPage> {
    if (input.mode === "create") {
      if (!input.title?.trim()) {
        throw new Error("title is required for wiki create");
      }

      const relativePath = normalizeRelativeProjectPath(
        input.canonicalPath?.trim() ||
          inferCanonicalPath({
            noteClass: input.noteClass,
            category: input.category,
            title: input.title,
            slug: input.slug,
            rootKind: input.rootKind,
          }),
      );
      const absolutePath = this.resolveAbsolutePath(relativePath);

      await mkdir(path.dirname(absolutePath), { recursive: true });

      const frontmatter: Record<string, unknown> = {
        title: input.title.trim(),
        slug: input.slug?.trim() || basenameWithoutExtension(path.basename(relativePath)),
        rootKind: input.rootKind ?? "wiki",
        noteClass: input.noteClass ?? undefined,
        canonicalPath: relativePath,
        canonLevel:
          input.canonLevel ??
          inferCanonLevel(input.noteClass ?? undefined),
        isStructured: input.isStructured ?? Boolean(input.noteClass),
        category:
          input.category ??
          inferCategory(input.noteClass ?? undefined),
        nodeType:
          input.nodeType ??
          inferNodeType(input.noteClass ?? undefined),
        tags: input.tags ?? [],
        linkedEpisodeIds: input.linkedEpisodeIds ?? [],
        linkedCharacterIds: input.linkedCharacterIds ?? [],
        primaryNodeRef: input.primaryNodeRef ?? undefined,
        graphEdges: input.graphEdges ?? undefined,
        timeline: input.timeline ?? undefined,
        sourceProposalSetId: input.sourceProposalSetId ?? undefined,
        snapshotSource: input.snapshotSource ?? undefined,
      };

      const markdown = renderMarkdownWithFrontmatter(
        frontmatter,
        input.bodyMarkdown?.trim() || `# ${input.title.trim()}\n`,
      );
      await writeFile(absolutePath, markdown, "utf8");
      return this.readPage(relativePath);
    }

    if (!input.pageId?.trim()) {
      throw new Error("pageId is required for wiki update");
    }
    if (typeof input.bodyMarkdown !== "string") {
      throw new Error("bodyMarkdown is required for wiki update");
    }

    const current = await this.readPageRecord(input.pageId);
    if (!current) {
      throw new Error(`wiki page not found: ${input.pageId}`);
    }

    const nextRelativePath = normalizeRelativeProjectPath(
      input.canonicalPath?.trim() || current.page.canonicalPath || current.page.id,
    );
    const nextFrontmatter = {
      ...parseFrontmatter(
        renderMarkdownWithFrontmatter(
          {
            title: current.page.title,
            rootKind: current.page.rootKind ?? "wiki",
            noteClass: current.page.noteClass ?? undefined,
            canonicalPath: current.page.canonicalPath ?? current.page.id,
            canonLevel: current.page.canonLevel ?? undefined,
            isStructured: current.page.isStructured ?? false,
            category: current.page.category,
            nodeType: current.page.nodeType ?? undefined,
            tags: current.page.tags,
            linkedEpisodeIds: current.page.linkedEpisodeIds,
            linkedCharacterIds: current.page.linkedCharacterIds,
            primaryNodeRef: current.page.primaryNodeRef ?? undefined,
          },
          current.page.bodyMarkdown,
        ),
      ).data,
      title: input.title?.trim() || current.page.title,
      slug:
        input.slug?.trim() ||
        current.page.slug ||
        basenameWithoutExtension(path.basename(nextRelativePath)),
      rootKind: input.rootKind ?? current.page.rootKind ?? "wiki",
      noteClass:
        input.noteClass !== undefined ? input.noteClass : current.page.noteClass,
      canonicalPath: nextRelativePath,
      canonLevel:
        input.canonLevel !== undefined
          ? input.canonLevel
          : current.page.canonLevel,
      isStructured:
        input.isStructured !== undefined
          ? input.isStructured
          : current.page.isStructured,
      category:
        input.category !== undefined
          ? input.category
          : current.page.category,
      nodeType:
        input.nodeType !== undefined
          ? input.nodeType
          : current.page.nodeType,
      tags: input.tags ?? current.page.tags,
      linkedEpisodeIds:
        input.linkedEpisodeIds ?? current.page.linkedEpisodeIds,
      linkedCharacterIds:
        input.linkedCharacterIds ?? current.page.linkedCharacterIds,
      primaryNodeRef:
        input.primaryNodeRef !== undefined
          ? input.primaryNodeRef
          : current.page.primaryNodeRef,
      graphEdges: input.graphEdges ?? undefined,
      timeline: input.timeline ?? undefined,
      sourceProposalSetId: input.sourceProposalSetId ?? undefined,
      snapshotSource: input.snapshotSource ?? undefined,
      baseVersion:
        typeof input.baseVersion === "number" ? input.baseVersion : undefined,
    } satisfies Record<string, unknown>;

    const nextMarkdown = renderMarkdownWithFrontmatter(
      nextFrontmatter,
      input.bodyMarkdown,
    );
    const currentAbsolutePath = this.resolveAbsolutePath(current.page.id);
    const nextAbsolutePath = this.resolveAbsolutePath(nextRelativePath);
    await mkdir(path.dirname(nextAbsolutePath), { recursive: true });
    await writeFile(currentAbsolutePath, nextMarkdown, "utf8");
    if (currentAbsolutePath !== nextAbsolutePath) {
      await rename(currentAbsolutePath, nextAbsolutePath);
    }
    return this.readPage(nextRelativePath);
  }

  private async readAllPages(): Promise<ParsedWikiFile[]> {
    const wikiRoot = path.join(this.projectRoot, "wiki");
    const files = await this.walkMarkdownFiles(wikiRoot);
    const parsed: Array<ParsedWikiFile | null> = await Promise.all(
      files.map((absolutePath) => this.readPageFromAbsolutePath(absolutePath)),
    );
    return parsed.filter((entry): entry is ParsedWikiFile => entry !== null);
  }

  private async readPageRecord(pageId: string): Promise<ParsedWikiFile | null> {
    const normalizedId = normalizeRelativeProjectPath(pageId);
    const directPath = this.resolveAbsolutePath(normalizedId);
    const direct = await this.readPageFromAbsolutePath(directPath);
    if (direct) {
      return direct;
    }

    const pages = await this.readAllPages();
    return (
      pages.find(
        (entry) =>
          entry.page.id === normalizedId ||
          entry.page.canonicalPath === normalizedId ||
          entry.page.slug === normalizedId,
      ) ?? null
    );
  }

  private async walkMarkdownFiles(root: string): Promise<string[]> {
    const rootStats = await stat(root).catch(() => null);
    if (!rootStats?.isDirectory()) {
      return [];
    }

    const entries = await readdir(root, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walkMarkdownFiles(absolutePath)));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(absolutePath);
      }
    }

    return results;
  }

  private async readPageFromAbsolutePath(
    absolutePath: string,
  ): Promise<ParsedWikiFile | null> {
    const fileStats = await stat(absolutePath).catch(() => null);
    if (!fileStats?.isFile()) {
      return null;
    }

    const raw = await readFile(absolutePath, "utf8");
    const parsed = parseFrontmatter(raw);
    const relativePath = normalizePathSeparators(
      path.relative(this.projectRoot, absolutePath),
    );
    const title =
      (typeof parsed.data.title === "string" && parsed.data.title.trim()) ||
      basenameWithoutExtension(path.basename(relativePath)).replace(/[-_]+/g, " ");
    const noteClass =
      typeof parsed.data.noteClass === "string" ? parsed.data.noteClass : null;
    const category =
      typeof parsed.data.category === "string"
        ? (parsed.data.category as LocalWikiPage["category"])
        : inferCategory(noteClass);
    const sections = buildSections(parsed.bodyMarkdown);

    return {
      page: {
        id: relativePath,
        slug:
          (typeof parsed.data.slug === "string" && parsed.data.slug.trim()) ||
          basenameWithoutExtension(path.basename(relativePath)),
        title,
        rootKind:
          parsed.data.rootKind === "raw" ||
          parsed.data.rootKind === "wiki" ||
          parsed.data.rootKind === "schema"
            ? parsed.data.rootKind
            : "wiki",
        canonicalPath:
          typeof parsed.data.canonicalPath === "string"
            ? parsed.data.canonicalPath
            : relativePath,
        noteClass,
        primaryNodeRef:
          typeof parsed.data.primaryNodeRef === "string"
            ? parsed.data.primaryNodeRef
            : null,
        canonLevel:
          typeof parsed.data.canonLevel === "string"
            ? parsed.data.canonLevel
            : inferCanonLevel(noteClass),
        isStructured:
          typeof parsed.data.isStructured === "boolean"
            ? parsed.data.isStructured
            : Boolean(noteClass),
        category,
        nodeType:
          typeof parsed.data.nodeType === "string"
            ? parsed.data.nodeType
            : inferNodeType(noteClass),
        bodyMarkdown: parsed.bodyMarkdown.trim(),
        tags: toStringArray(parsed.data.tags),
        linkedEpisodeIds: toStringArray(parsed.data.linkedEpisodeIds),
        linkedCharacterIds: toStringArray(parsed.data.linkedCharacterIds),
        updatedAt: new Date(fileStats.mtimeMs).toISOString(),
      } satisfies LocalWikiPage,
      sections,
    } satisfies ParsedWikiFile;
  }

  private resolveAbsolutePath(relativePath: string) {
    const resolved = path.resolve(this.projectRoot, relativePath);
    const normalizedProjectRoot = `${path.resolve(this.projectRoot)}${path.sep}`;
    if (
      resolved !== path.resolve(this.projectRoot) &&
      !resolved.startsWith(normalizedProjectRoot)
    ) {
      throw new Error(`wiki path escaped project root: ${relativePath}`);
    }
    return resolved;
  }
}
