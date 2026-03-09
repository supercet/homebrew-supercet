import fs from 'fs';
import path from 'path';
import type { Socket } from 'socket.io';
import { createGitOperations } from '../utils/gitHelpers';
import { appendConduitWorkspaceEvent, setConduitWorkspaceLifecycleState } from '../db/sqlite';

interface WorkspaceContextBase {
	id: string;
	rootPath: string;
	repoRootPath: string;
	branchName: string | null;
	parentWorkspaceId: string | null;
}

interface WorkspaceSummaryBase {
	id: string;
	parentWorkspaceId: string | null;
}

interface RegisterWorkspaceOptions {
	requireGitRepo?: boolean;
	parentWorkspaceId?: string | null;
	repoRootPath?: string;
	branchName?: string | null;
}

interface RegisterWorktreeSocketHandlersOptions<
	TWorkspace extends WorkspaceContextBase,
	TSummary extends WorkspaceSummaryBase,
> {
	socket: Socket;
	ensureAuthenticated: (updateEvent: string) => boolean;
	resolveWorkspaceOrEmitError: (workspaceId: string | undefined, updateEvent: string) => TWorkspace | null;
	workspacesById: Map<string, TWorkspace>;
	listWorkspaceSummaries: () => TSummary[];
	registerWorkspace: (inputPath: string, options: RegisterWorkspaceOptions) => TWorkspace;
	persistWorkspaceRecord: (workspace: TWorkspace) => void;
	persistAndActivateWorkspace: (workspace: TWorkspace) => void;
	subscribeSocketToWorkspace: (socket: Socket, workspace: TWorkspace) => void;
	buildWorkspaceStatus: () => unknown;
	emitWorkspaceStatusUpdate: () => void;
	unregisterWorkspace: (workspaceId: string) => TWorkspace;
	chooseFallbackWorkspaceForRemoval: (removedWorkspaceId: string) => TWorkspace | null;
	reassignSocketsFromWorkspace: (removedWorkspaceId: string, fallbackWorkspace: TWorkspace | null) => void;
	syncActiveWorkspaceRecord: () => void;
}

function isWorkspaceWorktree(workspace: WorkspaceContextBase): boolean {
	return workspace.parentWorkspaceId !== null;
}

function isExistingDirectory(candidatePath: string | null | undefined): candidatePath is string {
	if (!candidatePath || typeof candidatePath !== 'string') {
		return false;
	}

	try {
		return fs.statSync(candidatePath).isDirectory();
	} catch {
		return false;
	}
}

function slugifyWorkspaceName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return slug || 'workspace';
}

function generateWorktreePath(repoRootPath: string, branchName: string): string {
	const containerPath = path.join(path.dirname(repoRootPath), `${path.basename(repoRootPath)}.worktrees`);
	fs.mkdirSync(containerPath, { recursive: true });
	const slug = slugifyWorkspaceName(branchName) || 'worktree';
	let candidatePath = path.join(containerPath, slug);
	let suffix = 2;
	while (fs.existsSync(candidatePath)) {
		candidatePath = path.join(containerPath, `${slug}-${suffix}`);
		suffix++;
	}
	return candidatePath;
}

function resolveRequestedWorktreePath(
	primaryWorkspace: WorkspaceContextBase,
	branchName: string,
	requestedPath?: string,
): string {
	if (!requestedPath || typeof requestedPath !== 'string') {
		return generateWorktreePath(primaryWorkspace.repoRootPath, branchName);
	}

	if (path.isAbsolute(requestedPath)) {
		return path.resolve(requestedPath);
	}

	return path.resolve(primaryWorkspace.repoRootPath, requestedPath);
}

export function registerWorktreeSocketHandlers<
	TWorkspace extends WorkspaceContextBase,
	TSummary extends WorkspaceSummaryBase,
>(options: RegisterWorktreeSocketHandlersOptions<TWorkspace, TSummary>): void {
	const {
		socket,
		ensureAuthenticated,
		resolveWorkspaceOrEmitError,
		workspacesById,
		listWorkspaceSummaries,
		registerWorkspace,
		persistWorkspaceRecord,
		persistAndActivateWorkspace,
		subscribeSocketToWorkspace,
		buildWorkspaceStatus,
		emitWorkspaceStatusUpdate,
		unregisterWorkspace,
		chooseFallbackWorkspaceForRemoval,
		reassignSocketsFromWorkspace,
		syncActiveWorkspaceRecord,
	} = options;

	function resolveWorktreeParentWorkspace(
		params: { workspaceId?: string } | undefined,
		updateEvent: string,
	): TWorkspace | null {
		const workspace = resolveWorkspaceOrEmitError(params?.workspaceId, updateEvent);
		if (!workspace) {
			return null;
		}

		if (workspace.parentWorkspaceId) {
			socket.emit(updateEvent, {
				success: false,
				error: 'Worktree operations must target a primary workspace',
			});
			return null;
		}

		return workspace;
	}

	socket.on(
		'workspace:worktree:create',
		async (
			params: {
				workspaceId?: string;
				branch?: string;
				fromRef?: string;
				path?: string;
				activate?: boolean;
			} = {},
		) => {
			const updateEvent = 'workspace:worktree:create:update';
			if (!ensureAuthenticated(updateEvent)) {
				return;
			}

			const primaryWorkspace = resolveWorktreeParentWorkspace(params, updateEvent);
			if (!primaryWorkspace) {
				return;
			}

			const branchName = typeof params.branch === 'string' ? params.branch.trim() : '';
			if (!branchName) {
				socket.emit(updateEvent, {
					success: false,
					error: 'branch is required',
				});
				return;
			}

			const existingBranchWorkspace = Array.from(workspacesById.values()).find(
				(candidate) =>
					candidate.repoRootPath === primaryWorkspace.repoRootPath &&
					candidate.parentWorkspaceId !== null &&
					candidate.branchName === branchName,
			);
			if (existingBranchWorkspace) {
				socket.emit(updateEvent, {
					success: false,
					error: `A ready worktree for branch '${branchName}' already exists`,
				});
				return;
			}

			const targetWorktreePath = resolveRequestedWorktreePath(primaryWorkspace, branchName, params.path);
			let didCreateWorktree = false;
			let createdWorkspace: TWorkspace | null = null;

			try {
				const repoGitOperations = createGitOperations(primaryWorkspace.repoRootPath);
				await repoGitOperations.worktreeAdd(targetWorktreePath, branchName, params.fromRef || 'HEAD');
				didCreateWorktree = true;

				createdWorkspace = registerWorkspace(targetWorktreePath, {
					requireGitRepo: true,
					parentWorkspaceId: primaryWorkspace.id,
					repoRootPath: primaryWorkspace.repoRootPath,
					branchName,
				});
				persistWorkspaceRecord(createdWorkspace);
				appendConduitWorkspaceEvent(
					createdWorkspace.id,
					'worktree_created',
					`Created from parent workspace ${primaryWorkspace.id}`,
				);
				appendConduitWorkspaceEvent(createdWorkspace.id, 'created');

				if (params.activate) {
					persistAndActivateWorkspace(createdWorkspace);
					subscribeSocketToWorkspace(socket, createdWorkspace);
				}

				socket.emit(updateEvent, {
					success: true,
					workspaceId: createdWorkspace.id,
					path: createdWorkspace.rootPath,
					data: buildWorkspaceStatus(),
				});
				emitWorkspaceStatusUpdate();
			} catch (error) {
				if (didCreateWorktree) {
					if (createdWorkspace) {
						try {
							unregisterWorkspace(createdWorkspace.id);
						} catch (unregisterError) {
							console.warn(
								`⚠️  Failed to unregister partially created workspace ${createdWorkspace.id}:`,
								unregisterError,
							);
						}
					}
					try {
						const repoGitOperations = createGitOperations(primaryWorkspace.repoRootPath);
						await repoGitOperations.worktreeRemove(targetWorktreePath, true);
						await repoGitOperations.worktreePrune();
					} catch (cleanupError) {
						console.warn(`⚠️  Failed to rollback worktree at ${targetWorktreePath}:`, cleanupError);
					}
				}

				socket.emit(updateEvent, {
					success: false,
					error: error instanceof Error ? error.message : 'Failed to create worktree',
				});
			}
		},
	);

	socket.on('workspace:worktree:list', (params: { workspaceId?: string } = {}) => {
		const updateEvent = 'workspace:worktree:list:update';
		if (!ensureAuthenticated(updateEvent)) {
			return;
		}

		const selectedWorkspace = resolveWorkspaceOrEmitError(params.workspaceId, updateEvent);
		if (!selectedWorkspace) {
			return;
		}

		const primaryWorkspace = selectedWorkspace.parentWorkspaceId
			? workspacesById.get(selectedWorkspace.parentWorkspaceId) || null
			: selectedWorkspace;

		if (!primaryWorkspace) {
			socket.emit(updateEvent, {
				success: false,
				error: 'Primary workspace for worktree list was not found',
			});
			return;
		}

		const worktrees = listWorkspaceSummaries().filter(
			(workspaceSummary) => workspaceSummary.parentWorkspaceId === primaryWorkspace.id,
		);

		socket.emit(updateEvent, {
			success: true,
			data: {
				primaryWorkspaceId: primaryWorkspace.id,
				worktrees,
			},
		});
	});

	socket.on('workspace:worktree:cleanup', async (params: { workspaceId?: string; force?: boolean } = {}) => {
		const updateEvent = 'workspace:worktree:cleanup:update';
		if (!ensureAuthenticated(updateEvent)) {
			return;
		}

		if (!params.workspaceId || typeof params.workspaceId !== 'string') {
			socket.emit(updateEvent, {
				success: false,
				error: 'workspaceId is required',
			});
			return;
		}

		const worktreeWorkspace = workspacesById.get(params.workspaceId);
		if (!worktreeWorkspace) {
			socket.emit(updateEvent, {
				success: false,
				error: 'Workspace not found',
			});
			return;
		}

		if (!isWorkspaceWorktree(worktreeWorkspace)) {
			socket.emit(updateEvent, {
				success: false,
				error: 'workspaceId must reference a worktree workspace',
			});
			return;
		}

		try {
			const parentWorkspace = worktreeWorkspace.parentWorkspaceId
				? workspacesById.get(worktreeWorkspace.parentWorkspaceId) || null
				: null;
			const gitBaseDirCandidates = [
				parentWorkspace?.rootPath || null,
				parentWorkspace?.repoRootPath || null,
				worktreeWorkspace.repoRootPath,
				worktreeWorkspace.rootPath,
			];
			const gitBaseDir = gitBaseDirCandidates.find((candidatePath) => isExistingDirectory(candidatePath));

			if (!gitBaseDir) {
				setConduitWorkspaceLifecycleState(worktreeWorkspace.id, 'completed');
				appendConduitWorkspaceEvent(
					worktreeWorkspace.id,
					'completed',
					'Worktree path missing during cleanup; marked completed.',
				);
				unregisterWorkspace(worktreeWorkspace.id);
				const fallbackWorkspace = chooseFallbackWorkspaceForRemoval(worktreeWorkspace.id);
				reassignSocketsFromWorkspace(worktreeWorkspace.id, fallbackWorkspace);
				syncActiveWorkspaceRecord();

				socket.emit(updateEvent, {
					success: true,
					workspaceId: worktreeWorkspace.id,
					data: buildWorkspaceStatus(),
				});
				emitWorkspaceStatusUpdate();
				return;
			}

			appendConduitWorkspaceEvent(worktreeWorkspace.id, 'worktree_cleanup_started');
			const repoGitOperations = createGitOperations(gitBaseDir);
			await repoGitOperations.worktreeRemove(worktreeWorkspace.rootPath, Boolean(params.force));
			await repoGitOperations.worktreePrune();

			setConduitWorkspaceLifecycleState(worktreeWorkspace.id, 'completed');
			appendConduitWorkspaceEvent(worktreeWorkspace.id, 'worktree_cleanup_completed');
			appendConduitWorkspaceEvent(worktreeWorkspace.id, 'completed', 'Worktree cleanup completed');

			unregisterWorkspace(worktreeWorkspace.id);
			const fallbackWorkspace = chooseFallbackWorkspaceForRemoval(worktreeWorkspace.id);
			reassignSocketsFromWorkspace(worktreeWorkspace.id, fallbackWorkspace);
			syncActiveWorkspaceRecord();

			socket.emit(updateEvent, {
				success: true,
				workspaceId: worktreeWorkspace.id,
				data: buildWorkspaceStatus(),
			});
			emitWorkspaceStatusUpdate();
		} catch (error) {
			try {
				appendConduitWorkspaceEvent(
					worktreeWorkspace.id,
					'worktree_cleanup_failed',
					error instanceof Error ? error.message : String(error),
				);
			} catch (trackingError) {
				console.warn(`⚠️  Failed to persist cleanup failure for ${worktreeWorkspace.id}:`, trackingError);
			}

			socket.emit(updateEvent, {
				success: false,
				error: error instanceof Error ? error.message : 'Failed to cleanup worktree',
			});
		}
	});
}
