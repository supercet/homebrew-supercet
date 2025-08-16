import fs from 'fs';
import path from 'path';

export interface FileOperationResponse {
	success: boolean;
	data?: unknown;
	error?: string;
}

/**
 * Validates and decodes a file path, ensuring it's within the working directory
 */
export function validateAndDecodePath(rawPath: string): { isValid: boolean; path?: string; error?: string } {
	if (!rawPath) {
		return { isValid: false, error: 'Path is required' };
	}

	const decodedPath = decodeURIComponent(rawPath);
	const resolvedPath = path.resolve(process.cwd(), decodedPath);

	// Security check: ensure the resolved path is within the current working directory
	if (!resolvedPath.startsWith(process.cwd())) {
		return { isValid: false, error: 'Access denied: path outside working directory' };
	}

	return { isValid: true, path: resolvedPath };
}

/**
 * Generic file operation handler that wraps file operations with try/catch
 */
export async function handleFileOperation(
	operation: () => FileOperationResponse,
	operationName: string,
): Promise<FileOperationResponse> {
	try {
		return operation();
	} catch (error) {
		console.error(`${operationName} error: ${error}`);
		return {
			success: false,
			error: `Failed to ${operationName.toLowerCase()}`,
		};
	}
}

/**
 * File operation functions that can be passed to the generic handler
 */
export const fileOperations = {
	readFile: (originalPath: string, resolvedPath: string): FileOperationResponse => {
		try {
			// Check if file exists
			if (!fs.existsSync(resolvedPath)) {
				return {
					success: false,
					error: 'File not found',
				};
			}

			// Check if it's actually a file (not a directory)
			const stats = fs.statSync(resolvedPath);
			if (!stats.isFile()) {
				return {
					success: false,
					error: 'File not found',
				};
			}

			// Read file contents
			const content = fs.readFileSync(resolvedPath, 'utf8');

			return {
				success: true,
				data: content,
			};
		} catch (error) {
			return {
				success: false,
				error: `Failed to read ${originalPath}: ${error}`,
			};
		}
	},

	writeFile: (originalPath: string, resolvedPath: string, content: string): FileOperationResponse => {
		try {
			if (content === undefined || content === null) {
				return {
					success: false,
					error: 'Content is required',
				};
			}

			// Ensure the directory exists
			const dirPath = path.dirname(resolvedPath);
			if (!fs.existsSync(dirPath)) {
				fs.mkdirSync(dirPath, { recursive: true });
			}

			// Write file contents
			fs.writeFileSync(resolvedPath, content, 'utf8');

			return {
				success: true,
			};
		} catch (error) {
			return {
				success: false,
				error: `Failed to write ${originalPath}: ${error}`,
			};
		}
	},
};
