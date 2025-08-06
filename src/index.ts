import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { createServer } from "net";

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

// Check if port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, () => {
      server.close();
      resolve(true);
    });
    server.on("error", () => {
      resolve(false);
    });
  });
}

// Version check function
async function checkForUpdates(): Promise<void> {
  const currentVersion = process.env.SUPERCET_VERSION;

  if (!currentVersion) {
    console.warn("SUPERCET_VERSION environment variable not set");
    return;
  }

  try {
    // Fetch the latest release from GitHub
    const response = await fetch(
      "https://api.github.com/repos/supercet/homebrew-supercet/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!response.ok) {
      console.warn("Failed to fetch latest release information from GitHub");
      return;
    }

    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name?.replace(/^v/, ""); // Remove 'v' prefix if present

    if (!latestVersion) {
      console.warn(
        "Could not determine latest version from GitHub release data"
      );
      return;
    }

    console.log("\n");

    // Compare versions (simple string comparison for semantic versions)
    if (latestVersion !== currentVersion) {
      console.log("\n" + "=".repeat(60));
      console.log("🚀 A new version of Supercet is available!");
      console.log(`Current version: ${currentVersion}`);
      console.log(`Latest version:  ${latestVersion}`);
      console.log("To upgrade, run:");
      console.log("brew update && brew upgrade supercet");
      console.log("=".repeat(60) + "\n");
    } else {
      console.log("✨ You are on the latest version of Supercet ✨");
    }
  } catch (error) {
    console.warn("Error checking for updates:", error);
  }
}

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
  const portAvailable = await isPortAvailable(4444);
  if (!portAvailable) {
    throw new Error("Supercet is already running on port 4444");
  }

  serve(
    {
      fetch: app.fetch,
      port: 4444,
    },
    async (info) => {
      // Check for updates before displaying server info

      console.log(
        `\nSupercet version ${process.env.SUPERCET_VERSION} is running on http://localhost:${info.port}`
      );
      await checkForUpdates();

      console.log(
        "\n Review your local code changes at https://supercet.com/conduit"
      );
    }
  );
}

// Start the server
startServer().catch((error) => {
  console.error("❌ Failed to start server:", error.message);
  process.exit(1);
});
