import { Context } from 'hono';
import { resumeClaudeCodeSession, isValidUUID } from '../utils/claudeCodeHelpers';

/**
 * REST API handler to resume an existing Claude Code session
 * POST /api/claude/session/:sessionId/resume
 * Body: { prompt: string, workingDir?: string }
 */
export async function resumeSession(c: Context) {
  try {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json();
    const { prompt, workingDir } = body;

    if (!sessionId || typeof sessionId !== 'string') {
      return c.json({ error: 'Session ID is required and must be a string' }, 400);
    }

    if (!prompt || typeof prompt !== 'string') {
      return c.json({ error: 'Prompt is required and must be a string' }, 400);
    }

    // Validate session ID format (UUID) - use shared validation function
    if (!isValidUUID(sessionId)) {
      return c.json({ error: 'Invalid session ID format (must be a valid UUID)' }, 400);
    }

    // Use provided working directory or default to current process working directory
    const targetDir = workingDir || process.cwd();

    // Resume the Claude Code session (non-streaming for REST)
    const session = await resumeClaudeCodeSession(sessionId, prompt, targetDir);

    return c.json({
      success: true,
      sessionId: session.sessionId,
      status: session.status,
      output: session.output,
      error: session.error.length > 0 ? session.error : undefined
    });
  } catch (error) {
    console.error('Error resuming Claude Code session:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      500
    );
  }
}
