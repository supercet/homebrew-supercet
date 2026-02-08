import { Context } from 'hono';
import { createHeadlessCliSession } from '../utils/headlessCliHelpers';

/**
 * REST API handler to create a new Codex session
 * POST /api/codex/session
 * Body: { prompt: string, workingDir?: string, model?: string }
 */
export async function createCodexSessionRoute(c: Context) {
	try {
		const body = await c.req.json();
		const { prompt, workingDir, model } = body;

		if (!prompt || typeof prompt !== 'string') {
			return c.json({ error: 'Prompt is required and must be a string' }, 400);
		}

		if (model !== undefined && typeof model !== 'string') {
			return c.json({ error: 'Model must be a string' }, 400);
		}

		const targetDir = workingDir || process.cwd();
		const session = await createHeadlessCliSession('codex', prompt, targetDir, model);

		return c.json({
			success: true,
			cli: 'codex',
			sessionId: session.sessionId,
			status: session.status,
			output: session.output,
			error: session.error.length > 0 ? session.error : undefined,
		});
	} catch (error) {
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
