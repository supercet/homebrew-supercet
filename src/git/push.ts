import { gitOperations } from "../utils/gitHelpers";
import type { Context } from "hono";

type PushReqBody = {
  remote?: string;
  branch?: string;
};

export async function postPush(c: Context) {
  try {
    const data: PushReqBody = await c.req.json();
    const remote = data.remote || "origin";
    const branch = data.branch;

    try {
      console.log("pushing to ", remote, branch);
      await gitOperations.push(remote, branch);

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
