import type { Octokit } from "octokit";

export async function enableAutoMerge(
  octokit: Octokit,
  pullRequestNodeId: string,
): Promise<void> {
  await octokit.graphql(
    `mutation EnableAutoMerge($prId: ID!) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $prId
        mergeMethod: SQUASH
      }) {
        pullRequest {
          autoMergeRequest { enabledAt }
        }
      }
    }`,
    { prId: pullRequestNodeId },
  );

  console.log("enableAutoMerge succeeded");
}
