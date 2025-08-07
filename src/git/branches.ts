import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

export async function getBranches(c: Context) {
  try {
    const branchRes = await gitOperations.branches();

    return c.json(branchRes);
  } catch (e) {
    console.error(`failed to get branches : ${e}`);
    return c.json({ error: "Failed to get branches" }, 500);
  }
}
