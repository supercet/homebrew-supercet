import type { Context } from 'hono';
import { validateAndDecodePath, handleFileOperation, fileOperations } from '../utils/fileHelpers';

export async function getFile(c: Context) {
	const rawFilePath = c.req.query('path');

	// Validate and decode path
	const pathValidation = validateAndDecodePath(rawFilePath || '');
	if (!pathValidation.isValid) {
		const statusCode = pathValidation.error?.includes('Access denied') ? 403 : 400;
		return c.json({ error: pathValidation.error }, statusCode);
	}

	// Perform file read operation
	const result = await handleFileOperation(
		() => fileOperations.readFile(decodeURIComponent(rawFilePath!), pathValidation.path!),
		'file:get',
	);

	if (!result.success) {
		const statusCode = result.error?.includes('File not found') ? 404 : 500;
		return c.json({ error: result.error }, statusCode);
	}

	return c.json(result);
}
