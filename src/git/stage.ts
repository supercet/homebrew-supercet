import { git } from "../utils/gitWrapper";
import type { Context } from "hono";

type StageReqBody = {
  files: string[];
  areFilesUntracked: boolean;
};

export async function postStage(c: Context) {
  try {
    const data: StageReqBody = await c.req.json();

    if (data?.files?.length) {
      try {
        if (data.areFilesUntracked) {
          data.files.unshift("-N");
        }
        await git.add(data.files);

        return c.json({}, 200);
      } catch (e) {
        console.error("failed git add", e);
        return c.json({ error: "Failed to stage files" }, 500);
      }
    } else {
      return c.json({ error: "No files provided" }, 400);
    }
  } catch (e) {
    console.error(`stage error : ${e}`);
    return c.json({ error: "Failed to stage files" }, 500);
  }
}
