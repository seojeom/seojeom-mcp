import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import readline from "node:readline/promises";

export type DesktopMcpApprovalAction =
  | "graph_apply_mutation"
  | "graph_propose_node"
  | "graph_propose_edge"
  | "graph_decide_proposal_set"
  | "graph_apply_proposal_set"
  | "graph_scene_create"
  | "graph_scene_save"
  | "wiki_write";

export type DesktopMcpApprovalRequest = {
  id: string;
  projectId: string;
  action: DesktopMcpApprovalAction;
  toolName: string;
  title: string;
  summary: string | null;
  details: string[];
  createdAt: string;
};

export type DesktopMcpApprovalPendingRequest = DesktopMcpApprovalRequest & {
  status: "pending";
};

export type DesktopMcpApprovalResolution = {
  approved: boolean;
  rememberProject: boolean;
  source: "remembered" | "user" | "timeout";
  respondedAt: string;
  reason: string | null;
};

export type DesktopMcpApprovalRequestInput = {
  action: DesktopMcpApprovalAction;
  toolName: string;
  title: string;
  summary?: string | null;
  details?: string[];
};

export interface DesktopMcpApprovalControllerLike {
  requestApproval(
    input: DesktopMcpApprovalRequestInput,
  ): Promise<DesktopMcpApprovalResolution>;
}

export interface DesktopMcpApprovalQueueController
  extends DesktopMcpApprovalControllerLike {
  listPending(): DesktopMcpApprovalPendingRequest[];
  decide(input: {
    requestId: string;
    decision: "approve" | "deny";
    rememberProject?: boolean;
  }): DesktopMcpApprovalPendingRequest;
}

type PendingApprovalRecord = {
  request: DesktopMcpApprovalPendingRequest;
  resolve: (resolution: DesktopMcpApprovalResolution) => void;
  timeoutId: NodeJS.Timeout;
};

const APPROVAL_TIMEOUT_MS = 60_000;

function normalizeApprovalRequest(
  projectId: string,
  id: string,
  createdAt: string,
  input: DesktopMcpApprovalRequestInput,
): DesktopMcpApprovalPendingRequest {
  return {
    id,
    projectId,
    action: input.action,
    toolName: input.toolName,
    title: input.title,
    summary: input.summary?.trim() ? input.summary.trim() : null,
    details: (input.details ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    createdAt,
    status: "pending",
  };
}

function resolveTtyDevicePath(kind: "input" | "output") {
  if (process.platform === "win32") {
    return kind === "input" ? "CONIN$" : "CONOUT$";
  }

  return "/dev/tty";
}

async function promptOnControllingTerminal(
  request: DesktopMcpApprovalPendingRequest,
) {
  const inputPath = resolveTtyDevicePath("input");
  const outputPath = resolveTtyDevicePath("output");
  const input = createReadStream(inputPath, { encoding: "utf8" });
  const output = createWriteStream(outputPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
  });

  try {
    output.write(
      [
        "",
        `[seojeom mcp approval] ${request.title}`,
        `project=${request.projectId} action=${request.action} tool=${request.toolName}`,
        request.summary ? `summary=${request.summary}` : null,
        ...request.details.map((detail) => `detail=${detail}`),
        "approve once [y], approve and remember for this project [a], deny [n]",
      ]
        .filter((entry) => typeof entry === "string" && entry.length > 0)
        .join("\n") + "\n",
    );
    const answer = (await rl.question("> ")).trim().toLowerCase();

    if (answer === "a" || answer === "always") {
      return {
        approved: true,
        rememberProject: true,
      };
    }

    if (answer === "y" || answer === "yes") {
      return {
        approved: true,
        rememberProject: false,
      };
    }

    return {
      approved: false,
      rememberProject: false,
    };
  } finally {
    rl.close();
    input.destroy();
    output.end();
  }
}

export function isDesktopMcpApprovalQueueController(
  value: DesktopMcpApprovalControllerLike,
): value is DesktopMcpApprovalQueueController {
  return (
    typeof (value as DesktopMcpApprovalQueueController).listPending ===
      "function" &&
    typeof (value as DesktopMcpApprovalQueueController).decide === "function"
  );
}

export class DesktopMcpApprovalController
  implements DesktopMcpApprovalQueueController
{
  private readonly projectId: string;
  private readonly pending = new Map<string, PendingApprovalRecord>();
  private readonly projectRememberedActions = new Set<DesktopMcpApprovalAction>();

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  listPending(): DesktopMcpApprovalPendingRequest[] {
    return Array.from(this.pending.values())
      .map((entry) => entry.request)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async requestApproval(
    input: DesktopMcpApprovalRequestInput,
  ): Promise<DesktopMcpApprovalResolution> {
    if (this.projectRememberedActions.has(input.action)) {
      return {
        approved: true,
        rememberProject: true,
        source: "remembered",
        respondedAt: new Date().toISOString(),
        reason: null,
      };
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const request = normalizeApprovalRequest(this.projectId, id, createdAt, input);

    return new Promise<DesktopMcpApprovalResolution>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          approved: false,
          rememberProject: false,
          source: "timeout",
          respondedAt: new Date().toISOString(),
          reason: "approval timed out",
        });
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(id, {
        request,
        resolve,
        timeoutId,
      });
    });
  }

  decide(input: {
    requestId: string;
    decision: "approve" | "deny";
    rememberProject?: boolean;
  }): DesktopMcpApprovalPendingRequest {
    const record = this.pending.get(input.requestId);
    if (!record) {
      throw new Error(`unknown approval request: ${input.requestId}`);
    }

    this.pending.delete(input.requestId);
    clearTimeout(record.timeoutId);

    const approved = input.decision === "approve";
    const rememberProject = approved && Boolean(input.rememberProject);
    if (rememberProject) {
      this.projectRememberedActions.add(record.request.action);
    }

    record.resolve({
      approved,
      rememberProject,
      source: "user",
      respondedAt: new Date().toISOString(),
      reason: approved ? null : "denied by user",
    });

    return record.request;
  }
}

export type StandaloneMcpApprovalMode = "always" | "never" | "prompt";

export class StandaloneMcpApprovalController
  implements DesktopMcpApprovalControllerLike
{
  private readonly projectId: string;
  private readonly mode: StandaloneMcpApprovalMode;
  private readonly projectRememberedActions = new Set<DesktopMcpApprovalAction>();

  constructor(input: {
    projectId: string;
    mode: StandaloneMcpApprovalMode;
  }) {
    this.projectId = input.projectId;
    this.mode = input.mode;
  }

  async requestApproval(
    input: DesktopMcpApprovalRequestInput,
  ): Promise<DesktopMcpApprovalResolution> {
    if (this.projectRememberedActions.has(input.action)) {
      return {
        approved: true,
        rememberProject: true,
        source: "remembered",
        respondedAt: new Date().toISOString(),
        reason: null,
      };
    }

    if (this.mode === "always") {
      return {
        approved: true,
        rememberProject: false,
        source: "user",
        respondedAt: new Date().toISOString(),
        reason: null,
      };
    }

    if (this.mode === "never") {
      return {
        approved: false,
        rememberProject: false,
        source: "user",
        respondedAt: new Date().toISOString(),
        reason: "approval denied by standalone policy",
      };
    }

    const request = normalizeApprovalRequest(
      this.projectId,
      randomUUID(),
      new Date().toISOString(),
      input,
    );

    try {
      const promptResult = await promptOnControllingTerminal(request);
      if (promptResult.approved && promptResult.rememberProject) {
        this.projectRememberedActions.add(input.action);
      }

      return {
        approved: promptResult.approved,
        rememberProject: promptResult.rememberProject,
        source: "user",
        respondedAt: new Date().toISOString(),
        reason: promptResult.approved ? null : "denied by user",
      };
    } catch (error) {
      return {
        approved: false,
        rememberProject: false,
        source: "user",
        respondedAt: new Date().toISOString(),
        reason:
          error instanceof Error && error.message.trim().length > 0
            ? `interactive approval unavailable: ${error.message}`
            : "interactive approval unavailable",
      };
    }
  }
}
