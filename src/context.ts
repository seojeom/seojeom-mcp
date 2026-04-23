import type { DesktopMcpServerConfig } from "./config.js";
import { UpstreamApiBridge } from "./http-bridge.js";
import type { DesktopMcpApprovalControllerLike } from "./approval.js";
import { LocalFilesystemWikiStore } from "./local-wiki-store.js";
import { LocalGraphSnapshotStore } from "./local-graph-store.js";
import { LocalGraphProposalStore } from "./local-graph-proposal-store.js";
import { LocalGraphSceneStore } from "./local-graph-scene-store.js";

export type DesktopMcpContext = {
  config: DesktopMcpServerConfig;
  actualPort: number;
  apiBridge: UpstreamApiBridge;
  approval: DesktopMcpApprovalControllerLike;
  localWikiStore: LocalFilesystemWikiStore | null;
  localGraphStore: LocalGraphSnapshotStore | null;
  localProposalStore: LocalGraphProposalStore | null;
  localGraphSceneStore: LocalGraphSceneStore | null;
};

export function createDesktopMcpContext(
  config: DesktopMcpServerConfig,
  actualPort: number,
  approval: DesktopMcpApprovalControllerLike,
): DesktopMcpContext {
  return {
    config,
    actualPort,
    apiBridge: new UpstreamApiBridge(config),
    approval,
    localWikiStore:
      config.wikiAuthority === "local-filesystem"
        ? new LocalFilesystemWikiStore({
            projectId: config.projectId,
            projectRoot: config.projectRoot,
          })
        : null,
    localGraphStore:
      config.graphAuthority === "local-snapshot"
        ? new LocalGraphSnapshotStore({
            projectId: config.projectId,
            projectRoot: config.projectRoot,
            graphSlicePath: config.graphSlicePath,
          })
        : null,
    localProposalStore:
      config.graphAuthority === "local-snapshot"
        ? new LocalGraphProposalStore({
            projectId: config.projectId,
            projectRoot: config.projectRoot,
          })
        : null,
    localGraphSceneStore:
      config.graphAuthority === "local-snapshot"
        ? new LocalGraphSceneStore({
            projectId: config.projectId,
            projectRoot: config.projectRoot,
          })
        : null,
  };
}
