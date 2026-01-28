import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';

export interface SocketGitResponse {
	success: boolean;
	data?: unknown;
	error?: string;
}

const options: Partial<SimpleGitOptions> = {
	baseDir: process.cwd(),
	binary: 'git',
	maxConcurrentProcesses: 6,
	trimmed: false,
};

export const git: SimpleGit = simpleGit(options);

/**
 * Sanitize data to remove circular references and make it JSON-serializable
 * This prevents "Maximum call stack size exceeded" errors when sending over Socket.IO
 */
function sanitizeForJSON(data: unknown, depth = 0, maxDepth = 50): unknown {
	// Prevent infinite recursion
	if (depth > maxDepth) {
		console.warn('Maximum depth reached in sanitizeForJSON, returning null');
		return null;
	}

	if (data === null || data === undefined) {
		return data;
	}

	// If it's a primitive, return as-is
	if (typeof data !== 'object') {
		return data;
	}

	// If it's already a string, return as-is
	if (typeof data === 'string') {
		return data;
	}

	// Use a seen set to detect circular references
	const seen = new WeakSet();

	function removeCircular(obj: unknown, currentDepth = 0): unknown {
		if (currentDepth > maxDepth) {
			return null;
		}

		if (obj === null || obj === undefined) {
			return obj;
		}

		// Primitives
		if (typeof obj !== 'object') {
			return obj;
		}

		// Check for circular reference
		if (seen.has(obj)) {
			return '[Circular]';
		}

		seen.add(obj);

		// Handle arrays
		if (Array.isArray(obj)) {
			return obj.map(item => removeCircular(item, currentDepth + 1));
		}

		// Handle plain objects
		const result: Record<string, unknown> = {};
		if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
			for (const key in obj) {
				if (Object.prototype.hasOwnProperty.call(obj, key)) {
					try {
						result[key] = removeCircular(
							(obj as Record<string, unknown>)[key],
							currentDepth + 1,
						);
					} catch (error) {
						result[key] = '[Error]';
					}
				}
			}
		}

		return result;
	}

	try {
		return removeCircular(data, depth);
	} catch (error) {
		console.error('Failed to sanitize git operation result:', error);
		// Return a simple error object instead of the original data
		return { error: 'Failed to serialize data', type: typeof data };
	}
}

/**
 * Generic git operation handler that wraps any git function with try/catch
 */
export async function handleSocketGitOperation<T>(
	operation: () => Promise<T>,
	operationName: string,
): Promise<SocketGitResponse> {
	try {
		const result = await operation();

		// Sanitize the result FIRST to prevent circular reference errors
		const sanitizedResult = sanitizeForJSON(result);

		// Now safely stringify the sanitized result
		let sanitizedSize = 0;
		try {
			sanitizedSize = JSON.stringify(sanitizedResult).length;

		} catch (e) {
			console.warn(`[GitOperation] ${operationName}: Failed to measure size`);
		}

		// Add debugging metadata
		return {
			success: true,
			data: sanitizedResult,
		};
	} catch (error: unknown) {
		console.error(`[GitOperation] ${operationName} failed:`, error);
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed for ${operationName.toLowerCase()}: ${errorMessage}`,
		};
	}
}

/**
 * Git operation functions that can be passed to the generic handler
 */
export const gitOperations = {
	status: async () => await git.status(),

	branches: async () => await git.branch(['-l']),

	commits: async (branch?: string, from?: string, to?: string) => {
		const args = [branch, from, to].filter((item) => item !== undefined && item !== null);
		return args.length ? await git.log(args) : await git.log();
	},

	diff: async (from?: string, to?: string) => {
		// '-w', '--ignore-space-at-eol' ignores whitespace but still renders the no newline at end of file marker
		const args = [from, to, '-w', '--ignore-space-at-eol', '-U5'].filter(
			(val) => val !== undefined && val !== null && val !== '',
		) as string[];
		return args.length ? await git.diff(args) : await git.diff();
	},

	remotes: async () => {
		const remotes = await git.remote(['show']);
		if (typeof remotes === 'string') {
			return remotes.trim();
		}
		return remotes;
	},

	remote: async (remoteName: string) => {
		const remote = await git.remote(['get-url', remoteName]);
		if (typeof remote === 'string') {
			return remote.trim();
		}
		return remote;
	},
	revParse: async (ref: string, remote?: string) => {
		const args = remote ? [`${remote}/${ref}`] : [ref];
		return await git.revparse(args);
	},

	stage: async (files: string[], areFilesUntracked: boolean = false) => {
		if (areFilesUntracked) {
			files.unshift('-N');
		}
		return await git.add(files);
	},

	symbolicRef: async (remote: string, ref: string = 'HEAD') => {
		const symbolicRef = await git.raw(['symbolic-ref', '--short', `refs/remotes/${remote}/${ref}`]);
		if (typeof symbolicRef === 'string') {
			return symbolicRef.trim();
		}
		return symbolicRef;
	},

	unstage: async (files: string[]) => await git.reset(['--', ...files]),

	commit: async (message: string) => await git.commit(message),

	push: async (remote?: string, branch?: string) => {
		let targetBranch = branch;
		if (!targetBranch) {
			const branchRes = await git.branch();
			targetBranch = branchRes.current;
		}

		return git.push(remote, targetBranch);
	},

	checkout: async (target: string, isNew: boolean = false) => {
		if (isNew) {
			return await git.checkout(['-b', target]);
		}
		return await git.checkout([target]);
	},
};
