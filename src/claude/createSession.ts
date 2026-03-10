import { Context } from 'hono';
import {
	beginConduitSessionCapture,
	createHeadlessCliSession,
	finalizeConduitSessionRun,
	resolveSupportedCli,
	validateConduitSessionRequestMetadata,
	type ConduitSessionCaptureHandle,
} from '../utils/headlessCliHelpers';
import { resolveReadyWorkspaceForNewWork } from '../utils/workspaceReadiness';

/**
 * REST API handler to create a new headless CLI session
 * POST /api/claude/session
 * Body: {
 *   prompt: string,
 *   context?: string,
 *   cli?: 'claude' | 'codex',
 *   model?: string,
 *   agentId: string,
 *   workspaceId: string,
 *   pipelineId?: string
 * }
 */
export async function createSession(c: Context) {
	let captureHandle: ConduitSessionCaptureHandle | null = null;

	try {
		const body = await c.req.json();
		const { prompt, context, cli: requestedCli, model, agentId, workspaceId, pipelineId } = body;

		if (!prompt || typeof prompt !== 'string') {
			return c.json({ error: 'Prompt is required and must be a string' }, 400);
		}

		if (model !== undefined && typeof model !== 'string') {
			return c.json({ error: 'Model must be a string' }, 400);
		}

		if (context !== undefined && typeof context !== 'string') {
			return c.json({ error: 'Context must be a string' }, 400);
		}

		try {
			validateConduitSessionRequestMetadata({ agentId, workspaceId, pipelineId });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : 'Invalid session metadata' }, 400);
		}

		const { workspace, error: workspaceError } = resolveReadyWorkspaceForNewWork(workspaceId);
		if (!workspace || workspaceError) {
			return c.json({ error: workspaceError || 'Workspace is not ready for new work' }, 400);
		}

		let cli: 'claude' | 'codex';
		try {
			cli = resolveSupportedCli(requestedCli, 'claude');
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : 'Invalid cli' }, 400);
		}

		captureHandle = beginConduitSessionCapture(
			cli,
			{ agentId, workspaceId, pipelineId },
			prompt,
			model,
			undefined,
			context,
		);
		const session = await createHeadlessCliSession(
			cli,
			prompt,
			workspace.path,
			model,
			(streamData) => {
				captureHandle?.handleStreamEvent(streamData);
			},
			captureHandle.conduitSessionId,
		);
		return c.json(finalizeConduitSessionRun(cli, captureHandle, session));
	} catch (error) {
		if (captureHandle) {
			const message = error instanceof Error ? error.message : 'Unknown error occurred';
			captureHandle.fail(message);
		}

		console.error('Error creating CLI session:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}
