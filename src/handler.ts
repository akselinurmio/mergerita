import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { Env } from "./types";
import { getInstallationToken, enableAutoMerge } from "./github";

export async function handlePullRequest(payload: PullRequestEvent, env: Env) {
  if (payload.action !== "opened" && payload.action !== "reopened") {
    return;
  }

  if (payload.pull_request.user.login !== "dependabot[bot]") {
    return;
  }

  if (!payload.installation) {
    throw new Error("Missing installation in webhook payload");
  }

  const token = await getInstallationToken(env, payload.installation.id);
  const [owner, repo] = payload.repository.full_name.split("/");

  console.log(`Processing Dependabot PR #${payload.pull_request.number} in ${owner}/${repo}`);

  await enableAutoMerge(token, payload.pull_request.node_id);

  console.log(`Auto-merge enabled for PR #${payload.pull_request.number}`);
}
