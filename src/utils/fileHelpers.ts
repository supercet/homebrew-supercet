import fs from 'fs';
import path from 'path';

export interface FileMetadata {
	// Indentation settings
	indentationType: 'tabs' | 'spaces';
	indentSize: number; // 2, 4, 8 for spaces; tab width for tabs

	// Line ending style
	lineEndings: 'lf' | 'crlf' | 'cr';

	// Character encoding
	encoding: 'utf-8' | 'utf-16' | 'ascii';

	// Optional: detected from .editorconfig or IDE settings
	trimTrailingWhitespace?: boolean;
	insertFinalNewline?: boolean;
}

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

			// First read as buffer to detect encoding
			const buffer = fs.readFileSync(resolvedPath);
			const encoding = detectEncodingFromBuffer(buffer);

			// Convert buffer to string using detected encoding
			const content = buffer.toString(encoding);

			// Detect file metadata for CodeMirror
			const metadata = detectFileMetadata(resolvedPath, content);

			return {
				success: true,
				data: {
					content,
					metadata,
				},
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

			// Detect encoding from existing file if it exists, otherwise use UTF-8
			let encoding: BufferEncoding = 'utf8';
			if (fs.existsSync(resolvedPath)) {
				const buffer = fs.readFileSync(resolvedPath);
				encoding = detectEncodingFromBuffer(buffer);
			}

			// Write file contents using detected encoding
			fs.writeFileSync(resolvedPath, content, encoding);

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

/**
 * Detects file metadata for proper CodeMirror indentation rendering
 */
export function detectFileMetadata(filePath: string, content: string): FileMetadata {
	const metadata: FileMetadata = {
		indentationType: 'spaces',
		indentSize: 4,
		lineEndings: 'lf',
		encoding: 'utf-8',
	};

	// Detect indentation type and size from content
	const indentationInfo = detectIndentation(content);
	metadata.indentationType = indentationInfo.type;
	metadata.indentSize = indentationInfo.size;

	// Detect line endings
	metadata.lineEndings = detectLineEndings(content);

	// Detect encoding (simplified - assume UTF-8 for now)
	metadata.encoding = detectEncoding(filePath, content);

	// Check .editorconfig for additional settings
	const editorConfigSettings = parseEditorConfig(path.dirname(filePath));
	if (editorConfigSettings) {
		metadata.trimTrailingWhitespace = editorConfigSettings.trimTrailingWhitespace;
		metadata.insertFinalNewline = editorConfigSettings.insertFinalNewline;
	}

	// Check IDE settings
	const ideSettings = parseIDESettings(path.dirname(filePath));
	if (ideSettings) {
		// Override with IDE settings if available
		if (ideSettings.indentSize !== undefined) {
			metadata.indentSize = ideSettings.indentSize;
		}
		if (ideSettings.indentationType !== undefined) {
			metadata.indentationType = ideSettings.indentationType;
		}
	}

	return metadata;
}

/**
 * Detects indentation type and size from file content
 */
function detectIndentation(content: string): { type: 'tabs' | 'spaces'; size: number } {
	const lines = content.split('\n');
	let tabCount = 0;
	let spaceCount = 0;
	const spaceSizes = new Map<number, number>();

	for (const line of lines) {
		if (line.length === 0) continue;

		const leadingWhitespace = line.match(/^[\t ]+/);
		if (!leadingWhitespace) continue;

		const whitespace = leadingWhitespace[0];
		if (whitespace.includes('\t')) {
			tabCount++;
		} else {
			spaceCount++;
			const spaceSize = whitespace.length;
			spaceSizes.set(spaceSize, (spaceSizes.get(spaceSize) || 0) + 1);
		}
	}

	// Determine indentation type
	if (tabCount > spaceCount) {
		return { type: 'tabs', size: 4 }; // Default tab width
	} else {
		// Find most common space size
		let mostCommonSize = 4;
		let maxCount = 0;
		for (const [size, count] of spaceSizes) {
			if (count > maxCount) {
				maxCount = count;
				mostCommonSize = size;
			}
		}
		return { type: 'spaces', size: mostCommonSize };
	}
}

/**
 * Detects line ending style from file content
 */
function detectLineEndings(content: string): 'lf' | 'crlf' | 'cr' {
	if (content.includes('\r\n')) {
		return 'crlf';
	} else if (content.includes('\r')) {
		return 'cr';
	} else {
		return 'lf';
	}
}

/**
 * Detects file encoding (simplified implementation)
 */
function detectEncoding(filePath: string, content: string): 'utf-8' | 'utf-16' | 'ascii' {
	// Check for BOM
	if (content.startsWith('\ufeff')) {
		return 'utf-16';
	}

	// Check if content contains non-ASCII characters
	const hasNonAscii = /[^\x00-\x7F]/.test(content);
	if (hasNonAscii) {
		return 'utf-8';
	}

	return 'ascii';
}

/**
 * Detects file encoding from buffer (for use with fs.readFileSync)
 */
function detectEncodingFromBuffer(buffer: Buffer): BufferEncoding {
	// Check for BOM
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return 'utf8';
	}
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return 'utf16le';
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		return 'utf16le'; // Node.js uses utf16le for both, handles byte order internally
	}

	// Check if content contains non-ASCII characters
	const hasNonAscii = buffer.some((byte) => byte > 0x7f);
	if (hasNonAscii) {
		return 'utf8';
	}

	return 'ascii';
}

/**
 * Parses .editorconfig file for project settings
 */
function parseEditorConfig(dirPath: string): { trimTrailingWhitespace?: boolean; insertFinalNewline?: boolean } | null {
	try {
		const editorConfigPath = path.join(dirPath, '.editorconfig');
		if (!fs.existsSync(editorConfigPath)) {
			return null;
		}

		const content = fs.readFileSync(editorConfigPath, 'utf8');
		const lines = content.split('\n');
		const settings: Record<string, string> = {};

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith('#')) {
				const [key, value] = trimmed.split('=').map((s) => s.trim());
				if (key && value) {
					settings[key.toLowerCase()] = value.toLowerCase();
				}
			}
		}

		return {
			trimTrailingWhitespace: settings['trim_trailing_whitespace'] === 'true',
			insertFinalNewline: settings['insert_final_newline'] === 'true',
		};
	} catch (error) {
		return null;
	}
}

/**
 * Parses IDE settings files for project-specific configurations
 */
function parseIDESettings(dirPath: string): { indentSize?: number; indentationType?: 'tabs' | 'spaces' } | null {
	try {
		// Check for VS Code settings
		const vscodeSettingsPath = path.join(dirPath, '.vscode', 'settings.json');
		if (fs.existsSync(vscodeSettingsPath)) {
			const content = fs.readFileSync(vscodeSettingsPath, 'utf8');
			const settings = JSON.parse(content);

			return {
				indentSize: settings['editor.tabSize'] || settings['editor.insertSpaces'] ? 2 : 4,
				indentationType: settings['editor.insertSpaces'] ? 'spaces' : 'tabs',
			};
		}

		// Check for Prettier config
		const prettierConfigPath = path.join(dirPath, '.prettierrc');
		if (fs.existsSync(prettierConfigPath)) {
			const content = fs.readFileSync(prettierConfigPath, 'utf8');
			const config = JSON.parse(content);

			return {
				indentSize: config.tabWidth || 2,
				indentationType: config.useTabs ? 'tabs' : 'spaces',
			};
		}

		return null;
	} catch (error) {
		return null;
	}
}
