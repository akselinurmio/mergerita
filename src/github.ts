import type { App, Octokit } from "octokit";

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

export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const resp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
    }),
  });
  if (!resp.ok) throw new Error("Token exchange failed");
  const data = (await resp.json()) as { access_token?: string; error?: string };
  if (!data.access_token)
    throw new Error(data.error ?? "Token exchange failed");
  return data.access_token;
}

export async function revokeOAuthToken(
  clientId: string,
  clientSecret: string,
  accessToken: string,
): Promise<void> {
  const resp = await fetch(
    `https://api.github.com/applications/${clientId}/token`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );
  if (!resp.ok && resp.status !== 422) {
    throw new Error(`Token revocation failed: ${resp.status}`);
  }
}

export async function fetchAuthenticatedLogin(
  octokit: Octokit,
): Promise<string> {
  const { data: user } = await octokit.rest.users.getAuthenticated();
  return user.login;
}

export type RepoGql = {
  autoMergeAllowed: boolean;
  branchProtectionRules: { totalCount: number };
  rulesets: { totalCount: number };
} | null;

export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  graphql: RepoGql;
}

async function fetchRepoGql(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<RepoGql> {
  const data = await octokit
    .graphql<{ repository: RepoGql }>(
      `query RepoStatus($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        autoMergeAllowed
        branchProtectionRules(first: 1) { totalCount }
        rulesets(first: 1) { totalCount }
      }
    }`,
      { owner, name },
    )
    .catch(() => null);
  return data?.repository ?? null;
}

interface Installation {
  id: number;
  repositories: { owner: { login: string }; name: string; full_name: string }[];
}

async function fetchUserInstallations(
  userOctokit: Octokit,
): Promise<Installation[]> {
  const installations: Installation[] = [];
  for await (const { data: installs } of userOctokit.paginate.iterator(
    userOctokit.rest.apps.listInstallationsForAuthenticatedUser,
  )) {
    for (const install of installs) {
      const repos: Installation["repositories"] = [];
      for await (const { data: repoPage } of userOctokit.paginate.iterator(
        userOctokit.rest.apps.listInstallationReposForAuthenticatedUser,
        { installation_id: install.id },
      )) {
        for (const r of repoPage) {
          repos.push({
            owner: { login: r.owner.login },
            name: r.name,
            full_name: r.full_name,
          });
        }
      }
      installations.push({ id: install.id, repositories: repos });
    }
  }
  return installations;
}

export async function fetchAllRepos(
  app: App,
  userOctokit: Octokit,
): Promise<RepoInfo[]> {
  const installations = await fetchUserInstallations(userOctokit);

  const pending: Promise<RepoInfo>[] = [];
  for (const install of installations) {
    const installOctokit = await app.getInstallationOctokit(install.id);
    for (const repo of install.repositories) {
      pending.push(
        fetchRepoGql(installOctokit, repo.owner.login, repo.name).then(
          (graphql): RepoInfo => ({
            owner: repo.owner.login,
            name: repo.name,
            fullName: repo.full_name,
            graphql,
          }),
        ),
      );
    }
  }

  const repos = await Promise.all(pending);
  const collator = new Intl.Collator("und", { usage: "sort" });
  return repos.sort((a, b) => collator.compare(a.fullName, b.fullName));
}
