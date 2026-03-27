import { createAppAuth } from "@octokit/auth-app";

const GITHUB_API = "https://api.github.com";

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "mergerita",
  "X-GitHub-Api-Version": "2026-03-10",
};

export async function getInstallationToken(
  env: Pick<Cloudflare.Env, "APP_ID" | "PRIVATE_KEY">,
  installationId: number,
): Promise<string> {
  console.log(`Authenticating as installation ${installationId}`);
  const auth = createAppAuth({
    appId: env.APP_ID,
    privateKey: env.PRIVATE_KEY,
    installationId,
  });
  const { token } = await auth({ type: "installation" });
  console.log("Installation token obtained");
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
    const body = await res.text();
    console.error(`enableAutoMerge HTTP error: ${res.status} ${body}`);
    throw new Error(`Failed to enable auto-merge: ${res.status} ${body}`);
  }

  const data: { errors?: Array<{ message: string }> } = await res.json();
  if (data.errors) {
    console.error("enableAutoMerge GraphQL errors:", JSON.stringify(data.errors));
    throw new Error(`GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`);
  }

  console.log("enableAutoMerge succeeded");
}

export async function createComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        ...HEADERS,
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to create comment: ${res.status} ${await res.text()}`);
  }
}

export async function findBotComment(
  token: string,
  appId: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      headers: {
        ...HEADERS,
        Authorization: `bearer ${token}`,
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to list comments: ${res.status} ${await res.text()}`);
  }

  const comments: Array<{
    id: number;
    performed_via_github_app?: { id: number } | null;
  }> = await res.json();

  const appIdNum = Number(appId);
  const comment = comments.find(
    (c) => c.performed_via_github_app?.id === appIdNum,
  );
  return comment?.id ?? null;
}

export async function deleteComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "DELETE",
      headers: {
        ...HEADERS,
        Authorization: `bearer ${token}`,
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to delete comment: ${res.status} ${await res.text()}`);
  }
}
