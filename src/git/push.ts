import { git } from "../utils/gitWrapper";
import type { Context } from "hono";

type PushReqBody = {
  remote?: string;
  branch?: string;
};

export async function postPush(c: Context) {
  try {
    const data: PushReqBody = await c.req.json();
    const remote = data.remote || "origin";
    let branch = data.branch;

    if (!branch) {
      try {
        const branchRes = await git.branch();
        branch = branchRes.current;
      } catch (e) {
        console.error(`failed to get current branch : ${e}`);
        return c.json({ error: "Failed to get current branch" }, 500);
      }
    }

    try {
      console.log("pushing to ", remote, branch);
      await git.push(remote, branch);

      return c.json({}, 201);
    } catch (e) {
      console.error("failed git push", e);
      return c.json({ error: "Failed to push" }, 500);
    }
  } catch (e) {
    console.error(`push error : ${e}`);
    return c.json({ error: "Failed to push" }, 500);
  }
}
