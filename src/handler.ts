import type { PullRequestEvent } from "@octokit/webhooks-types";
import { getInstallationToken, enableAutoMerge } from "./github";

export async function handlePullRequest(payload: PullRequestEvent, env: Cloudflare.Env) {
  if (payload.action !== "opened" && payload.action !== "reopened") {
    console.log(`Skipped: action is "${payload.action}", not opened/reopened`);
    return;
  }

  if (payload.pull_request.user.login !== "dependabot[bot]") {
    console.log(`Skipped: author is "${payload.pull_request.user.login}", not dependabot[bot]`);
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
