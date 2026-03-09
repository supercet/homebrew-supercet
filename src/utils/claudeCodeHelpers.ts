import { Socket } from 'socket.io';
import {
	createHeadlessCliSession,
	handleHeadlessSessionCreate,
	handleHeadlessSessionResume,
	HeadlessCliSession,
	isValidUUID,
	resumeHeadlessCliSession,
} from './headlessCliHelpers';

export { isValidUUID };

export async function createClaudeCodeSession(
	prompt: string,
	workingDir: string,
	streamCallback?: (data: {
		type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
		content: string;
	}) => void,
	model?: string,
): Promise<HeadlessCliSession> {
	return createHeadlessCliSession('claude', prompt, workingDir, model, streamCallback);
}

export async function resumeClaudeCodeSession(
	sessionId: string,
	prompt: string | undefined,
	workingDir: string,
	streamCallback?: (data: {
		type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
		content: string;
	}) => void,
	model?: string,
): Promise<HeadlessCliSession> {
	return resumeHeadlessCliSession('claude', sessionId, prompt, workingDir, model, streamCallback);
}

export function handleClaudeSessionCreate(socket: Socket) {
	handleHeadlessSessionCreate(socket, 'claude:session', 'claude');
}

export function handleClaudeSessionResume(socket: Socket) {
	handleHeadlessSessionResume(socket, 'claude:session', 'claude');
}

export async function createCodexSession(
	prompt: string,
	workingDir: string,
	streamCallback?: (data: {
		type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
		content: string;
	}) => void,
	model?: string,
): Promise<HeadlessCliSession> {
	return createHeadlessCliSession('codex', prompt, workingDir, model, streamCallback);
}

export async function resumeCodexSession(
	sessionId: string,
	prompt: string | undefined,
	workingDir: string,
	streamCallback?: (data: {
		type: 'stdout' | 'stderr' | 'sessionId' | 'complete' | 'error';
		content: string;
	}) => void,
	model?: string,
): Promise<HeadlessCliSession> {
	return resumeHeadlessCliSession('codex', sessionId, prompt, workingDir, model, streamCallback);
}

export function handleCodexSessionCreate(socket: Socket) {
	handleHeadlessSessionCreate(socket, 'codex:session', 'codex');
}

export function handleCodexSessionResume(socket: Socket) {
	handleHeadlessSessionResume(socket, 'codex:session', 'codex');
}
