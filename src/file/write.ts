import type { Context } from 'hono';
import { validateAndDecodePath, handleFileOperation, fileOperations } from '../utils/fileHelpers';

export async function writeFile(c: Context) {
	const body = await c.req.json();
	const { path: rawFilePath, content } = body;

	// Validate and decode path
	const pathValidation = validateAndDecodePath(rawFilePath);
	if (!pathValidation.isValid) {
		const statusCode = pathValidation.error?.includes('Access denied') ? 403 : 400;
		return c.json({ error: pathValidation.error }, statusCode);
	}

	// Perform file write operation
	const result = await handleFileOperation(
		() => fileOperations.writeFile(decodeURIComponent(rawFilePath), pathValidation.path!, content),
		'file:write',
	);

	if (!result.success) {
		const statusCode = result.error?.includes('Content is required') ? 400 : 500;
		return c.json({ error: result.error }, statusCode);
	}

	return c.json(result);
}
