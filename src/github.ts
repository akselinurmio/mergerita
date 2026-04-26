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

async function fetchReposGqlBatched(
  octokit: Octokit,
  repos: { owner: string; name: string }[],
): Promise<Map<string, RepoGql>> {
  if (repos.length === 0) return new Map();

  const fragments = repos.map((r, i) => {
    return `repo${i}: repository(owner: "${r.owner}", name: "${r.name}") {
      autoMergeAllowed
      branchProtectionRules(first: 1) { totalCount }
      rulesets(first: 1) { totalCount }
    }`;
  });
  const query = `query RepoStatusBatch { ${fragments.join("\n")} }`;

  const data = await octokit
    .graphql<Record<string, RepoGql>>(query)
    .catch(() => null);

  const result = new Map<string, RepoGql>();
  for (let i = 0; i < repos.length; i++) {
    const key = `${repos[i].owner}/${repos[i].name}`;
    result.set(key, data?.[`repo${i}`] ?? null);
  }
  return result;
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

  const allRepos: RepoInfo[] = [];
  await Promise.all(
    installations.map(async (install) => {
      const installOctokit = await app.getInstallationOctokit(install.id);

      const repoKeys = install.repositories.map((r) => ({
        owner: r.owner.login,
        name: r.name,
      }));
      const gqlMap = await fetchReposGqlBatched(installOctokit, repoKeys);

      for (const repo of install.repositories) {
        const key = `${repo.owner.login}/${repo.name}`;
        allRepos.push({
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          graphql: gqlMap.get(key) ?? null,
        });
      }
    }),
  );

  const collator = new Intl.Collator("und", { usage: "sort" });
  return allRepos.sort((a, b) => collator.compare(a.fullName, b.fullName));
}
