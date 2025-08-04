import { git } from "../utils/gitWrapper";
import type { Context } from "hono";

export async function getBranches(c: Context) {
  try {
    // -l ignores remote branches
    const branchRes = await git.branch(["-l"]);
    return c.json(branchRes);
  } catch (e) {
    console.error(`failed to get branches : ${e}`);
    return c.json({ error: "Failed to get branches" }, 500);
  }
}
