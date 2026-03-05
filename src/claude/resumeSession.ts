import { Context } from 'hono';
import {
	beginConduitSessionCapture,
	isValidUUID,
	resolveSupportedCli,
	resumeHeadlessCliSession,
	validateConduitSessionRequestMetadata,
	type ConduitSessionCaptureHandle,
} from '../utils/headlessCliHelpers';
import { getConduitWorkspaceById } from '../db/sqlite';

/**
 * REST API handler to resume an existing headless CLI session
 * POST /api/claude/session/:sessionId/resume
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
export async function resumeSession(c: Context) {
	let captureHandle: ConduitSessionCaptureHandle | null = null;

	try {
		const sessionId = c.req.param('sessionId');
		const body = await c.req.json();
		const { prompt, context, cli: requestedCli, model, agentId, workspaceId, pipelineId } = body;

		if (!sessionId || typeof sessionId !== 'string') {
			return c.json({ error: 'Session ID is required and must be a string' }, 400);
		}

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

		if (!isValidUUID(sessionId)) {
			return c.json({ error: 'Invalid session ID format (must be a valid UUID)' }, 400);
		}

		const workspace = getConduitWorkspaceById(workspaceId);
		if (!workspace) {
			return c.json({ error: `Workspace '${workspaceId}' was not found` }, 400);
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
			sessionId,
			context,
		);
		const session = await resumeHeadlessCliSession(cli, sessionId, prompt, workspace.path, model, (streamData) => {
			captureHandle?.handleStreamEvent(streamData);
		});
		captureHandle.complete();

		return c.json({
			success: true,
			cli,
			conduitSessionId: captureHandle.conduitSessionId,
			sessionId: session.sessionId,
			status: session.status,
			output: session.output,
			error: session.error.length > 0 ? session.error : undefined,
		});
	} catch (error) {
		if (captureHandle) {
			const message = error instanceof Error ? error.message : 'Unknown error occurred';
			captureHandle.fail(message);
		}

		console.error('Error resuming CLI session:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}
