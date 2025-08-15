import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

export async function getSymbolicRef(c: Context) {
  try {
    const { remote, ref } = c.req.query();
    const branchRes = await gitOperations.symbolicRef(remote, ref);

    return c.json(branchRes);
  } catch (e) {
    console.error(`failed to get symbolic ref : ${e}`);
    return c.json({ error: "Failed to get symbolic ref" }, 500);
  }
}
