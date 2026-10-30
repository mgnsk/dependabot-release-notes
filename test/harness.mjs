// Runs the action as a subprocess against the fake network in fake-fetch.mjs.

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SCRIPT = fileURLToPath(new URL('../dependabot-release-notes.mjs', import.meta.url))
const PRELOAD = new URL('./fake-fetch.mjs', import.meta.url).href

export const REPOSITORY = 'owner/repo'
export const PULL_REQUEST = '7'
export const TOKEN = 'test-token'
export const MARKER = '<!-- dependabot-release-notes -->'

const API = `https://api.github.com/repos/${REPOSITORY}`

export const ok = (body) => ({ status: 200, body })
export const notFound = { status: 404, body: { message: 'Not Found' } }

export function releasesRoute(project, releases) {
  return { [`GET https://api.github.com/repos/${project}/releases?per_page=100`]: ok(releases) }
}

export function compareRoute(project, base, head, commits) {
  return {
    [`GET https://api.github.com/repos/${project}/compare/${base}...${head}`]: ok({ commits }),
  }
}

// The name and the version are spelled as they appear in the proxy's URL.
export function proxyRoute(name, version, origin) {
  return {
    [`GET https://proxy.golang.org/${name}/@v/${version}.info`]: ok({ Origin: origin }),
  }
}

export function release(tag, body, fields = {}) {
  return {
    tag_name: tag,
    name: tag,
    body,
    html_url: `https://example.test/releases/${tag}`,
    published_at: '2026-01-02T03:04:05Z',
    draft: false,
    ...fields,
  }
}

export function upstreamCommit(title, url = `https://example.test/commit/${title}`) {
  return { commit: { message: `${title}\n\nThe rest of the message.` }, html_url: url }
}

// Versions are given as go.mod spells them, a trailing comment included.
export function goModFile(changes, filename = 'go.mod') {
  return {
    filename,
    patch: changes
      .flatMap(([name, from, to]) => [`-\t${name} ${from}`, `+\t${name} ${to}`])
      .join('\n'),
  }
}

function defaultRoutes(messages, files, comments) {
  const routes = {
    [`GET ${API}/pulls/${PULL_REQUEST}/commits?per_page=100`]: ok(
      messages.map((message) => ({ commit: { message } })),
    ),
    [`POST ${API}/issues/${PULL_REQUEST}/comments`]: { status: 201, body: {} },
  }

  const paginate = (path, items) => {
    for (let page = 1; page <= Math.floor(items.length / 100) + 1; page++) {
      routes[`GET ${API}${path}?per_page=100&page=${page}`] = ok(
        items.slice((page - 1) * 100, page * 100),
      )
    }
  }

  paginate(`/pulls/${PULL_REQUEST}/files`, files)
  paginate(`/issues/${PULL_REQUEST}/comments`, comments)

  for (const { id } of comments) {
    routes[`PATCH ${API}/issues/comments/${id}`] = ok({})
    routes[`DELETE ${API}/issues/comments/${id}`] = { status: 204, body: null }
  }

  return routes
}

export async function runAction({
  messages = [],
  files = [],
  comments = [],
  routes = {},
  args = [],
  env = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dependabot-release-notes-'))
  const routesFile = join(directory, 'routes.json')
  const logFile = join(directory, 'requests.jsonl')

  try {
    writeFileSync(
      routesFile,
      JSON.stringify({ ...defaultRoutes(messages, files, comments), ...routes }),
    )

    const result = await run(process.execPath, ['--import', PRELOAD, SCRIPT, ...args], {
      cwd: directory,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        GITHUB_TOKEN: TOKEN,
        GITHUB_REPOSITORY: REPOSITORY,
        PR_NUMBER: PULL_REQUEST,
        FAKE_FETCH_ROUTES: routesFile,
        FAKE_FETCH_LOG: logFile,
        ...env,
      },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      ({ code, stdout, stderr }) => ({ code, stdout, stderr }),
    )

    const requests = existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []

    const unrouted = requests.filter((request) => request.status === 599)
    if (unrouted.length > 0) {
      throw new Error(
        `Requests no route covers:\n${unrouted
          .map((request) => `  ${request.method} ${request.url}`)
          .join('\n')}\n${result.stderr}`,
      )
    }

    const writes = (method) => requests.filter((request) => request.method === method)
    const commentId = (request) => Number(request.url.slice(request.url.lastIndexOf('/') + 1))

    return {
      ...result,
      requests,
      posted: writes('POST').map((request) => JSON.parse(request.body).body),
      patched: writes('PATCH').map((request) => ({
        id: commentId(request),
        body: JSON.parse(request.body).body,
      })),
      deleted: writes('DELETE').map(commentId),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
