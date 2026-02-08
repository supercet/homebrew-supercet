import { Context } from 'hono';
import { isValidUUID, resumeHeadlessCliSession } from '../utils/headlessCliHelpers';

/**
 * REST API handler to resume an existing Codex session
 * POST /api/codex/session/:sessionId/resume
 * Body: { prompt: string, workingDir?: string, model?: string }
 */
export async function resumeCodexSessionRoute(c: Context) {
	try {
		const sessionId = c.req.param('sessionId');
		const body = await c.req.json();
		const { prompt, workingDir, model } = body;

		if (!sessionId || typeof sessionId !== 'string') {
			return c.json({ error: 'Session ID is required and must be a string' }, 400);
		}

		if (!prompt || typeof prompt !== 'string') {
			return c.json({ error: 'Prompt is required and must be a string' }, 400);
		}

		if (model !== undefined && typeof model !== 'string') {
			return c.json({ error: 'Model must be a string' }, 400);
		}

		if (!isValidUUID(sessionId)) {
			return c.json({ error: 'Invalid session ID format (must be a valid UUID)' }, 400);
		}

		const targetDir = workingDir || process.cwd();
		const session = await resumeHeadlessCliSession('codex', sessionId, prompt, targetDir, model);

		return c.json({
			success: true,
			cli: 'codex',
			sessionId: session.sessionId,
			status: session.status,
			output: session.output,
			error: session.error.length > 0 ? session.error : undefined,
		});
	} catch (error) {
		console.error('Error resuming Codex session:', error);
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error occurred',
			},
			500,
		);
	}
}
