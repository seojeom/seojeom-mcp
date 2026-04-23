import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type LocalGraphSceneStoreFile = {
  schemaVersion: 1;
  scenes: LocalGraphSceneRecord[];
};

export type LocalGraphSceneObjectRecord = {
  id: string;
  sceneId: string;
  objectKind: "canonical_node" | "proposal_node" | "ghost_node" | "note_anchor";
  canonicalRef: string | null;
  proposalItemId: string | null;
  extractionRunId: string | null;
  tempKey: string | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  pinned: boolean;
  collapsed: boolean;
  zIndex: number;
  styleJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalGraphSceneLinkRecord = {
  id: string;
  sceneId: string;
  sourceObjectId: string;
  targetObjectId: string;
  sourceCanonicalRef: string | null;
  targetCanonicalRef: string | null;
  canonicalEdgeRef: string | null;
  proposalItemId: string | null;
  tempKey: string | null;
  hidden: boolean;
  labelVisible: boolean;
  waypointsJson: unknown[] | null;
  styleJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalGraphSceneViewportRecord = {
  sceneId: string;
  x: number;
  y: number;
  zoom: number;
  selectedObjectIds: string[];
  selectedSelectionToken: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalGraphSceneRecord = {
  id: string;
  projectId: string;
  createdBy: string;
  name: string;
  isDefault: boolean;
  visibility: "private";
  version: number;
  lastSeenSemanticVersionToken: string | null;
  createdAt: string;
  updatedAt: string;
  objects: LocalGraphSceneObjectRecord[];
  links: LocalGraphSceneLinkRecord[];
  viewport: LocalGraphSceneViewportRecord;
};

export type LocalGraphSceneSummaryRecord = {
  id: string;
  projectId: string;
  createdBy: string;
  name: string;
  isDefault: boolean;
  visibility: "private";
  version: number;
  lastSeenSemanticVersionToken: string | null;
  objectCount: number;
  linkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LocalGraphSceneCreateInput = {
  name?: string;
};

export type LocalGraphSceneObjectInput = {
  id?: string;
  objectKind: LocalGraphSceneObjectRecord["objectKind"];
  canonicalRef?: string | null;
  proposalItemId?: string | null;
  extractionRunId?: string | null;
  tempKey?: string | null;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  pinned?: boolean;
  collapsed?: boolean;
  zIndex?: number;
  styleJson?: Record<string, unknown> | null;
};

export type LocalGraphSceneLinkInput = {
  id?: string;
  tempKey?: string | null;
  sourceCanonicalRef?: string | null;
  targetCanonicalRef?: string | null;
  sourceTempKey?: string | null;
  targetTempKey?: string | null;
  canonicalEdgeRef?: string | null;
  proposalItemId?: string | null;
  hidden?: boolean;
  labelVisible?: boolean;
  waypointsJson?: unknown[] | null;
  styleJson?: Record<string, unknown> | null;
};

export type LocalGraphSceneViewportInput = {
  x?: number;
  y?: number;
  zoom?: number;
  selectedObjectIds?: string[];
  selectedSelectionToken?: string | null;
};

export type LocalGraphSceneSaveInput = {
  requestId?: string;
  baseVersion?: number;
  lastSeenSemanticVersionToken?: string | null;
  objects: LocalGraphSceneObjectInput[];
  links: LocalGraphSceneLinkInput[];
  viewport?: LocalGraphSceneViewportInput;
};

type LocalGraphProposalQueueFile = {
  proposalSets: Array<{
    items: Array<{
      id: string;
      opKind: string;
      status: string;
      targetRef: string | null;
    }>;
  }>;
};

const DEFAULT_SCENE_NAME = "기본 편집 씬";
const NAMED_SCENE_FALLBACK = "새 편집 씬";
const LOCAL_CREATED_BY = "desktop-mcp-local";
const DEFAULT_SCENE_STORE_CANDIDATES = [
  ".seojeom/graph/scenes.json",
  ".seojeom/graph/scenes.json",
] as const;
const DEFAULT_PROPOSAL_QUEUE_CANDIDATES = [
  ".seojeom/graph/proposal-sets.json",
  ".seojeom/graph/proposal-sets.json",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asNumberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asUnknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function trimString(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueId(prefix: string) {
  return `${prefix}:${randomUUID()}`;
}

function buildSceneStorePathCandidates(projectRoot: string) {
  return DEFAULT_SCENE_STORE_CANDIDATES.map((candidate) =>
    path.resolve(projectRoot, candidate),
  );
}

function buildProposalQueuePathCandidates(projectRoot: string) {
  return DEFAULT_PROPOSAL_QUEUE_CANDIDATES.map((candidate) =>
    path.resolve(projectRoot, candidate),
  );
}

function emptySceneStoreFile(): LocalGraphSceneStoreFile {
  return {
    schemaVersion: 1,
    scenes: [],
  };
}

function parseSceneObject(value: unknown): LocalGraphSceneObjectRecord | null {
  const record = asRecord(value);
  const id = asString(record.id);
  const sceneId = asString(record.sceneId);
  const objectKind = asString(record.objectKind);
  if (
    !id ||
    !sceneId ||
    (objectKind !== "canonical_node" &&
      objectKind !== "proposal_node" &&
      objectKind !== "ghost_node" &&
      objectKind !== "note_anchor")
  ) {
    return null;
  }

  return {
    id,
    sceneId,
    objectKind,
    canonicalRef: asString(record.canonicalRef),
    proposalItemId: asString(record.proposalItemId),
    extractionRunId: asString(record.extractionRunId),
    tempKey: asString(record.tempKey),
    x: asNumberOrNull(record.x) ?? 0,
    y: asNumberOrNull(record.y) ?? 0,
    width: asNumberOrNull(record.width),
    height: asNumberOrNull(record.height),
    pinned: asBoolean(record.pinned, false),
    collapsed: asBoolean(record.collapsed, false),
    zIndex: asNumberOrNull(record.zIndex) ?? 0,
    styleJson: asObjectRecord(record.styleJson),
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
  };
}

function parseSceneLink(value: unknown): LocalGraphSceneLinkRecord | null {
  const record = asRecord(value);
  const id = asString(record.id);
  const sceneId = asString(record.sceneId);
  const sourceObjectId = asString(record.sourceObjectId);
  const targetObjectId = asString(record.targetObjectId);
  if (!id || !sceneId || !sourceObjectId || !targetObjectId) {
    return null;
  }

  return {
    id,
    sceneId,
    sourceObjectId,
    targetObjectId,
    sourceCanonicalRef: asString(record.sourceCanonicalRef),
    targetCanonicalRef: asString(record.targetCanonicalRef),
    canonicalEdgeRef: asString(record.canonicalEdgeRef),
    proposalItemId: asString(record.proposalItemId),
    tempKey: asString(record.tempKey),
    hidden: asBoolean(record.hidden, false),
    labelVisible: asBoolean(record.labelVisible, true),
    waypointsJson: asUnknownArray(record.waypointsJson),
    styleJson: asObjectRecord(record.styleJson),
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
  };
}

function parseViewport(value: unknown): LocalGraphSceneViewportRecord | null {
  const record = asRecord(value);
  const sceneId = asString(record.sceneId);
  if (!sceneId) {
    return null;
  }

  return {
    sceneId,
    x: asNumberOrNull(record.x) ?? 0,
    y: asNumberOrNull(record.y) ?? 0,
    zoom: asNumberOrNull(record.zoom) ?? 1,
    selectedObjectIds: asStringArray(record.selectedObjectIds),
    selectedSelectionToken: asString(record.selectedSelectionToken),
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
  };
}

function parseScene(value: unknown): LocalGraphSceneRecord | null {
  const record = asRecord(value);
  const id = asString(record.id);
  const projectId = asString(record.projectId);
  const createdBy = asString(record.createdBy);
  const name = asString(record.name);
  const visibility = asString(record.visibility);
  const viewport = parseViewport(record.viewport);
  if (!id || !projectId || !createdBy || !name || visibility !== "private" || !viewport) {
    return null;
  }

  return {
    id,
    projectId,
    createdBy,
    name,
    isDefault: asBoolean(record.isDefault, false),
    visibility: "private",
    version: asNumberOrNull(record.version) ?? 1,
    lastSeenSemanticVersionToken: asString(record.lastSeenSemanticVersionToken),
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(record.updatedAt) ?? new Date(0).toISOString(),
    objects: Array.isArray(record.objects)
      ? record.objects
          .map((entry) => parseSceneObject(entry))
          .filter((entry): entry is LocalGraphSceneObjectRecord => entry !== null)
      : [],
    links: Array.isArray(record.links)
      ? record.links
          .map((entry) => parseSceneLink(entry))
          .filter((entry): entry is LocalGraphSceneLinkRecord => entry !== null)
      : [],
    viewport,
  };
}

function parseSceneStore(raw: string): LocalGraphSceneStoreFile {
  const parsed = asRecord(JSON.parse(raw));
  return {
    schemaVersion: 1,
    scenes: Array.isArray(parsed.scenes)
      ? parsed.scenes
          .map((entry) => parseScene(entry))
          .filter((entry): entry is LocalGraphSceneRecord => entry !== null)
      : [],
  };
}

function buildSceneSummary(scene: LocalGraphSceneRecord): LocalGraphSceneSummaryRecord {
  return {
    id: scene.id,
    projectId: scene.projectId,
    createdBy: scene.createdBy,
    name: scene.name,
    isDefault: scene.isDefault,
    visibility: scene.visibility,
    version: scene.version,
    lastSeenSemanticVersionToken: scene.lastSeenSemanticVersionToken,
    objectCount: scene.objects.length,
    linkCount: scene.links.length,
    createdAt: scene.createdAt,
    updatedAt: scene.updatedAt,
  };
}

function sortScenes(scenes: LocalGraphSceneRecord[]) {
  return [...scenes].sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function buildDefaultScene(projectId: string): LocalGraphSceneRecord {
  const now = new Date().toISOString();
  return {
    id: "graph-scene-default",
    projectId,
    createdBy: LOCAL_CREATED_BY,
    name: DEFAULT_SCENE_NAME,
    isDefault: true,
    visibility: "private",
    version: 1,
    lastSeenSemanticVersionToken: null,
    createdAt: now,
    updatedAt: now,
    objects: [],
    links: [],
    viewport: {
      sceneId: "graph-scene-default",
      x: 0,
      y: 0,
      zoom: 1,
      selectedObjectIds: [],
      selectedSelectionToken: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function buildObjectKey(
  object: LocalGraphSceneObjectInput,
  canonicalRefOverride: string | null,
  index: number,
) {
  const canonicalRef = trimString(canonicalRefOverride) ?? trimString(object.canonicalRef);
  if (canonicalRef) {
    return `canonical:${canonicalRef}`;
  }
  const tempKey = trimString(object.tempKey);
  if (tempKey) {
    return `temp:${tempKey}`;
  }
  return `index:${index}`;
}

function buildLinkKey(input: LocalGraphSceneLinkInput) {
  const sourceCanonicalRef = trimString(input.sourceCanonicalRef);
  const targetCanonicalRef = trimString(input.targetCanonicalRef);
  if (sourceCanonicalRef && targetCanonicalRef) {
    return {
      source: `canonical:${sourceCanonicalRef}`,
      target: `canonical:${targetCanonicalRef}`,
    };
  }

  const sourceTempKey = trimString(input.sourceTempKey);
  const targetTempKey = trimString(input.targetTempKey);
  if (sourceTempKey && targetTempKey) {
    return {
      source: `temp:${sourceTempKey}`,
      target: `temp:${targetTempKey}`,
    };
  }

  return null;
}

export class LocalGraphSceneVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super("graph scene version conflict");
    this.name = "LocalGraphSceneVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export class LocalGraphSceneStore {
  private readonly projectRoot: string;
  private readonly projectId: string;

  constructor(input: { projectRoot: string; projectId: string }) {
    this.projectRoot = input.projectRoot;
    this.projectId = input.projectId;
  }

  getResolvedSceneStorePath() {
    return this.resolveSceneStorePath();
  }

  async listScenes() {
    const store = await this.readStore();
    return sortScenes(store.scenes).map((scene) => buildSceneSummary(scene));
  }

  async getOrCreateDefaultScene() {
    const store = await this.readStore();
    const existing = store.scenes.find((scene) => scene.isDefault);
    if (existing) {
      return existing;
    }

    const created = buildDefaultScene(this.projectId);
    store.scenes.push(created);
    await this.writeStore(store);
    return created;
  }

  async getScene(sceneId: string) {
    const store = await this.readStore();
    return store.scenes.find((scene) => scene.id === sceneId) ?? null;
  }

  async createScene(input: LocalGraphSceneCreateInput) {
    const store = await this.readStore();
    const now = new Date().toISOString();
    const scene: LocalGraphSceneRecord = {
      id: uniqueId("graph-scene"),
      projectId: this.projectId,
      createdBy: LOCAL_CREATED_BY,
      name:
        trimString(input.name) ?? `${NAMED_SCENE_FALLBACK} ${now}`,
      isDefault: false,
      visibility: "private",
      version: 1,
      lastSeenSemanticVersionToken: null,
      createdAt: now,
      updatedAt: now,
      objects: [],
      links: [],
      viewport: {
        sceneId: "",
        x: 0,
        y: 0,
        zoom: 1,
        selectedObjectIds: [],
        selectedSelectionToken: null,
        createdAt: now,
        updatedAt: now,
      },
    };
    scene.viewport.sceneId = scene.id;
    store.scenes.push(scene);
    await this.writeStore(store);
    return scene;
  }

  async saveScene(sceneId: string, input: LocalGraphSceneSaveInput) {
    const store = await this.readStore();
    const index = store.scenes.findIndex((scene) => scene.id === sceneId);
    if (index === -1) {
      throw new Error(`graph scene not found: ${sceneId}`);
    }

    const current = store.scenes[index]!;
    if (
      typeof input.baseVersion === "number" &&
      input.baseVersion !== current.version
    ) {
      throw new LocalGraphSceneVersionConflictError(current.version);
    }

    const now = new Date().toISOString();
    const proposalTargets = await this.readAppliedCreateNodeTargets(
      input.objects
        .map((object) => trimString(object.proposalItemId))
        .filter((entry): entry is string => entry !== null),
    );

    const objectIdsByKey = new Map<string, string>();
    const objectIdTranslation = new Map<string, string>();
    const nextObjects: LocalGraphSceneObjectRecord[] = input.objects.map(
      (object, index) => {
        const promotedCanonicalRef =
          (object.objectKind === "proposal_node" ||
            object.objectKind === "ghost_node") &&
          trimString(object.proposalItemId)
            ? proposalTargets.get(trimString(object.proposalItemId)!)
            : null;
        const canonicalRef = promotedCanonicalRef ?? trimString(object.canonicalRef);
        const nextId = uniqueId("graph-scene-object");
        objectIdsByKey.set(
          buildObjectKey(object, canonicalRef, index),
          nextId,
        );
        const inputId = trimString(object.id);
        if (inputId) {
          objectIdTranslation.set(inputId, nextId);
        }

        return {
          id: nextId,
          sceneId: current.id,
          objectKind: promotedCanonicalRef
            ? "canonical_node"
            : object.objectKind,
          canonicalRef,
          proposalItemId: promotedCanonicalRef ? null : trimString(object.proposalItemId),
          extractionRunId: trimString(object.extractionRunId),
          tempKey: trimString(object.tempKey),
          x: Number.isFinite(object.x) ? object.x : 0,
          y: Number.isFinite(object.y) ? object.y : 0,
          width:
            typeof object.width === "number" && Number.isFinite(object.width)
              ? object.width
              : null,
          height:
            typeof object.height === "number" && Number.isFinite(object.height)
              ? object.height
              : null,
          pinned: object.pinned ?? false,
          collapsed: object.collapsed ?? false,
          zIndex:
            typeof object.zIndex === "number" && Number.isFinite(object.zIndex)
              ? object.zIndex
              : index,
          styleJson: object.styleJson ?? null,
          createdAt: now,
          updatedAt: now,
        };
      },
    );

    const objectById = new Map(nextObjects.map((object) => [object.id, object]));
    const nextLinks: LocalGraphSceneLinkRecord[] = input.links.map((link) => {
      const resolved = buildLinkKey(link);
      if (!resolved) {
        throw new Error(
          "Scene link는 source/target canonical ref 또는 temp key가 필요합니다.",
        );
      }

      const sourceObjectId = objectIdsByKey.get(resolved.source);
      const targetObjectId = objectIdsByKey.get(resolved.target);
      if (!sourceObjectId || !targetObjectId) {
        throw new Error("Scene link가 가리키는 object를 찾지 못했습니다.");
      }

      return {
        id: uniqueId("graph-scene-link"),
        sceneId: current.id,
        sourceObjectId,
        targetObjectId,
        sourceCanonicalRef: objectById.get(sourceObjectId)?.canonicalRef ?? null,
        targetCanonicalRef: objectById.get(targetObjectId)?.canonicalRef ?? null,
        canonicalEdgeRef: trimString(link.canonicalEdgeRef),
        proposalItemId: trimString(link.proposalItemId),
        tempKey: trimString(link.tempKey),
        hidden: link.hidden ?? false,
        labelVisible: link.labelVisible ?? true,
        waypointsJson: link.waypointsJson ?? null,
        styleJson: link.styleJson ?? null,
        createdAt: now,
        updatedAt: now,
      };
    });

    const nextViewport: LocalGraphSceneViewportRecord = {
      sceneId: current.id,
      x:
        typeof input.viewport?.x === "number" && Number.isFinite(input.viewport.x)
          ? input.viewport.x
          : 0,
      y:
        typeof input.viewport?.y === "number" && Number.isFinite(input.viewport.y)
          ? input.viewport.y
          : 0,
      zoom:
        typeof input.viewport?.zoom === "number" &&
        Number.isFinite(input.viewport.zoom)
          ? input.viewport.zoom
          : 1,
      selectedObjectIds: (input.viewport?.selectedObjectIds ?? [])
        .map((entry) => trimString(entry))
        .filter((entry): entry is string => entry !== null)
        .map((entry) => objectIdTranslation.get(entry) ?? entry),
      selectedSelectionToken: trimString(input.viewport?.selectedSelectionToken ?? null),
      createdAt: trimString(current.viewport.createdAt) ?? now,
      updatedAt: now,
    };

    const nextScene: LocalGraphSceneRecord = {
      ...current,
      version: current.version + 1,
      lastSeenSemanticVersionToken: trimString(
        input.lastSeenSemanticVersionToken,
      ),
      updatedAt: now,
      objects: nextObjects,
      links: nextLinks,
      viewport: nextViewport,
    };
    store.scenes[index] = nextScene;
    await this.writeStore(store);
    return nextScene;
  }

  private async readStore() {
    const storePath = this.resolveSceneStorePath();
    try {
      const raw = await readFile(storePath, "utf8");
      return parseSceneStore(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return emptySceneStoreFile();
      }
      throw error;
    }
  }

  private async writeStore(store: LocalGraphSceneStoreFile) {
    const storePath = this.resolveSceneStorePath();
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(`${storePath}`, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private resolveSceneStorePath() {
    return buildSceneStorePathCandidates(this.projectRoot)[0]!;
  }

  private async readAppliedCreateNodeTargets(proposalItemIds: string[]) {
    if (proposalItemIds.length === 0) {
      return new Map<string, string>();
    }
    const targets = new Map<string, string>();
    for (const targetPath of buildProposalQueuePathCandidates(this.projectRoot)) {
      try {
        const raw = await readFile(targetPath, "utf8");
        const parsed = asRecord(JSON.parse(raw)) as LocalGraphProposalQueueFile;
        for (const proposalSet of Array.isArray(parsed.proposalSets)
          ? parsed.proposalSets
          : []) {
          const items = Array.isArray(proposalSet.items) ? proposalSet.items : [];
          for (const item of items) {
            if (
              proposalItemIds.includes(item.id) &&
              item.opKind === "create_node" &&
              item.status === "applied" &&
              trimString(item.targetRef)
            ) {
              targets.set(item.id, trimString(item.targetRef)!);
            }
          }
        }
        if (targets.size > 0) {
          return targets;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }
    return targets;
  }
}
