import type { PullRequestEvent } from "@octokit/webhooks-types";
import {
  getInstallationToken,
  enableAutoMerge,
  createComment,
  findBotComment,
  deleteComment,
} from "./github";

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

  const prNumber = payload.pull_request.number;

  console.log(`Processing Dependabot PR #${prNumber} in ${owner}/${repo}`);

  try {
    await enableAutoMerge(token, payload.pull_request.node_id);
    console.log(`Auto-merge enabled for PR #${prNumber}`);

    const existingComment = await findBotComment(token, env.APP_ID, owner, repo, prNumber);
    if (existingComment) {
      await deleteComment(token, owner, repo, existingComment);
      console.log(`Deleted setup comment on PR #${prNumber}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to enable auto-merge for PR #${prNumber}:`, message);

    await createComment(
      token,
      owner,
      repo,
      prNumber,
`**Mergerita could not enable auto-merge:** ${message}\n\nEnsure **Allow auto-merge** is enabled in repo settings and a branch protection rule with required status checks exists on the base branch. Then close and reopen this PR to retry.`,
    );
  }
}
