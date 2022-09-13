import os from 'os'
import path from 'path'
import { mkdir, appendFile, chmod, mkdtemp } from 'fs/promises'
import axios from 'axios'
import core from '@actions/core'
import { execa } from 'execa'

const REPOSITORIES = core.getInput('repositories', { required: true })
const GITEE_PRIVATE_KEY = core.getInput('gitee-private-key', { required: true })
const GITEE_TOKEN = core.getInput('gitee-token', { required: true })
const GITEE_ORG = core.getInput('gitee-org', { required: true })

function info(msg: string): void {
  console.log('\x1b[1;32m INFO\x1b[0m %s', msg)
}

function warn(msg: string): void {
  console.log('\x1b[1;33m WARN\x1b[0m %s', msg)
}

function error(msg: string): void {
  console.log('\x1b[1;31mERROR\x1b[0m %s', msg)
  process.exit(1)
}

const gitee = axios.create({
  baseURL: 'https://gitee.com/api/v5/',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    'charset': 'UTF-8',
  },
  validateStatus: () => true,
})

async function access_gitee_api(
  method: string,
  url: string,
  data: any = undefined
) {
  let counter = 0
  while (counter < 5) {
    try {
      const res = await gitee.request({
        method: method,
        url: url,
        data: data,
      })
      return res.status >= 200 && res.status < 300
    } catch (e: any) {
      counter++
    }
  }
  throw new Error('cannot access gitee api')
}

async function gitee_api(url: string, data: any = undefined) {
  if (data) {
    data['access_token'] = GITEE_TOKEN
    return await access_gitee_api('post', url, data)
  } else {
    url = `${url}?access_token=${GITEE_TOKEN}`
    return await access_gitee_api('get', url)
  }
}

async function sync(repo_str: string): Promise<void> {
  let cut = repo_str.split('->')
  repo_str = cut[0]
  let repo_name = cut.length === 1 ? '' : cut[1]
  cut = repo_str.split('@')
  let repo_branch = cut.length === 1 ? '' : cut[1]
  let repo = cut[0]
  if (repo_name === '') {
    repo_name = repo.split('/')[1]
  }
  const indicator = `${repo} --${repo_branch}--> ${GITEE_ORG}/${repo_name}`

  try {
    if (!(await gitee_api(`/repos/${GITEE_ORG}/${repo_name}`))) {
      if (!(await gitee_api(`/orgs/${GITEE_ORG}/repos`, { name: repo_name }))) {
        throw new Error('cannot create gitee repository')
      }
    }

    const tempdir = await mkdtemp(path.join(os.tmpdir(), 'repo-'))
    if (repo_branch === '') {
      await execa('git', ['clone', `https://github.com/${repo}.git`, tempdir])
    } else {
      await execa('git', [
        'clone',
        '--branch',
        repo_branch,
        `https://github.com/${repo}.git`,
        tempdir,
      ])
    }

    await execa(
      'git',
      ['remote', 'add', 'gitee', `git@gitee.com:${GITEE_ORG}/${repo_name}.git`],
      {
        cwd: tempdir,
      }
    )
    await execa('git', ['push', '-f', 'gitee'], { cwd: tempdir })

    info(indicator)
  } catch (e: any) {
    warn(`${indicator}: ${e.message}`)
    throw e
  }
}

export class LimitPromise {
  private limit: number
  private count: number
  private taskQueue: any[]

  constructor(limit: number) {
    this.limit = limit
    this.count = 0
    this.taskQueue = []
  }

  private createTask(
    asyncFn: Function,
    args: any[],
    resolve: (value: void) => void,
    reject: (reason?: any) => void
  ) {
    return () => {
      asyncFn(...args)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.count--
          if (this.taskQueue.length) {
            let task = this.taskQueue.shift()
            task()
          }
        })

      this.count++
    }
  }

  public call(asyncFn: Function, ...args: any[]) {
    return new Promise<void>((resolve, reject) => {
      const task = this.createTask(asyncFn, args, resolve, reject)
      if (this.count >= this.limit) {
        this.taskQueue.push(task)
      } else {
        task()
      }
    })
  }
}

;(async function () {
  try {
    info('validating gitee organization')
    if (!(await gitee_api(`/orgs/${GITEE_ORG}`))) {
      warn('creating gitee organization')
      if (
        !(await gitee_api('/users/organization', {
          name: GITEE_ORG,
          org: GITEE_ORG,
        }))
      ) {
        throw new Error('cannot create gitee organization')
      }
    }

    info('starting ssh-agent')
    await execa('ssh-agent', ['-a', '/tmp/ssh-auth.sock'])
    core.exportVariable('SSH_AUTH_SOCK', '/tmp/ssh-auth.sock')

    info('adding gitee private key')
    await execa('ssh-add', ['-'], { input: GITEE_PRIVATE_KEY })

    info('adding gitee.com to known_hosts')
    const sshDir = path.join(os.homedir(), '.ssh')
    await mkdir(sshDir)
    const knownHostsFile = path.join(sshDir, 'known_hosts')
    const { stdout } = await execa('ssh-keyscan', ['gitee.com'])
    await appendFile(knownHostsFile, stdout)
    await chmod(knownHostsFile, '644')

    const promises: Promise<void>[] = []
    const promise_limiter = new LimitPromise(5)
    REPOSITORIES.split('\n').forEach((repo_str) => {
      promises.push(promise_limiter.call(sync, repo_str))
    })
    const results = await Promise.allSettled(promises)
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Failed')
    }
  } catch (e: any) {
    error(e.message)
  }
})()
