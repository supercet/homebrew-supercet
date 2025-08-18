import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';

export interface SocketGitResponse {
	success: boolean;
	data?: any;
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
 * Generic git operation handler that wraps any git function with try/catch
 */
export async function handleSocketGitOperation<T>(
	operation: () => Promise<T>,
	operationName: string,
): Promise<SocketGitResponse> {
	try {
		const result = await operation();
		return {
			success: true,
			data: result,
		};
	} catch (error) {
		return {
			success: false,
			error: `Failed for ${operationName.toLowerCase()}: ${error}`,
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
