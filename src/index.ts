import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "node:http";
import pty from "node-pty";
import os from "os";
import fs from "fs";
import "dotenv/config";

import { handleSocketGitOperation, gitOperations } from "./utils/gitHelpers";
import { isPortAvailable, checkForUpdates } from "./utils/routeHelpers";

// Import git route handlers
import { getBranches } from "./git/branches";
import { postCheckout } from "./git/checkout";
import { postCommit } from "./git/commit";
import { getCommits } from "./git/commits";
import { getDiff } from "./git/diff";
import { postPush } from "./git/push";
import { getRemote } from "./git/remote";
import { getRemotes } from "./git/remotes";
import { postStage } from "./git/stage";
import { getStatus } from "./git/status";
import { postUnstage } from "./git/unstage";
import { getRevParse } from "./git/revParse";
import { getSymbolicRef } from "./git/symbolicRef";

const PORT = 4444;
const HOST = process.env.SUPERCET_URL || "https://supercet.com";

/**
 * Interface for tracking authenticated socket connections with token expiration management.
 * This allows the server to automatically notify clients when their tokens are about to expire.
 */
interface AuthenticatedSocket {
  socketId: string;
  tokenExpiration: number;
  refreshTimeout: NodeJS.Timeout;
}

// Map to store authenticated socket information
const authenticatedSockets = new Map<string, AuthenticatedSocket>();

const app = new Hono();

function ensurePath(input?: string): string {
  const fallback = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const parts = new Set((input || "").split(":").filter(Boolean).concat(fallback));
  return Array.from(parts).join(":");
}

function pickShell(): string {
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(Boolean) as string[];
  return candidates.find(shell => shell.startsWith("/") && fs.existsSync(shell)) || "/bin/sh";
}

function pickCwd(): string {
  const candidates = [process.cwd(), process.env.HOME, os.homedir?.(), "/tmp", "/"].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {}
  }
  return "/";
}

function buildEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string")
  ) as Record<string, string>;
  
  return {
    ...env,
    PATH: ensurePath(env.PATH),
    HOME: env.HOME || os.homedir?.() || "/",
    SHELL: env.SHELL || "/bin/zsh",
    TERM: env.TERM || "xterm-256color",
    LANG: env.LANG || "en_US.UTF-8",
    LC_ALL: env.LC_ALL || "en_US.UTF-8",
  };
}

function shellArgsFor(file: string): string[] {
  if (file.endsWith("/zsh")) return ["-i"]; // interactive
  if (file.endsWith("/bash")) return ["--login"]; // login
  if (file.endsWith("/sh")) return []; // minimal
  return []; // safe default
}

export function spawnLoginShell(cols = 80, rows = 24) {
  const file = pickShell();
  const cwd = pickCwd();
  const env = buildEnv();

  // Verify shell is executable
  fs.accessSync(file, fs.constants.X_OK);

  const p = pty.spawn(file, shellArgsFor(file), {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });
  return p;
}

// CORS middleware - allow requests from specified origins
app.use(
  "*",
  cors({
    origin: [HOST],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Authentication middleware
app.use("*", async (c, next) => {
  const authHeader = c.req.header("authorization");

  if (!authHeader) {
    return c.json({ error: "Authorization header is required" }, 401);
  }

  // Extract token from Authorization header (supports "Bearer <token>" or just "<token>")
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader;

  if (!token) {
    return c.json({ error: "Invalid authorization header format" }, 401);
  }

  try {
    // Make request to Supercet API to validate token
    const response = await fetch(`${HOST}/api/conduit/token/validate`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 200) {
      // Token is valid, continue with the request
      await next();
    } else {
      // Token validation failed
      return c.json(response, response.status as ContentfulStatusCode);
    }
  } catch (error) {
    // Network error or other issues
    return c.json({ error }, 500);
  }
});

// Git routes
app.get("/api/git/branches", getBranches);
app.post("/api/git/checkout", postCheckout);
app.post("/api/git/commit", postCommit);
app.get("/api/git/commits", getCommits);
app.get("/api/git/diff", getDiff);
app.post("/api/git/push", postPush);
app.post("/api/git/stage", postStage);
app.get("/api/git/status", getStatus);
app.post("/api/git/unstage", postUnstage);
app.get("/api/git/remote", getRemote);
app.get("/api/git/remotes", getRemotes);
app.get("/api/git/rev-parse", getRevParse);
app.get("/api/git/symbolic-ref", getSymbolicRef);

// Heartbeat route
app.get("/api/heartbeat", (c) => {
  return c.json(null, 200);
});

// Start server
async function startServer() {
  // Check if port is already in use
  const portAvailable = await isPortAvailable(PORT);
  if (!portAvailable) {
    throw new Error(`Supercet is already running on port ${PORT}`);
  }

  // Create HTTP server using Hono's serve function
  const httpServer = serve({
    fetch: app.fetch,
    port: PORT,
  });

  // Create Socket.IO server
  const io = new SocketIOServer(httpServer as HTTPServer, {
    cors: {
      origin: [HOST],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  /**
   * Schedules a token refresh notification to be sent 3 seconds before the token expires.
   * @param socketId - The ID of the socket to send the refresh notification to
   * @param expirationTime - The timestamp when the token expires
   * @returns A timeout handle that can be used to cancel the scheduled refresh
   */
  function scheduleTokenRefresh(socketId: string, expirationTime: number) {
    const now = Date.now();
    const timeUntilRefresh = expirationTime - now - 3000;

    const sendTokenRefresh = () => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit("token:refresh");

        // Set a 5-second expectation for re-authentication
        const authExpectationTimeout = setTimeout(() => {
          socket.disconnect(true);
        }, 5000);

        // Store the expectation timeout so it can be cleared if re-authentication occurs
        socket.data.authExpectationTimeout = authExpectationTimeout;
      }
      // Remove from authenticated sockets (safe to call even if key doesn't exist)
      authenticatedSockets.delete(socketId);
    };

    if (timeUntilRefresh <= 0) {
      // Token expires in less than 3 seconds, send refresh immediately
      sendTokenRefresh();
      return;
    }

    const timeout = setTimeout(() => sendTokenRefresh(), timeUntilRefresh);

    return timeout;
  }

  // Socket.IO event handlers
  io.on("connection", (socket) => {
    console.log(`🔌 WebSocket client connected: ${socket.id}`);

    // Handle client authentication
    socket.on("authenticate", (token: string) => {
      // Clear any existing auth expectation timeout
      if (socket.data.authExpectationTimeout) {
        clearTimeout(socket.data.authExpectationTimeout);
        socket.data.authExpectationTimeout = null;
      }

      // Validate token (you can reuse the same validation logic)
      fetch(`${HOST}/api/conduit/token/validate`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      })
        .then(async (response) => {
          if (response.status === 200) {
            // Parse the response to get token expiration
            const responseData = await response.json();
            let expirationTime: number = Date.now() + 60 * 1000; // Default to 1 minute

            // Try to extract expiration from various possible response formats
            if (responseData.expiresAt) {
              // Handle Unix timestamp in seconds (multiply by 1000) or ISO string
              const expiresAt = responseData.expiresAt;
              if (typeof expiresAt === "number") {
                // Unix timestamp in seconds - convert to milliseconds
                expirationTime = expiresAt * 1000;
              }
            }

            // Clear any existing timeout for this socket
            const existingAuth = authenticatedSockets.get(socket.id);
            if (existingAuth?.refreshTimeout) {
              clearTimeout(existingAuth.refreshTimeout);
            }

            // Schedule token refresh
            const refreshTimeout = scheduleTokenRefresh(
              socket.id,
              expirationTime
            );

            // Store authenticated socket information
            authenticatedSockets.set(socket.id, {
              socketId: socket.id,
              tokenExpiration: expirationTime,
              refreshTimeout: refreshTimeout!,
            });

            socket.emit("authenticated", { success: true });
          } else {
            socket.emit("authenticated", {
              success: false,
              error: "Invalid token",
            });
            console.log(
              `❌ WebSocket client authentication failed: invalid token`
            );
          }
        })
        .catch((error) => {
          console.error("Authentication failed:", error);
          socket.emit("authenticated", {
            success: false,
            error: "Authentication failed",
          });
        });
    });

    // Handle git status updates
    socket.on("git:status", async () => {
      const result = await handleSocketGitOperation(
        gitOperations.status,
        "get git status"
      );
      socket.emit("git:status:update", result);
    });

    // Handle git branches
    socket.on("git:branches", async () => {
      const result = await handleSocketGitOperation(
        gitOperations.branches,
        "get git branches"
      );
      socket.emit("git:branches:update", result);
    });

    // Handle git commits
    socket.on(
      "git:commits",
      async (params: { branch?: string; from?: string; to?: string }) => {
        const result = await handleSocketGitOperation(
          () => gitOperations.commits(params.branch, params.from, params.to),
          "get git commits"
        );
        socket.emit("git:commits:update", result);
      }
    );

    // Handle git diff
    socket.on("git:diff", async (params: { from?: string; to?: string }) => {
      const result = await handleSocketGitOperation(
        () => gitOperations.diff(params.from, params.to),
        "get git diff"
      );
      socket.emit("git:diff:update", result);
    });

    // Handle git remotes
    socket.on("git:remotes", async () => {
      const result = await handleSocketGitOperation(
        gitOperations.remotes,
        "get git remotes"
      );
      socket.emit("git:remotes:update", result);
    });

    // Handle git remote
    socket.on("git:remote", async (params: { remote: string }) => {
      if (!params?.remote) {
        socket.emit("git:remote:update", {
          success: false,
          error: "Remote name is required",
        });
        return;
      }

      const result = await handleSocketGitOperation(
        () => gitOperations.remote(params.remote),
        "get git remote"
      );
      socket.emit("git:remote:update", result);
    });

    // Handle git stage
    socket.on(
      "git:stage",
      async (params: { files: string[]; areFilesUntracked: boolean }) => {
        if (!params?.files?.length) {
          socket.emit("git:stage:update", {
            success: false,
            error: "Files array is required",
          });
          return;
        }

        const result = await handleSocketGitOperation(
          () => gitOperations.stage(params.files, params.areFilesUntracked),
          "stage git files"
        );
        socket.emit("git:stage:update", result);
      }
    );

    // Handle git unstage
    socket.on("git:unstage", async (params: { files: string[] }) => {
      if (!params?.files?.length) {
        socket.emit("git:unstage:update", {
          success: false,
          error: "Files array is required",
        });
        return;
      }

      const result = await handleSocketGitOperation(
        () => gitOperations.unstage(params.files),
        "unstage git files"
      );
      socket.emit("git:unstage:update", result);
    });

    // Handle git commit
    socket.on("git:commit", async (params: { message: string }) => {
      if (!params?.message) {
        socket.emit("git:commit:update", {
          success: false,
          error: "Commit message is required",
        });
        return;
      }

      const result = await handleSocketGitOperation(
        () => gitOperations.commit(params.message),
        "commit git changes"
      );
      socket.emit("git:commit:update", result);
    });

    // Handle git push
    socket.on(
      "git:push",
      async (params: { remote: string; branch: string }) => {
        if (!params?.remote || !params?.branch) {
          socket.emit("git:push:update", {
            success: false,
            error: "Remote and branch are required",
          });
          return;
        }
        const result = await handleSocketGitOperation(
          () => gitOperations.push(params.remote, params.branch),
          "push git changes"
        );
        socket.emit("git:push:update", result);
      }
    );

    // Handle git checkout
    socket.on(
      "git:checkout",
      async (params: { target: string; isFile?: boolean }) => {
        if (!params?.target) {
          socket.emit("git:checkout:update", {
            success: false,
            error: "Target is required",
          });
          return;
        }

        const result = await handleSocketGitOperation(
          () => gitOperations.checkout(params.target, params.isFile || false),
          "checkout git branch"
        );
        socket.emit("git:checkout:update", result);
      }
    );

    // Handle git revParse
    socket.on(
      "git:rev-parse",
      async (params: { ref: string; remote?: string }) => {
        const result = await handleSocketGitOperation(
          () => gitOperations.revParse(params.ref, params.remote),
          "rev parse git ref"
        );
        socket.emit("git:rev-parse:update", result);
      }
    );

    // Handle git symbolicRef
    socket.on(
      "git:symbolic-ref",
      async (params: { remote: string; ref?: string }) => {
        const result = await handleSocketGitOperation(
          () => gitOperations.symbolicRef(params.remote, params.ref),
          "symbolic ref git remote"
        );
        socket.emit("git:symbolic-ref:update", result);
      }
    );

    const cols = 80, rows = 24;

    const ptyProcess = spawnLoginShell(cols, rows);
    // Server -> Client: stream data
    ptyProcess.onData((data) => {
      socket.emit("terminal:data", data);
    });

    // Client -> Server: user input
    socket.on("terminal:input", (data: string) => {
      ptyProcess.write(data);
    });

    // Resize from client
    socket.on(
      "terminal:resize",
      ({ cols, rows }: { cols: number; rows: number }) => {
        if (cols && rows) ptyProcess.resize(cols, rows);
      }
    );

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log(`WebSocket client disconnected: ${socket.id}`);

      // Clean up authenticated socket tracking
      const existingAuth = authenticatedSockets.get(socket.id);
      if (existingAuth?.refreshTimeout) {
        clearTimeout(existingAuth.refreshTimeout);
      }
      authenticatedSockets.delete(socket.id);

      // Clean up auth expectation timeout
      if (socket.data.authExpectationTimeout) {
        clearTimeout(socket.data.authExpectationTimeout);
        socket.data.authExpectationTimeout = null;
      }
    });
  });

  console.log(
    `Supercet version ${process.env.SUPERCET_VERSION} is running on http://localhost:${PORT}`
  );

  await checkForUpdates();
  // Check for updates
  console.log(`\n⮕ Review your local code changes at ${HOST}/conduit`);
}

// Start the server
startServer().catch((error) => {
  console.error("❌ Failed to start server:", error.message);
  process.exit(1);
});
