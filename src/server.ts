import { randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";
import type { Server as NodeHttpServer } from "node:http";

import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  DesktopMcpApprovalController,
  type DesktopMcpApprovalControllerLike,
  isDesktopMcpApprovalQueueController,
} from "./approval.js";
import {
  buildDesktopMcpHealthSnapshot,
  type DesktopMcpServerConfig,
} from "./config.js";
import { createDesktopMcpContext } from "./context.js";
import { registerGraphContextTools } from "./tools/graph-context.js";
import { registerGraphGapAnalysisTools } from "./tools/graph-gap-analysis.js";
import { registerGraphMutationTools } from "./tools/graph-mutation.js";
import { registerGraphPlaybookTools } from "./tools/graph-playbook.js";
import { registerGraphProposalTools } from "./tools/graph-proposals.js";
import { registerGraphReadTools } from "./tools/graph-read.js";
import { registerGraphResearchPrepTools } from "./tools/graph-research-prep.js";
import { registerGraphRunbookTools } from "./tools/graph-runbook.js";
import {
  registerFocusedGraphSessionTools,
  registerGraphSessionTools,
} from "./tools/graph-session.js";
import { registerGraphSceneTools } from "./tools/graph-scenes.js";
import { registerGraphWorkflowTools } from "./tools/graph-workflow.js";
import { registerProjectTools } from "./tools/project.js";
import { registerWikiTools } from "./tools/wiki.js";

type SessionBinding = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

export type DesktopMcpSidecarHandle = {
  actualPort: number;
  serverUrl: string;
  mcpUrl: string;
  healthUrl: string;
  close: () => Promise<void>;
};

function readHeaderValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function ensureApprovalAccess(
  config: DesktopMcpServerConfig,
  request: express.Request,
  response: express.Response,
) {
  if (!config.apiHeaderName || !config.apiHeaderValue) {
    response.status(503).json({
      error: "approval access is not configured",
    });
    return false;
  }

  const currentValue = request.header(config.apiHeaderName);
  if (currentValue !== config.apiHeaderValue) {
    response.status(401).json({
      error: "unauthorized approval access",
    });
    return false;
  }

  return true;
}

export function createDesktopMcpServer(
  config: DesktopMcpServerConfig,
  actualPort: number,
  approval: DesktopMcpApprovalControllerLike,
): McpServer {
  const server = new McpServer({
    name: config.serverName,
    version: config.serverVersion,
  });
  const context = createDesktopMcpContext(config, actualPort, approval);

  registerProjectTools(server, context);
  registerWikiTools(server, context);
  registerGraphReadTools(server, context);
  registerGraphContextTools(server, context);
  registerGraphGapAnalysisTools(server, context);
  registerGraphResearchPrepTools(server, context);
  registerGraphWorkflowTools(server, context);
  registerGraphRunbookTools(server, context);
  registerGraphSessionTools(server, context);
  registerFocusedGraphSessionTools(server, context);
  registerGraphPlaybookTools(server, context);
  registerGraphSceneTools(server, context);
  registerGraphProposalTools(server, context);
  registerGraphMutationTools(server, context);

  return server;
}

function listen(
  app: ReturnType<typeof createMcpExpressApp>,
  host: string,
  port: number,
): Promise<NodeHttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resolve(server);
    });

    server.on("error", (error) => {
      reject(error);
    });
  });
}

export async function startDesktopMcpSidecar(
  config: DesktopMcpServerConfig,
): Promise<DesktopMcpSidecarHandle> {
  const app = createMcpExpressApp({ host: config.host });
  app.use(express.json({ limit: "1mb" }));

  const bindings = new Map<string, SessionBinding>();
  const approval = new DesktopMcpApprovalController(config.projectId);
  let actualPort = config.port;

  app.get(config.healthPath, (_request, response) => {
    response.json(buildDesktopMcpHealthSnapshot(config, actualPort));
  });

  app.get(`${config.approvalPath}/requests`, (request, response) => {
    if (!isDesktopMcpApprovalQueueController(approval)) {
      response.status(404).json({
        error: "approval queue is unavailable for this transport",
      });
      return;
    }
    if (!ensureApprovalAccess(config, request, response)) {
      return;
    }

    response.json({
      requests: approval.listPending(),
    });
  });

  app.post(`${config.approvalPath}/requests/:requestId/decision`, (request, response) => {
    if (!isDesktopMcpApprovalQueueController(approval)) {
      response.status(404).json({
        error: "approval queue is unavailable for this transport",
      });
      return;
    }
    if (!ensureApprovalAccess(config, request, response)) {
      return;
    }

    const requestId = request.params.requestId?.trim();
    const decision =
      request.body?.decision === "approve" || request.body?.decision === "deny"
        ? request.body.decision
        : null;

    if (!requestId || !decision) {
      response.status(422).json({
        error: "invalid approval decision payload",
      });
      return;
    }

    try {
      const resolvedRequest = approval.decide({
        requestId,
        decision,
        rememberProject: Boolean(request.body?.rememberProject),
      });
      response.json({
        request: resolvedRequest,
        pending: approval.listPending(),
      });
    } catch (error) {
      response.status(404).json({
        error: error instanceof Error ? error.message : "unknown approval request",
      });
    }
  });

  app.post(config.mcpPath, async (request, response) => {
    const sessionId = readHeaderValue(request.headers["mcp-session-id"]);

    try {
      if (sessionId) {
        const existing = bindings.get(sessionId);
        if (!existing) {
          response.status(404).json({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Unknown MCP session",
            },
            id: null,
          });
          return;
        }

        await existing.transport.handleRequest(request, response, request.body);
        return;
      }

      if (!isInitializeRequest(request.body)) {
        response.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Initialization request required for a new MCP session",
          },
          id: null,
        });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          bindings.set(initializedSessionId, { server, transport });
        },
      });
      const server = createDesktopMcpServer(config, actualPort, approval);

      transport.onclose = () => {
        const transportSessionId = transport.sessionId;
        if (transportSessionId) {
          bindings.delete(transportSessionId);
        }
        void server.close().catch(() => undefined);
      };
      transport.onerror = (error) => {
        console.error("[ainovel-desktop-mcp] transport error", error);
      };

      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("[ainovel-desktop-mcp] POST /mcp failed", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get(config.mcpPath, async (request, response) => {
    const sessionId = readHeaderValue(request.headers["mcp-session-id"]);
    if (!sessionId) {
      response.status(400).send("Missing MCP session id");
      return;
    }

    const existing = bindings.get(sessionId);
    if (!existing) {
      response.status(404).send("Unknown MCP session");
      return;
    }

    try {
      await existing.transport.handleRequest(request, response);
    } catch (error) {
      console.error("[ainovel-desktop-mcp] GET /mcp failed", error);
      if (!response.headersSent) {
        response.status(500).send("Internal server error");
      }
    }
  });

  app.delete(config.mcpPath, async (request, response) => {
    const sessionId = readHeaderValue(request.headers["mcp-session-id"]);
    if (!sessionId) {
      response.status(400).send("Missing MCP session id");
      return;
    }

    const existing = bindings.get(sessionId);
    if (!existing) {
      response.status(404).send("Unknown MCP session");
      return;
    }

    try {
      await existing.transport.handleRequest(request, response);
      bindings.delete(sessionId);
      await existing.server.close().catch(() => undefined);
    } catch (error) {
      console.error("[ainovel-desktop-mcp] DELETE /mcp failed", error);
      if (!response.headersSent) {
        response.status(500).send("Internal server error");
      }
    }
  });

  const httpServer = await listen(app, config.host, config.port);
  const serverAddress = httpServer.address();

  if (!serverAddress || typeof serverAddress === "string") {
    throw new Error("failed to resolve bound loopback address");
  }

  actualPort = (serverAddress as AddressInfo).port;

  return {
    actualPort,
    serverUrl: `http://${config.host}:${actualPort}`,
    mcpUrl: `http://${config.host}:${actualPort}${config.mcpPath}`,
    healthUrl: `http://${config.host}:${actualPort}${config.healthPath}`,
    close: async () => {
      await Promise.all(
        Array.from(bindings.values()).map(async ({ server, transport }) => {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }),
      );
      bindings.clear();

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}
