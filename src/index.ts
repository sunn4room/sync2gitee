import os from "os";
import path from "path";
import { mkdir, appendFile, chmod, mkdtemp } from "fs/promises";
import axios from "axios";
import action from "@actions/core";
import { execa } from "execa";

const REPOSITORIES = action.getInput("repositories", {
  required: true,
});
console.log(REPOSITORIES);
const GITEE_PRIVATE_KEY = action.getInput("gitee-private-key", {
  required: true,
});
const GITEE_TOKEN = action.getInput("gitee-token", {
  required: true,
});
const GITEE_ORG = action.getInput("gitee-org", {
  required: true,
});

function info(msg: string): void {
  console.log("\x1b[1;32m INFO\x1b[0m %s", msg);
}

function warn(msg: string): void {
  console.log("\x1b[1;33m WARN\x1b[0m %s", msg);
}

function error(msg: string): void {
  console.log("\x1b[1;31mERROR\x1b[0m %s", msg);
  process.exit(1);
}

const gitee = axios.create({
  baseURL: "https://gitee.com/api/v5/",
  timeout: 1000,
  headers: {
    "Content-Type": "application/json",
    charset: "UTF-8",
  },
});

async function access_gitee_api(
  method: string,
  url: string,
  data: any = undefined
) {
  let counter = 0;
  while (counter < 5) {
    try {
      await gitee.request({
        method: method,
        url: url,
        data: data,
      });
      return true;
    } catch (e: any) {
      if (e.response) {
        return false;
      } else if (e.request) {
        counter++;
      } else {
        throw e;
      }
    }
  }
  throw new Error("cannot access gitee api");
}

async function gitee_api(url: string, data: any = undefined) {
  if (data) {
    data["access_token"] = GITEE_TOKEN;
    return await access_gitee_api("post", url, data);
  } else {
    url = `${url}?access_token=${GITEE_TOKEN}`;
    return await access_gitee_api("get", url);
  }
}

async function sync(repo_str: string): Promise<void> {
  let cut = repo_str.split("->");
  repo_str = cut[0];
  let repo_name = cut.length === 1 ? "" : cut[1];
  cut = repo_str.split("@");
  let repo_branch = cut.length === 1 ? "" : cut[1];
  let repo = cut[0];
  if (repo_name === "") {
    repo_name = repo.split("/")[1];
  }
  const indicator = `${repo} --${repo_branch}--> ${GITEE_ORG}/${repo_name}`;

  try {
    if (!gitee_api(`/repos/${GITEE_ORG}/${repo_name}`)) {
      if (!gitee_api(`/orgs/${GITEE_ORG}/repos`, { name: repo_name })) {
        throw new Error("cannot create gitee repository");
      }
    }

    const tempdir = await mkdtemp(path.join(os.tmpdir(), "repo-"));
    if (repo_branch === "") {
      await execa("git", ["clone", `https://github/${repo}.git`, tempdir]);
    } else {
      await execa("git", [
        "clone",
        "--branch",
        repo_branch,
        `https://github/${repo}.git`,
        tempdir,
      ]);
    }

    const gitee_repo = `git@gitee.com:${GITEE_ORG}/${repo_name}.git`;

    await execa("git", ["remote", "add", "gitee", gitee_repo], {
      cwd: tempdir,
    });
    await execa("git", ["push", "-f", "gitee"], { cwd: tempdir });

    info(indicator);
  } catch (e: any) {
    warn(indicator);
  }
}

// main function
(async function () {
  try {
    info("validating gitee organization");
    if (!gitee_api(`/orgs/${GITEE_ORG}`)) {
      warn("creating gitee organization");
      if (
        !gitee_api("/users/organization", { name: GITEE_ORG, org: GITEE_ORG })
      ) {
        throw new Error("cannot create gitee organization");
      }
    }

    info("starting ssh-agent");
    await execa("ssh-agent", ["-a", "/tmp/ssh-auth.sock"]);
    action.exportVariable("SSH_AUTH_SOCK", "/tmp/ssh-auth.sock");

    info("adding gitee private key");
    await execa("ssh-add", ["-"], { input: GITEE_PRIVATE_KEY });

    info("adding gitee.com to known_hosts");
    const sshDir = path.join(os.homedir(), ".ssh");
    await mkdir(sshDir);
    const knownHostsFile = path.join(sshDir, "known_hosts");
    const { stdout } = await execa("ssh-keyscan", ["gitee.com"]);
    await appendFile(knownHostsFile, stdout);
    await chmod(knownHostsFile, "644");

    // const promises: Promise<void>[] = [];
    // for (let repo_str in REPOSITORIES.split("\n")) {
    //   promises.push(sync(repo_str));
    // }
    // await Promise.allSettled(promises);
  } catch (e: any) {
    error(e.message);
  }
})();
