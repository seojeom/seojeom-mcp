import { existsSync } from "node:fs";
import process from "node:process";

import { parseDesktopMcpServerConfig } from "./config.js";
import { startDesktopMcpSidecar } from "./server.js";

async function main() {
  const config = parseDesktopMcpServerConfig();

  if (!existsSync(config.projectRoot)) {
    throw new Error(`project root does not exist: ${config.projectRoot}`);
  }

  process.chdir(config.projectRoot);

  const sidecar = await startDesktopMcpSidecar(config);
  let closed = false;

  const shutdown = async (signal: string) => {
    if (closed) {
      return;
    }
    closed = true;

    console.log(
      JSON.stringify({
        type: "seojeom_desktop_mcp_shutdown",
        signal,
      }),
    );

    try {
      await sidecar.close();
    } finally {
      process.exit(0);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // SEC-H2 (2026-04-21): stdout ready payload 에서 민감정보 제거.
  // projectRoot 전체 경로는 유저 homedir 을 포함하므로 외부 CLI/transcript 로 새어나가면 안 된다.
  // 필요한 경우 경로 힌트는 호스트 basename 으로만 노출.
  const path = await import("node:path");
  const projectRootName = path.basename(config.projectRoot);
  console.log(
    JSON.stringify({
      type: "seojeom_desktop_mcp_ready",
      projectId: config.projectId,
      projectRootName, // sanitized: basename only, no full path
      host: config.host,
      port: sidecar.actualPort,
      mcpUrl: sidecar.mcpUrl,
      healthUrl: sidecar.healthUrl,
      approvalUrl: `${sidecar.serverUrl}${config.approvalPath}`,
      startedAt: config.startedAt,
      pid: process.pid,
    }),
  );
}

void main().catch((error) => {
  console.error("[seojeom-desktop-mcp] failed to start", error);
  process.exit(1);
});
