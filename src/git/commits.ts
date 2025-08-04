import { git } from "../utils/gitWrapper";
import type { Context } from "hono";

export async function getCommits(c: Context) {
  try {
    const branch = c.req.query("branch");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const args = [branch, from, to].filter(
      (item) => item !== undefined && item !== null
    );
    let data;

    if (args.length) {
      data = await git.log(args);
    } else {
      data = await git.log();
    }
    return c.json(data);
  } catch (e) {
    console.error("failed git commit", e);
    return c.json({ error: "Failed to get commits" }, 500);
  }
}
