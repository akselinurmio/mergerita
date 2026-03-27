import { createAppAuth } from "@octokit/auth-app";

const GITHUB_API = "https://api.github.com";

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "mergerita",
  "X-GitHub-Api-Version": "2026-03-10",
};

export async function getInstallationToken(
  env: { APP_ID: string; PRIVATE_KEY: string },
  installationId: number,
): Promise<string> {
  const auth = createAppAuth({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    installationId,
  });
  const { token } = await auth({ type: "installation" });
  return token;
}

export async function enableAutoMerge(
  token: string,
  pullRequestNodeId: string,
): Promise<void> {
  const res = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      ...HEADERS,
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation EnableAutoMerge($prId: ID!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $prId
          mergeMethod: SQUASH
        }) {
          pullRequest {
            autoMergeRequest { enabledAt }
          }
        }
      }`,
      variables: { prId: pullRequestNodeId },
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to enable auto-merge: ${res.status} ${await res.text()}`);
  }

  const data: { errors?: Array<{ message: string }> } = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`);
  }
}
