import { Context } from 'hono';
import { createClaudeCodeSession } from '../utils/claudeCodeHelpers';

/**
 * REST API handler to create a new Claude Code session
 * POST /api/claude/session
 * Body: { prompt: string, workingDir?: string }
 */
export async function createSession(c: Context) {
  try {
    const body = await c.req.json();
    const { prompt, workingDir } = body;

    if (!prompt || typeof prompt !== 'string') {
      return c.json({ error: 'Prompt is required and must be a string' }, 400);
    }

    // Use provided working directory or default to current process working directory
    const targetDir = workingDir || process.cwd();

    // Create the Claude Code session (non-streaming for REST)
    const session = await createClaudeCodeSession(prompt, targetDir);

    return c.json({
      success: true,
      sessionId: session.sessionId,
      status: session.status,
      output: session.output,
      error: session.error.length > 0 ? session.error : undefined
    });
  } catch (error) {
    console.error('Error creating Claude Code session:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      500
    );
  }
}
