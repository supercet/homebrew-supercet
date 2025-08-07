import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "node:http";
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

const PORT = 4444;

const app = new Hono();

// CORS middleware - allow requests from specified origins
app.use(
  "*",
  cors({
    origin: ["https://supercet.com"],
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
    const response = await fetch(
      "https://supercet.com/api/conduit/token/validate",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

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
      origin: ["https://supercet.com"],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Socket.IO event handlers
  io.on("connection", (socket) => {
    console.log(`🔌 WebSocket client connected: ${socket.id}`);

    // Handle client authentication
    socket.on("authenticate", (token: string) => {
      // Validate token (you can reuse the same validation logic)
      fetch("https://supercet.com/api/conduit/token/validate", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      })
        .then((response) => {
          if (response.status === 200) {
            socket.emit("authenticated", { success: true });
            console.log(`✅ WebSocket client authenticated: ${socket.id}`);
          } else {
            socket.emit("authenticated", {
              success: false,
              error: "Invalid token",
            });
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
    socket.on("git:remote", async (params: { name: string }) => {
      const result = await handleSocketGitOperation(
        () => gitOperations.remote(params.name),
        "get git remote"
      );
      socket.emit("git:remote:update", result);
    });

    // Handle git stage
    socket.on("git:stage", async (params: { files: string[] }) => {
      const result = await handleSocketGitOperation(
        () => gitOperations.stage(params.files),
        "stage git files"
      );
      socket.emit("git:stage:update", result);
    });

    // Handle git unstage
    socket.on("git:unstage", async (params: { files: string[] }) => {
      const result = await handleSocketGitOperation(
        () => gitOperations.unstage(params.files),
        "unstage git files"
      );
      socket.emit("git:unstage:update", result);
    });

    // Handle git commit
    socket.on("git:commit", async (params: { message: string }) => {
      const result = await handleSocketGitOperation(
        () => gitOperations.commit(params.message),
        "commit git changes"
      );
      socket.emit("git:commit:update", result);
    });

    // Handle git push
    socket.on(
      "git:push",
      async (params: { remote?: string; branch?: string }) => {
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
        const result = await handleSocketGitOperation(
          () => gitOperations.checkout(params.target, params.isFile || false),
          "checkout git branch"
        );
        socket.emit("git:checkout:update", result);
      }
    );

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log(`🔌 WebSocket client disconnected: ${socket.id}`);
    });
  });

  console.log(
    `Supercet version ${process.env.SUPERCET_VERSION} is running on http://localhost:${PORT}`
  );

  await checkForUpdates();
  // Check for updates
  console.log(
    "\n⮕ Review your local code changes at https://supercet.com/conduit"
  );
}

// Start the server
startServer().catch((error) => {
  console.error("❌ Failed to start server:", error.message);
  process.exit(1);
});
