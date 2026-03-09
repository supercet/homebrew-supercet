import { getConduitWorkspaceById, type ConduitWorkspaceRecord } from '../db/sqlite';

interface ResolveReadyWorkspaceResult {
	workspace: ConduitWorkspaceRecord | null;
	error: string | null;
}

export function resolveReadyWorkspaceForNewWork(workspaceId: string): ResolveReadyWorkspaceResult {
	const workspace = getConduitWorkspaceById(workspaceId);
	if (!workspace) {
		return {
			workspace: null,
			error: `Workspace '${workspaceId}' was not found`,
		};
	}

	if (workspace.lifecycleState !== 'ready') {
		return {
			workspace: null,
			error: `Workspace '${workspaceId}' is not ready for new work (state: ${workspace.lifecycleState})`,
		};
	}

	return {
		workspace,
		error: null,
	};
}
