import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

// Import git route handlers
import { getBranches } from "./git/branches";
import { postCheckout } from "./git/checkout";
import { postCommit } from "./git/commit";
import { getCommits } from "./git/commits";
import { getDiff } from "./git/diff";
import { postPush } from "./git/push";
import { postStage } from "./git/stage";
import { getStatus } from "./git/status";
import { postUnstage } from "./git/unstage";

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
  console.log("Authentication middleware starting");
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
      return response;
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

// Start server
serve(
  {
    fetch: app.fetch,
    port: 4444,
  },
  (info) => {
    console.log(`Supercet Conduit is running on http://localhost:${info.port}`);
  }
);
