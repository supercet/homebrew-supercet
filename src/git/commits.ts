import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

export async function getCommits(c: Context) {
  try {
    const branch = c.req.query("branch");
    const from = c.req.query("from");
    const to = c.req.query("to");

    const data = await gitOperations.commits(branch, from, to);

    return c.json(data);
  } catch (e) {
    console.error("failed git commit", e);
    return c.json({ error: "Failed to get commits" }, 500);
  }
}
