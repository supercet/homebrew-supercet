import { git } from "../utils/gitWrapper";
import type { Context } from "hono";

interface GitHubRepo {
  owner: string;
  repo: string;
}

function parseGitHubUrl(url: string): GitHubRepo | null {
  // Handle git@ style URLs: git@github.com:owner/repo.git
  const gitSshMatch = url.match(
    /git@.*github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (gitSshMatch) {
    return {
      owner: gitSshMatch[1],
      repo: gitSshMatch[2].replace(/\.git\n/, ""),
    };
  }

  // Handle https:// style URLs: https://github.com/owner/repo.git
  const httpsMatch = url.match(
    /https:\/\/.*github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2].replace(/\.git\n/, ""),
    };
  }

  return null;
}

export async function getRemote(c: Context) {
  const remote = c.req.query("remote") || "origin";
  try {
    const remoteRes = await git.remote(["get-url", remote]);
    if (!remoteRes) {
      return c.json(null, 404);
    }

    const parsedRepo = parseGitHubUrl(remoteRes);
    if (parsedRepo) {
      return c.json(parsedRepo);
    } else {
      console.error(`failed to parse github url from remote ${remote}`);
      return c.json(null, 400);
    }
  } catch (e) {
    console.error(`failed to get remote url ${remote} : ${e}`);
    return c.json(null, 500);
  }
}
