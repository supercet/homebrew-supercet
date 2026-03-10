import { Context } from 'hono';
import {
	beginConduitSessionCapture,
	createHeadlessCliSession,
	finalizeConduitSessionRun,
	validateConduitSessionRequestMetadata,
	type ConduitSessionCaptureHandle,
} from '../utils/headlessCliHelpers';
import { resolveReadyWorkspaceForNewWork } from '../utils/workspaceReadiness';

/**
 * REST API handler to create a new Codex session
 * POST /api/codex/session
 * Body: {
 *   prompt: string,
 *   context?: string,
 *   model?: string,
 *   agentId: string,
 *   workspaceId: string,
 *   pipelineId?: string
 * }
 */
export async function createCodexSessionRoute(c: Context) {
	let captureHandle: ConduitSessionCaptureHandle | null = null;

	try {
		const body = await c.req.json();
		const { prompt, context, model, agentId, workspaceId, pipelineId } = body;

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

		captureHandle = beginConduitSessionCapture(
			'codex',
			{ agentId, workspaceId, pipelineId },
			prompt,
			model,
			undefined,
			context,
		);
		const session = await createHeadlessCliSession(
			'codex',
			prompt,
			workspace.path,
			model,
			(streamData) => {
				captureHandle?.handleStreamEvent(streamData);
			},
			captureHandle.conduitSessionId,
		);
		return c.json(finalizeConduitSessionRun('codex', captureHandle, session));
	} catch (error) {
		if (captureHandle) {
			const message = error instanceof Error ? error.message : 'Unknown error occurred';
			captureHandle.fail(message);
		}

		console.error('Error creating Codex session:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}
