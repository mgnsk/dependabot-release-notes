#!/usr/bin/env node

// Posts the release notes for a Dependabot pull request as pull request
// comments, split across several comments when they do not fit in one.
//
// Dependabot writes the notes into the pull request description, which GitHub
// caps at 65,536 characters. A grouped update across many directories repeats
// every dependency's notes once per directory, so the description is truncated
// long before it reaches the last directories and most dependencies end up with
// no notes at all. The commit message carries the same list without the expanded
// notes, so far more of it survives, and that is where the dependencies are read
// from. It is capped at 65,536 characters as well, and a large enough update
// truncates it too, so the summary tables Dependabot writes first fill in
// whatever the truncation cut off.
//
// A Go update is read from the go.mod changes in the pull request's diff
// instead. The commit messages name only what Dependabot bumped, while the diff
// holds every requirement the branch moves, the indirect ones included, and the
// ones a go mod tidy pushed on top of the bump. The messages then only supply
// the links Dependabot wrote, and the module proxy supplies the rest.
//
// An npm, Cargo or Composer lockfile holds the same account of what moved, the
// transitive packages included, but GitHub leaves the patch out of a large one, so
// the file itself is compared between the two ends of the branch. A package only
// the lockfile names has no link to any notes, and is listed in the overview.
//
// Usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
//          node dependabot-release-notes.mjs [--dry-run]

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MARKER = '<!-- dependabot-release-notes -->'

// GitHub rejects comments over 65,536 characters. Stay well below it: the
// budget is checked before a dependency is added, and the header is added after.
const COMMENT_BUDGET = 60_000
// Caps for a single release body and for one dependency's whole section, so
// that one project with an enormous changelog cannot fill a comment on its own.
const RELEASE_BODY_LIMIT = 4_000
const DEPENDENCY_LIMIT = 15_000
// How many commits to list for a project that publishes no releases.
const COMMIT_LIST_LIMIT = 20
// How many pages of 100 releases to read from one project, so that a project
// with thousands of releases cannot spend the token's whole hourly allowance.
const RELEASE_PAGE_LIMIT = 10
// How many releases to ask for by tag once those pages did not reach the base.
const RELEASE_LOOKUP_LIMIT = 20
// How many major versions to list the tags of on the way back from the new one.
const TAG_MAJOR_LIMIT = 5
// A cap for the overview, so that it leaves room in the comment it opens.
const OVERVIEW_LIMIT = 20_000
// How many lockfiles to read, at two requests each, in an update across directories.
const LOCKFILE_LIMIT = 20
const REQUEST_TIMEOUT = 30_000
// How many times to ask before a read counts as failed. A write is never
// repeated, since one that timed out may still have gone through.
const READ_ATTEMPTS = 3
const RETRY_DELAY = Number(process.env.RETRY_DELAY_MS ?? 1_000)

// An action reads its inputs from INPUT_*, and a local run from the names below.
const token = process.env.INPUT_TOKEN || process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const pullRequest = process.env['INPUT_PULL-REQUEST'] || process.env.PR_NUMBER
const commentAuthor =
  process.env.INPUT_AUTHOR || process.env.COMMENT_AUTHOR || 'github-actions[bot]'
const anyAuthor = (process.env['INPUT_ANY-AUTHOR'] || process.env.ANY_AUTHOR) === 'true'
const onlyWhenTruncated =
  (process.env['INPUT_ONLY-WHEN-TRUNCATED'] || process.env.ONLY_WHEN_TRUNCATED) === 'true'
const dryRun = process.argv.includes('--dry-run')

const DEPENDABOT = 'dependabot[bot]'
// What Dependabot ends a description with when it did not fit.
const TRUNCATED_DESCRIPTION = '_Description has been truncated_'

async function request(url, init = {}) {
  const method = init.method ?? 'GET'
  const attempts = method === 'GET' ? READ_ATTEMPTS : 1

  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT), ...init })
    } catch (error) {
      if (attempt < attempts) {
        await pause(attempt)
        continue
      }

      throw Object.assign(new Error(`${method} ${url}: ${error.message}`), { transient: true })
    }

    if (response.status >= 500 && attempt < attempts) {
      await pause(attempt)
      continue
    }

    // Nothing there is an answer to a read or a delete. A write that finds
    // nothing has not done what it was asked.
    if (response.status === 404 && (method === 'GET' || method === 'DELETE')) {
      return null
    }

    if (!response.ok) {
      const error = new Error(`${method} ${url}: ${response.status} ${await response.text()}`)
      error.rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0'))
      error.transient = error.rateLimited || response.status >= 500

      throw error
    }

    if (response.status === 204) {
      return null
    }

    return init.raw ? response.text() : response.json()
  }
}

function pause(attempt) {
  return new Promise((resolve) => setTimeout(resolve, attempt * RETRY_DELAY))
}

// One dependency that cannot be read must not cost the others their notes. A
// failure that a later run would not repeat is worth failing for, at the end,
// since the notes are then incomplete for no reason of the dependency's own. A
// project the token may not read is no such failure: it would fail every run.
let rateLimited = false
let unavailable = false

function recordFailure(error) {
  rateLimited ||= Boolean(error.rateLimited)
  unavailable ||= Boolean(error.transient)
}

// The token authenticates every GitHub call, including the public ones: reading
// two dozen projects' releases unauthenticated would exhaust the sixty requests
// an hour that GitHub grants an anonymous caller. It goes to GitHub and nowhere
// else — another forge must never see it.
function api(path, init = {}) {
  return request(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  })
}

// A tag spelled for a URL path, where its "/" and "@" may stay as they are.
function pathRef(ref) {
  return encodeURIComponent(ref).replaceAll('%2F', '/').replaceAll('%40', '@')
}

function githubRelease(release) {
  return {
    tag: release.tag_name,
    name: release.name,
    body: release.body,
    url: release.html_url,
    date: release.published_at,
  }
}

// A file over the contents API's size limit comes without its content.
function decodeFile(file) {
  return file?.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : null
}

// A dependency's notes live on whichever forge hosts it, so each forge answers
// the same questions: which releases does it publish, a page at a time and
// newest first, which commits lie between two tags, and what does a file hold.
// GitHub also lists tags and finds a release by tag, for a project with more
// releases than are worth paging through. The shapes are normalised here and
// nowhere else.
const FORGES = {
  'github.com': {
    async releases(project, page) {
      const releases =
        (await api(`/repos/${project}/releases?per_page=100&page=${page}`)) ?? []

      return {
        done: releases.length < 100,
        releases: releases
          .filter((release) => !release.draft)
          .map(githubRelease),
      }
    },

    async release(project, tag) {
      const release = await api(`/repos/${project}/releases/tags/${pathRef(tag)}`)

      return release && githubRelease(release)
    },

    // This one answers with every match at once, and would repeat them if paged.
    async tags(project, stem) {
      const refs = (await api(`/repos/${project}/git/matching-refs/tags/${pathRef(stem)}`)) ?? []

      return refs.map((ref) => ref.ref.slice('refs/tags/'.length))
    },

    async file(project, ref, path) {
      return decodeFile(
        await api(`/repos/${project}/contents/${pathRef(path)}?ref=${encodeURIComponent(ref)}`),
      )
    },

    async commits(project, base, head) {
      const compare = await api(`/repos/${project}/compare/${pathRef(base)}...${pathRef(head)}`)
      const commits = (compare?.commits ?? []).map((commit) => ({
        title: commit.commit.message.split('\n')[0],
        url: commit.html_url,
      }))

      // GitHub answers with the newest 250 commits and the count of them all.
      return { commits, total: compare?.total_commits ?? commits.length }
    },
  },

  'gitlab.com': {
    async releases(project, page) {
      const releases =
        (await request(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/releases?per_page=100&page=${page}`,
        )) ?? []

      return {
        done: releases.length < 100,
        releases: releases
          .filter((release) => !release.upcoming_release)
          .map((release) => ({
            tag: release.tag_name,
            name: release.name,
            body: release.description,
            url: release._links?.self,
            date: release.released_at,
          })),
      }
    },

    async commits(project, base, head) {
      const compare = await request(
        `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/repository/compare` +
          `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
      )

      const commits = (compare?.commits ?? []).map((commit) => ({
        title: commit.title,
        url: commit.web_url,
      }))

      return { commits, total: commits.length }
    },

    async file(project, ref, path) {
      return decodeFile(
        await request(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/repository/files/` +
            `${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
        ),
      )
    },
  },
}

// A grouped update repeats an "Updates `pkg` from a to b" block, followed by its
// links, once per directory the dependency was updated in. A dependency that
// matches no group gets a pull request of its own, and that one opens with
// "Bumps [pkg](url) from a to b." and carries no Updates block at all. It names
// its directory at the end, or as "in `/dir`" ahead of the versions.
const UPDATE_FORMS = [
  /^Updates `(?<name>[^`]+)` from (?<from>\S+) to (?<to>\S+)$/,
  /^Bumps \[(?<name>[^\]]+)]\((?<project>[^)]+)\)(?: in `[^`]+`)? from (?<from>\S+) to (?<to>\S+?)(?: in \S+)?\.?$/,
  /^Bumps (?<name>[^\s[\]]+)(?: in `[^`]+`)? from (?<from>\S+) to (?<to>\S+?)(?: in \S+)?\.?$/,
]

// Dependabot quotes a commit hash in backticks: from `034a74c` to `a60f53e`.
function unquoted(text) {
  return text?.replaceAll('`', '')
}

function matchUpdate(line) {
  for (const form of UPDATE_FORMS) {
    const update = form.exec(line)
    if (update) {
      return update
    }
  }

  return null
}

// Collapse the repeats into one entry per package and version range.
function parseUpdates(message, description = '') {
  const lines = message.split('\n')
  const updates = new Map()
  const headlines = new Set()
  const detailed = new Set()

  for (let index = 0; index < lines.length; index++) {
    const update = matchUpdate(lines[index])
    if (!update) {
      continue
    }

    const links = {}
    for (let next = index + 1; next < lines.length; next++) {
      const link = /^- \[([^\]]+)]\((\S+)\)$/.exec(lines[next])
      if (!link) {
        break
      }
      links[link[1]] = link[2]
    }

    // The earliest copy wins. The truncation lands in the middle of the last
    // block it kept, so a later copy of the same update may have lost its links.
    const { name, from, to } = Object.fromEntries(
      ['name', 'from', 'to'].map((group) => [group, unquoted(update.groups[group])]),
    )
    const { project } = update.groups
    const key = `${name}@${from}...${to}`
    if (!updates.has(key)) {
      updates.set(key, { name, from, to, links, project })
    }

    if (lines[index].startsWith('Updates ')) {
      detailed.add(`${from}...${to}`)
    } else if (!project) {
      headlines.add(key)
    }
  }

  for (const tabled of parseTables(message)) {
    const key = `${tabled.name}@${tabled.from}...${tabled.to}`
    if (!updates.has(key)) {
      updates.set(key, tabled)
    } else {
      updates.get(key).project ??= tabled.project
    }
  }

  for (const described of parseDescription(description)) {
    const key = `${described.name}@${described.from}...${described.to}`
    if (!updates.has(key)) {
      updates.set(key, described)
    } else {
      const update = updates.get(key)
      update.project ??= described.project
      update.links.Commits ??= described.links.Commits
    }
  }

  // A group's headline names the group rather than a package: "Bumps
  // `org.springframework` from a to b", above the blocks of the packages in it.
  for (const key of headlines) {
    const { from, to, links } = updates.get(key)
    if (detailed.has(`${from}...${to}`) && Object.keys(links).length === 0) {
      updates.delete(key)
    }
  }

  // The truncation may land inside a version, in the last line it kept, which then
  // reads as a range of its own next to the whole one a summary table gives.
  const cut = matchUpdate(lines.findLast((line) => line.trim()) ?? '')
  if (cut) {
    const { name, from, to } = cut.groups
    const whole = [...updates.values()].some(
      (update) =>
        update.name === unquoted(name) &&
        update.from === unquoted(from) &&
        update.to !== unquoted(to) &&
        update.to.startsWith(unquoted(to)),
    )
    if (whole) {
      updates.delete(`${unquoted(name)}@${unquoted(from)}...${unquoted(to)}`)
    }
  }

  return [...updates.values()]
}

// The commit message of a NuGet update across directories names no versions at
// all, or only the new one, and the description alone has the ranges:
//
//   Updated [Microsoft.ML](https://github.com/dotnet/machinelearning) from 5.0.0 to 5.0.1.
//
// Followed by its notes in a <details>, which are the project's own words and
// are not read, apart from the compare link Dependabot closes them with.
function parseDescription(description) {
  const form = /^Updated (?:\[([^\]]+)]\(([^)\s]+)\)|(\S+)) from (\S+) to (\S+?)\.?$/
  const described = []
  let depth = 0

  for (const line of description.replace(/\r\n/g, '\n').split('\n')) {
    const updated = depth === 0 ? form.exec(line) : null
    if (updated) {
      const [, linked, project, plain, from, to] = updated
      described.push({
        name: linked ?? plain,
        from: unquoted(from),
        to: unquoted(to),
        links: project ? { Repository: project } : {},
        project,
      })
    }

    const compare = /\[compare view]\((\S+\/compare\/\S+?)\)/.exec(line)?.[1]
    if (compare && described.length > 0) {
      described.at(-1).links.Commits ??= compare
    }

    depth += (line.match(/<details\b/gi) ?? []).length - (line.match(/<\/details>/gi) ?? []).length
    depth = Math.max(depth, 0)
  }

  return described
}

// The summary table Dependabot writes before the detail blocks:
//
//   | [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) | `1.55.0` | `1.56.0` |
//
// It survives a truncation that dropped the detail block, and it names the
// project. It does not name the tags, so those are derived from the versions.
function parseTables(message) {
  const row = /^\| \[?([^\]|]+?)\]?(?:\((\S+)\))? \| `([^`]+)` \| `([^`]+)` \|$/
  const tabled = []

  for (const line of message.split('\n')) {
    const columns = row.exec(line)
    if (!columns) {
      continue
    }

    const [, name, project, from, to] = columns
    tabled.push({
      name: unquoted(name),
      from,
      to,
      links: project ? { Repository: project } : {},
      project,
    })
  }

  return tabled
}

// A requirement in go.mod, inside a require block or on a require line of its
// own. A replace directive carries "=>" after the version and never matches, but
// a line of an exclude block reads the same as a requirement, so the patch is
// followed from block to block. A hunk names the block it starts in after its "@@".
const REQUIREMENT = /^([-+])(?:require\s+|\s+)(\S+)\s+(v\S+)(\s+\/\/.*)?$/

// Every requirement whose version a go.mod file in the diff changes. A module
// the diff only adds or only drops has no range to report.
function parseRequirementChanges(files) {
  const changes = new Map()

  for (const file of files.filter((file) => /(^|\/)go\.mod$/.test(file.filename))) {
    const removed = new Map()
    const added = new Map()

    let block = null
    for (const line of (file.patch ?? '').split('\n')) {
      const opened = /^(?:@@.*@@ |[-+ ])(\w+) \($/.exec(line)
      if (opened || line.startsWith('@@')) {
        block = opened?.[1] ?? null
        continue
      }
      if (/^[-+ ]\)$/.test(line)) {
        block = null
        continue
      }

      const requirement = REQUIREMENT.exec(line)
      if (requirement && block !== 'exclude') {
        ;(requirement[1] === '-' ? removed : added).set(requirement[2], {
          version: requirement[3],
          indirect: /\/\/\s*indirect\b/.test(requirement[4] ?? ''),
        })
      }
    }

    // Dependabot writes versions without the "v" go.mod gives them, and the
    // ranges have to agree for its links to be found.
    for (const [name, { version: to, indirect }] of added) {
      const from = removed.get(name)?.version
      if (from && from !== to) {
        const update = { name, from: from.slice(1), to: to.slice(1), links: {}, indirect }
        const key = `${name}@${update.from}...${update.to}`
        // A module that one go.mod imports itself is a direct dependency.
        update.indirect &&= changes.get(key)?.indirect ?? true
        changes.set(key, update)
      }
    }
  }

  return [...changes.values()]
}

// Each parser gives the versions of the packages a lockfile installs, by name, and
// the names the project itself asks for, or null when the lockfile does not say.
function addVersion(versions, name, version) {
  if (name && version) {
    versions.set(name, (versions.get(name) ?? new Set()).add(version))
  }
}

// A package may be installed at several paths, in several versions, and an alias is
// installed under another name than its own. An entry without node_modules in its
// path is the project or a workspace of it, which is where the direct names are. A
// lockfile from before npm 7 nests its packages instead, and names no direct ones.
function parsePackageLock(text) {
  const lock = JSON.parse(text)
  const versions = new Map()

  if (!lock.packages) {
    const walk = (dependencies = {}) => {
      for (const [name, entry] of Object.entries(dependencies)) {
        addVersion(versions, entry.name ?? name, entry.version)
        walk(entry.dependencies)
      }
    }
    walk(lock.dependencies)

    return { versions, direct: null }
  }

  const direct = new Set()
  for (const [path, entry] of Object.entries(lock.packages)) {
    const installed = path.lastIndexOf('node_modules/')
    if (installed === -1) {
      for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        Object.keys(entry[group] ?? {}).forEach((name) => direct.add(name))
      }
    } else if (!entry.link) {
      addVersion(versions, entry.name ?? path.slice(installed + 'node_modules/'.length), entry.version)
    }
  }

  return { versions, direct }
}

// A package without a source is a crate of the workspace, and what those depend on
// is direct. A dependency reads "name", "name 1.2.3" or "name 1.2.3 (source)".
function parseCargoLock(text) {
  const versions = new Map()
  const direct = new Set()

  for (const block of text.replace(/\r\n/g, '\n').split(/^\[/m)) {
    if (!block.startsWith('[package]]')) {
      continue
    }

    const field = (name) => new RegExp(`^${name} = "(.*)"$`, 'm').exec(block)?.[1]
    if (field('source')) {
      addVersion(versions, field('name'), field('version'))
    } else {
      const dependencies = /^dependencies = \[([^\]]*)]/m.exec(block)?.[1] ?? ''
      for (const [, name] of dependencies.matchAll(/"([^"\s]+)[^"]*"/g)) {
        direct.add(name)
      }
    }
  }

  return { versions, direct }
}

// The lockfile does not say what the project asks for, but the composer.json beside
// it does. It also gives each package's repository, for one nothing else links.
function parseComposerLock(text, manifest) {
  const lock = JSON.parse(text)
  const versions = new Map()
  const projects = new Map()

  for (const entry of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) {
    addVersion(versions, entry.name, entry.version?.replace(/^v(?=\d)/, ''))
    if (entry.source?.url) {
      projects.set(entry.name, entry.source.url)
    }
  }

  const required = manifest ? JSON.parse(manifest) : null
  const direct = required
    ? new Set([...Object.keys(required.require ?? {}), ...Object.keys(required['require-dev'] ?? {})])
    : null

  return { versions, direct, projects }
}

const LOCKFILES = {
  'package-lock.json': { parse: parsePackageLock },
  'npm-shrinkwrap.json': { parse: parsePackageLock },
  'Cargo.lock': { parse: parseCargoLock },
  'composer.lock': { parse: parseComposerLock, manifest: 'composer.json' },
}

// What moved between two readings of a lockfile. A package may hold several versions
// at once, and moves between paths without changing, so only versions that came or
// went count, paired from the highest down. A package only added or only dropped has
// no range to report. Lockfiles go in a table, and must not be able to break out of it.
function diffLockfile(before, after) {
  const changes = []
  const order = (left, right) => left.localeCompare(right, 'en', { numeric: true })

  for (const [name, versions] of after.versions) {
    const old = before.versions.get(name) ?? new Set()
    const added = [...versions].filter((version) => !old.has(version)).sort(order)
    const removed = [...old].filter((version) => !versions.has(version)).sort(order)

    for (let index = 1; index <= Math.min(added.length, removed.length); index++) {
      const [from, to] = [removed.at(-index), added.at(-index)]
      if (/^[\w@./-]+$/.test(name) && /^[\w.+-]+$/.test(from) && /^[\w.+-]+$/.test(to)) {
        changes.push({
          name,
          from,
          to,
          links: {},
          project: after.projects?.get(name),
          indirect: after.direct ? !after.direct.has(name) : undefined,
        })
      }
    }
  }

  return changes
}

// A file of the repository at a commit, up to the 100 MB GitHub serves, where the
// contents API's JSON answer stops at 1 MB.
function repositoryFile(path, sha) {
  return api(`/repos/${repository}/contents/${pathRef(path)}?ref=${sha}`, {
    raw: true,
    headers: { accept: 'application/vnd.github.raw+json' },
  })
}

// Every package the lockfiles in the diff move. The ends of the branch are its own
// commits: the base branch may have moved on since, and a commit anyone else pushed
// has no more say here than its message has.
async function readLockfileChanges(files, commits) {
  const [base, head] = [commits[0]?.parents?.[0]?.sha, commits.at(-1)?.sha]
  const paths = files
    .filter((file) => file.status === 'modified' && LOCKFILES[file.filename.split('/').at(-1)])
    .map((file) => file.filename)
  if (!base || !head) {
    return []
  }

  if (paths.length > LOCKFILE_LIMIT) {
    console.warn(`Reading ${LOCKFILE_LIMIT} of ${paths.length} lockfiles.`)
  }

  const changes = new Map()
  for (const path of paths.slice(0, LOCKFILE_LIMIT)) {
    try {
      const { parse, manifest } = LOCKFILES[path.split('/').at(-1)]
      const beside = manifest && path.replace(/[^/]+$/, manifest)
      const read = async (sha) => {
        const [text, manifestText] = await Promise.all([
          repositoryFile(path, sha),
          beside ? repositoryFile(beside, sha) : null,
        ])

        return text === null ? null : parse(text, manifestText)
      }
      const [before, after] = [await read(base), await read(head)]
      if (!before || !after) {
        continue
      }

      for (const change of diffLockfile(before, after)) {
        const key = `${change.name}@${change.from}...${change.to}`
        const seen = changes.get(key)
        // A package that one directory asks for itself is a direct dependency.
        if (seen) {
          change.indirect = seen.indirect === false ? false : (change.indirect ?? seen.indirect)
        }
        changes.set(key, change)
      }
    } catch (error) {
      console.warn(`${path}: ${error.message}`)
      recordFailure(error)
    }
  }

  return [...changes.values()]
}

// What the lockfiles add to what Dependabot announced: whether an announced update is
// direct, the direct ones it left out, and the rest to list on their own. A range may
// differ from the announced one between directories, so the new version settles it.
function applyLockfileChanges(announced, changes) {
  const listed = []

  for (const change of changes) {
    const update =
      announced.find(
        ({ name, from, to }) => name === change.name && from === change.from && to === change.to,
      ) ?? announced.find(({ name, to }) => name === change.name && to === change.to)

    if (update) {
      update.indirect = update.indirect === false ? false : (change.indirect ?? update.indirect)
      update.project ??= change.project
    } else if (change.indirect === false) {
      announced.push(change)
    } else {
      listed.push(change)
    }
  }

  return listed
}

async function listAll(path) {
  const items = []

  for (let page = 1; ; page++) {
    const batch = await api(`${path}?per_page=100&page=${page}`)
    // Only a pull request that cannot be read gets here with a 404: a wrong
    // number, or a token without access to the repository. Neither is empty.
    if (!batch) {
      throw new Error(`GET ${path}: 404, check the pull request number and the token's access`)
    }

    items.push(...batch)

    if (batch.length < 100) {
      return items
    }
  }
}

// The module proxy records where it fetched each version from: the repository,
// and the tag or, for a pseudo-version, the commit. That names the tags exactly,
// even for a module that sits in a subdirectory or behind a vanity import path.
// The proxy is public, so it is asked without the token.
async function proxyOrigin(name, version) {
  const escape = (text) => text.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)

  try {
    const info = await request(
      `https://proxy.golang.org/${escape(name)}/@v/${escape(version)}.info`,
    )

    return info?.Origin ?? null
  } catch (error) {
    console.warn(`${name}@${version}: ${error.message}`)
    recordFailure(error)

    return null
  }
}

// The Go project hosts golang.org/x on its own Gerrit and mirrors each of those
// repositories to github.com/golang, where the commits can be compared.
async function compareLinkFromProxy(update) {
  const from = await proxyOrigin(update.name, `v${update.from}`)
  const to = await proxyOrigin(update.name, `v${update.to}`)
  if (!from || !to || from.URL !== to.URL) {
    return null
  }

  const project = /^https:\/\/(github\.com|gitlab\.com)\/(.+?)(?:\.git)?\/?$/.exec(
    to.URL.replace(/^https:\/\/go\.googlesource\.com\//, 'https://github.com/golang/'),
  )
  if (!project) {
    return null
  }

  const ref = (origin) =>
    origin.Ref?.startsWith('refs/tags/') ? origin.Ref.slice('refs/tags/'.length) : origin.Hash
  const compare = project[1] === 'gitlab.com' ? '-/compare' : 'compare'

  return `https://${project[1]}/${project[2]}/${compare}/${ref(from)}...${ref(to)}`
}

// The compare link carries the real tag names, including the path prefixes that
// modules tagged inside a monorepo use (service/s3/v1.107.0). Reading them off
// the link avoids having to guess a tag from a module version. A GitLab project
// may sit several groups deep and its compare path may carry a "-" segment.
function parseCompareLink(url) {
  const compare = /^https:\/\/(github\.com|gitlab\.com)\/(.+?)\/(?:-\/)?compare\/(.+)$/.exec(
    url ?? '',
  )
  if (!compare) {
    return null
  }

  // An npm tag carries an "@" of its own, which the link may spell escaped.
  const [base, head] = compare[3].replaceAll('%40', '@').split('...')
  if (!base || !head) {
    return null
  }

  return { host: compare[1], forge: FORGES[compare[1]], project: compare[2], base, head }
}

// A module that sits in a subdirectory of its repository is tagged with that
// subdirectory ahead of the version, which is how Go resolves a submodule tag.
// The major version suffix is part of the module path rather than the directory.
function tagPrefix(name, root) {
  const module = name.replace(/\/v\d+$/, '')

  return module.startsWith(`${root}/`) ? `${module.slice(root.length + 1)}/` : ''
}

// Dependabot picks a monorepo's tags by version alone, and modules that happen to
// share a version get each other's: the credentials module of the AWS SDK links
// service/kms/v1.20.9...service/emr/v1.20.10. Go settles what a module's tag is
// called, wherever the module path spells out the repository.
function hasForeignTags(update) {
  const compare = parseCompareLink(update.links.Commits)
  if (!compare || isCommitHash(compare.base) || isCommitHash(compare.head)) {
    return false
  }

  const root = `${compare.host}/${compare.project}`
  if (update.name !== root && !update.name.startsWith(`${root}/`)) {
    return false
  }

  const prefix = tagPrefix(update.name, root)

  return headPrefix(compare.base) !== prefix || headPrefix(compare.head) !== prefix
}

// The repository a link points into. Dependabot links a package inside a monorepo
// by its directory (/tree/HEAD/packages/core), and its other links go further in.
function projectFromLink(url) {
  const link = /^https:\/\/(github\.com|gitlab\.com)\/([^?#]+)/.exec(url ?? '')
  if (!link) {
    return null
  }

  const path = link[2]
    .replace(/\/(?:-|tree|blob|commits?|compare|releases|tags)(?:\/.*)?$/, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
  const project = link[1] === 'github.com' ? path.split('/').slice(0, 2).join('/') : path

  return project.includes('/') ? { host: link[1], project } : null
}

// The new tag out of a link to a monorepo package's history, the one link
// Dependabot gives when it cannot compare: /commits/v7.25.0/packages/core, or
// /commits/@sveltejs/kit@3.1.0/packages/kit where the tag holds a "/" of its own.
function tagFromCommitsLink(url, version) {
  const path = /\/commits\/(.+)$/.exec(url ?? '')?.[1].replaceAll('%40', '@')
  if (!path) {
    return null
  }

  const segments = path.split('/')
  const end = segments.findIndex(
    (segment) => segment.endsWith(version) && !/[\d.]$/.test(segment.slice(0, -version.length)),
  )

  return end === -1 ? null : segments.slice(0, end + 1).join('/')
}

// A dependency without a compare link has at most a project, so its tags are
// guessed. Version matching strips a leading "v" from both sides, so the releases
// are found either way; only the compare call needs the tag spelled as the project
// spells it, and that is settled by trying the new tag's spelling first, if a link
// gave it, and otherwise the Go convention.
function compareFromProject(update) {
  const found = [
    update.links.Commits,
    update.project,
    update.links['Release notes'],
    update.links.Changelog,
  ]
    .map(projectFromLink)
    .find(Boolean)
  if (!found) {
    return null
  }

  const { host, project } = found
  const head = tagFromCommitsLink(update.links.Commits, update.to)
  const prefix = tagPrefix(update.name, `${host}/${project}`)

  return {
    host,
    forge: FORGES[host],
    project,
    name: update.name,
    base: head ? `${head.slice(0, -update.to.length)}${update.from}` : `${prefix}v${update.from}`,
    head: head ?? `${prefix}v${update.to}`,
    tagsAreGuessed: true,
  }
}

// What was found in a link goes into a request that carries the token, and a
// commit message is only as trustworthy as whoever pushed the commit.
function compareFor(update) {
  const compare = parseCompareLink(update.links.Commits) ?? compareFromProject(update)
  if (!compare || [compare.project, compare.base, compare.head].some((part) => part.includes('..'))) {
    return null
  }

  return compare.host !== 'github.com' || /^[^/]+\/[^/]+$/.test(compare.project) ? compare : null
}

// The two sides of a pseudo-version's range are commit hashes, which name no
// release, and a hash that starts with digits would read as a version.
function isCommitHash(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref) && /[a-f]/i.test(ref)
}

// How a package's tag reads in an npm monorepo that tags by package. Go modules
// never do.
function packagePrefix(name) {
  return /^[^/@]*\.[^/]*\//.test(name) ? null : `${name}@`
}

// What a tag carries ahead of its version: the directory of a module tagged
// inside a monorepo (service/s3/v1.107.0), the package of an npm one
// (@scope/pkg@1.2.3), or a name joined by a dash (foo-v1.3.0, netty-4.1.102.Final).
// A dash after a version is part of that version instead (v1.2.3-4).
function headPrefix(head) {
  return /^(?:.*[/@])?(?:(?!v?\d)[^/@]*?-)?(?=v?\d)/.exec(head)?.[0] ?? /^.*[/@]/.exec(head)?.[0] ?? ''
}

function bareTag(tag, prefix) {
  return tag.slice(prefix.length).replace(/^v/, '')
}

// A qualifier that marks a final release rather than one on the way to it: Java's
// 33.0.0-jre and 4.1.100.Final, Spring's 4.3.8.RELEASE, Python's 1.2.3.post1.
const FINAL_QUALIFIER = /^(?:final|ga|release|jre|android|lts|stable|sp\d*|post\d*)$/i

// Not only semver: an action moves from 4 to 5, and a Python package from 1.2.3.4
// to 2.0.0rc1. Build metadata says nothing about order, so +incompatible goes.
function parseVersion(tag, prefix) {
  if (!tag.startsWith(prefix)) {
    return null
  }

  const version = /^(\d+(?:\.\d+)*)(?:[-.]?([A-Za-z0-9][\w.-]*))?$/.exec(
    bareTag(tag, prefix).replace(/\+.*$/, ''),
  )
  if (!version) {
    return null
  }

  // A post release or service pack comes after the release it follows.
  const later = /^(?:post|sp)(\d*)$/i.exec(version[2] ?? '')

  return {
    parts: [...version[1].split('.').map(Number), ...(later ? [Number(later[1]) + 1] : [])],
    prerelease: FINAL_QUALIFIER.test(version[2] ?? '') ? null : (version[2] ?? null),
  }
}

// Whether a version is at or before the start of the base's minor line, within
// its major version: 2.3.0 or 2.2.9 for a base of 2.3.5.
function startsBranchOf(version, base) {
  const [major, minor = 0, patch = 0] = version.parts
  const [baseMajor, baseMinor = 0] = base.parts

  return (
    major === baseMajor &&
    compareVersions(version, base) <= 0 &&
    (minor < baseMinor || patch === 0)
  )
}

function compareVersions(left, right) {
  for (let part = 0; part < Math.max(left.parts.length, right.parts.length); part++) {
    const [a, b] = [left.parts[part] ?? 0, right.parts[part] ?? 0]
    if (a !== b) {
      return a - b
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0
  }
  if (left.prerelease === null) {
    return 1
  }
  if (right.prerelease === null) {
    return -1
  }

  return comparePrereleases(left.prerelease.split('.'), right.prerelease.split('.'))
}

// Semver order: numeric identifiers compare as numbers and sort before the
// others, and a shorter list sorts before a longer one it is the start of.
function comparePrereleases(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const [a, b] = [left[index], right[index]]
    if (a === b) {
      continue
    }

    const [aNumeric, bNumeric] = [/^\d+$/.test(a), /^\d+$/.test(b)]
    if (aNumeric && bNumeric) {
      return Number(a) - Number(b)
    }
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1
    }

    // Numeric, so that rc9 sorts before rc10.
    return a.localeCompare(b, 'en', { numeric: true })
  }

  return left.length - right.length
}

const releaseCache = new Map()

// One project supplies many of the modules in a single update, so ask it once,
// and read on only until the releases read so far are enough. A project that
// failed is not asked again.
async function readReleases(compare, enough) {
  const key = `${compare.host}/${compare.project}`
  if (!releaseCache.has(key)) {
    releaseCache.set(key, { releases: [], pages: 0, done: false, failure: null })
  }

  const state = releaseCache.get(key)
  while (!state.done && state.pages < RELEASE_PAGE_LIMIT && !enough(state.releases)) {
    if (state.failure) {
      throw state.failure
    }

    try {
      const { releases, done } = await compare.forge.releases(compare.project, state.pages + 1)
      state.releases.push(...releases)
      state.pages++
      state.done = done
    } catch (error) {
      state.failure = error

      throw error
    }
  }

  return state.releases
}

// A module tagged inside a monorepo does not always have a release of its own.
// The OpenTelemetry contrib repository, for one, publishes a single release per
// core version and names it after every module version that release carries
// ("Release v1.45.0/v2.5.2/v0.70.0/…"), so look for the new version in the
// release name when no release matches the tag itself. A guessed tag reaches
// here too, since guessing cannot reproduce a tag the project never used.
function releaseNamingVersion(releases, head, prefix) {
  const version = bareTag(head, prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mentioned = new RegExp(`(?:^|[^\\w.])v?${version}(?![\\w.])`)

  return releases.filter((release) => mentioned.test(release.name ?? ''))
}

// Every release the update moves through, oldest first, so that a bump over
// several versions shows all of them and not just the last one.
async function releasesInRange(compare) {
  if (isCommitHash(compare.base) || isCommitHash(compare.head)) {
    return []
  }

  const prefix = headPrefix(compare.head)
  const from = parseVersion(compare.base, prefix)
  const to = parseVersion(compare.head, prefix)
  if (!from || !to) {
    return releasesTagged(compare, prefix)
  }

  const ranges = [{ prefix, from, to, head: compare.head }]

  // A guess may have missed that the project tags by package.
  const packaged = compare.tagsAreGuessed ? packagePrefix(compare.name) : null
  if (packaged && packaged !== prefix) {
    const spell = (tag) => `${packaged}${bareTag(tag, prefix)}`
    ranges.push({
      prefix: packaged,
      from: parseVersion(spell(compare.base), packaged),
      to: parseVersion(spell(compare.head), packaged),
      head: spell(compare.head),
    })
  }

  // Releases come newest first, but a lower version does not end the search: a
  // backport to an older branch is published after the versions above it. Nor does
  // the base alone, which may be such a backport itself. The branch the base sits on
  // was started before anything above that branch, so reaching the start ends it.
  const reachedBase = (releases) =>
    ranges.some(({ prefix, from }) => {
      const versions = releases.map((release) => parseVersion(release.tag, prefix)).filter(Boolean)

      return (
        versions.some((version) => compareVersions(version, from) === 0) &&
        versions.some((version) => startsBranchOf(version, from))
      )
    })
  const releases = await readReleases(compare, reachedBase)
  const state = releaseCache.get(`${compare.host}/${compare.project}`)
  const cutShort = !state.done && state.pages >= RELEASE_PAGE_LIMIT

  for (const range of ranges) {
    const inRange = cutShort
      ? await completeRange(compare, releases, range)
      : selectRange(releases, range.prefix, range.from, range.to, range.head)
    if (inRange.length > 0) {
      return inRange
    }
  }

  return prefix === '' && !compare.tagsAreGuessed
    ? []
    : releaseNamingVersion(releases, compare.head, prefix)
}

const releaseLookups = new Map()

// One project's release by tag, asked once, for the packages that share it.
function lookUpRelease(compare, tag) {
  const key = `${compare.host}/${compare.project}/${tag}`
  if (!releaseLookups.has(key)) {
    releaseLookups.set(key, compare.forge.release(compare.project, tag))
  }

  return releaseLookups.get(key)
}

// A project may publish more releases than are worth paging through, canaries
// above all, and the range then lies past the pages read. Its tags name what is
// missing, newest first, and each of those is asked for by name. What still goes
// unread is said out loud: compare.incomplete ends up in the section.
async function completeRange(compare, releases, { prefix, from, to, head }) {
  const read = selectRange(releases, prefix, from, to, head)
  if (!compare.forge.tags) {
    compare.incomplete = true

    return read
  }

  const stem = head.slice(0, head.length - bareTag(head, prefix).length)
  const known = new Set(read.map((release) => release.tag))

  try {
    const missing = []
    let major = to.parts[0]
    const lowest = Math.max(from.parts[0], major - TAG_MAJOR_LIMIT + 1)
    for (; major >= lowest && missing.length <= RELEASE_LOOKUP_LIMIT; major--) {
      const tags = await compare.forge.tags(compare.project, `${stem}${major}.`)
      missing.unshift(
        ...selectRange(tags.map((tag) => ({ tag })), prefix, from, to, head)
          .map((release) => release.tag)
          .filter((tag) => !known.has(tag)),
      )
    }

    compare.incomplete = missing.length > RELEASE_LOOKUP_LIMIT || major >= from.parts[0]

    const found = await Promise.all(
      missing.slice(-RELEASE_LOOKUP_LIMIT).map((tag) => lookUpRelease(compare, tag)),
    )

    return selectRange([...read, ...found.filter(Boolean)], prefix, from, to, head)
  } catch (error) {
    console.warn(`${compare.project}: ${error.message}`)
    recordFailure(error)
    compare.incomplete = true

    return read
  }
}

// A tag that cannot be ordered (release-1.2.3-hotfix_2) can still be found by
// name, though not the releases on the way to it.
async function releasesTagged(compare, prefix) {
  const wanted = bareTag(compare.head, prefix)
  const tagged = (release) =>
    release.tag.startsWith(prefix) && bareTag(release.tag, prefix) === wanted
  const releases = await readReleases(compare, (releases) => releases.some(tagged))

  return releases.filter(tagged)
}

function selectRange(releases, prefix, from, to, head) {
  return releases
    .map((release) => ({ release, version: parseVersion(release.tag, prefix) }))
    .filter(({ release, version }) => {
      if (!version) {
        return false
      }
      if (version.prerelease && release.tag !== head) {
        return false
      }

      return compareVersions(version, from) > 0 && compareVersions(version, to) <= 0
    })
    .sort((left, right) => compareVersions(left.version, right.version))
    .map(({ release }) => release)
}

// Where a link to a changelog file points: /blob/main/packages/kit/CHANGELOG.md.
function changelogFile(url) {
  const link = /^https:\/\/(github\.com|gitlab\.com)\/(.+?)\/(?:-\/)?blob\/([^/]+)\/([^?#]+)/.exec(
    url ?? '',
  )
  if (!link || [link[2], link[3], link[4]].some((part) => part.includes('..'))) {
    return null
  }

  const [, host, project, ref, path] = link

  return host !== 'github.com' || /^[^/]+\/[^/]+$/.test(project)
    ? { forge: FORGES[host], project, ref, path: decodeURIComponent(path) }
    : null
}

// The version a changelog heading is about: 1.2.3, [1.2.3](link) - date, v1.2.3,
// Version 1.2.3, or pkg@1.2.3, which in a shared changelog may be another package's.
function headingVersion(title, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(
    `^[\\s\\[*_(\`]*([\\w./@-]*@|(?:release|version|ver\\.?|${escaped})\\s+)?` +
      'v?(\\d+(?:\\.\\d+)+(?:[-.]?[A-Za-z0-9][\\w.-]*)?)',
    'i',
  ).exec(title)
  if (!heading) {
    return null
  }

  // Not a version of this package, but it does end the section above it.
  return heading[1]?.endsWith('@') && heading[1] !== `${name}@` ? '' : heading[2]
}

// Every version a changelog has a heading for, Markdown or underlined, with what
// stands below it up to the next version at the same level or a heading above it.
function changelogSections(text, name) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const headings = []
  let fence = null

  for (let index = 0; index < lines.length; index++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index])?.[1]
    if (marker && (!fence || marker[0] === fence)) {
      fence = fence ? null : marker[0]
    }
    if (fence || marker) {
      continue
    }

    const atx = /^ {0,3}(#{1,6})\s+(.*)$/.exec(lines[index])
    const underline = /^(=+|-+)\s*$/.exec(lines[index + 1] ?? '')
    if (atx) {
      headings.push({
        index,
        start: index + 1,
        level: atx[1].length,
        version: headingVersion(atx[2], name),
      })
    } else if (lines[index].trim() && underline && underline[1].length >= 3) {
      headings.push({
        index,
        start: index + 2,
        level: underline[1][0] === '=' ? 1 : 2,
        version: headingVersion(lines[index], name),
      })
      index++
    }
  }

  return headings
    .filter((heading) => heading.version)
    .map((heading) => {
      const next = headings.find(
        (other) =>
          other.index > heading.index &&
          (other.level < heading.level || (other.version !== null && other.level <= heading.level)),
      )

      return {
        version: heading.version,
        body: lines.slice(heading.start, next?.index ?? lines.length).join('\n').trim(),
      }
    })
}

const changelogs = new Map()

// A project may keep its notes in a file and publish no releases at all. The notes
// of the versions in the range come out looking like releases, oldest first.
async function changelogNotes(update) {
  const file = changelogFile(update.links.Changelog)
  const from = parseVersion(update.from, '')
  const to = parseVersion(update.to, '')
  if (!file || !from || !to) {
    return []
  }

  const url = update.links.Changelog
  if (!changelogs.has(url)) {
    changelogs.set(url, file.forge.file(file.project, file.ref, file.path))
  }
  const text = await changelogs.get(url)
  if (!text) {
    return []
  }

  const sections = new Map(
    changelogSections(text, update.name)
      .toReversed()
      .map(({ version, body }) => [version, body]),
  )
  const notes = [...sections].map(([version, body]) => ({ tag: version, name: version, body, url }))

  return selectRange(notes, '', from, to, update.to).filter((note) => note.body)
}

// A fenced block, closed or running to the end of the text, or an inline span.
const CODE = /^ {0,3}(`{3,}|~{3,}).*$[\s\S]*?(?:^ {0,3}\1[`~]* *$|(?![\s\S]))|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\2(?!`)/gm

function outsideCode(text, transform) {
  let result = ''
  let position = 0

  for (const code of text.matchAll(CODE)) {
    result += transform(text.slice(position, code.index)) + code[0]
    position = code.index + code[0].length
  }

  return result + transform(text.slice(position))
}

// A link to github.com cross-references just as a bare #123 does, adding an entry
// to the timeline of the issue it names. Dependabot sends them through the
// redirect host, which GitHub does not read as a reference.
function quietLink(url) {
  return url?.replace(/^(\]\()?https?:\/\/(?:www\.)?github\.com\//i, '$1https://redirect.github.com/')
}

// Release notes are written for their own repository: a bare @handle, #123 or
// GH-123 would notify people and link to unrelated issues once quoted here. Dependabot
// breaks them with a zero width space and so do we, but not where the text means
// something else: code, a link's address, or the "@" of pkg@1.2.3. An issue
// number stays a reference after a name, as in owner/repo#123.
function defuseReferences(text) {
  return outsideCode(text.replace(/\r\n/g, '\n'), (prose) =>
    prose.replace(
      /\]\([^)\s]+|https?:\/\/[^\s<>)\]]+|(?<![\w/.#@-])[@#](?=[\w-])|#(?=\d)|(?<![\w/.#@-])gh(?=-\d)/gi,
      (match) => (/^(?:\]\(|http)/i.test(match) ? quietLink(match) : `${match}\u200b`),
    ),
  )
}

// A <details> in a release body would nest in or close the one around its section.
function stripDisclosures(text) {
  return outsideCode(text, (prose) => prose.replace(/<\/?(?:details|summary)\b[^>]*>/gi, ''))
}

// Tags GitHub renders that release notes have a use for. Any other is text that
// reads as a tag, as in "drop <object> and <iframe>", which GitHub may leave open
// over the other sections in the comment, so it stays text.
const KNOWN_TAGS = new Set(
  (
    'a abbr b blockquote br center code dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li ' +
    'ol p picture pre q s samp source span strike strong sub sup table tbody td tfoot th thead tr ' +
    'tt ul var video'
  ).split(' '),
)

function escapeUnknownTags(text) {
  return outsideCode(text, (prose) =>
    prose.replace(/<\/?([a-z][\w-]*)(?=[\s/>])[^<>]*>/gi, (tag, name) =>
      KNOWN_TAGS.has(name.toLowerCase()) ? tag : `&lt;${tag.slice(1)}`,
    ),
  )
}

// A code fence or HTML comment left open swallows everything after it, up to the
// other sections in the comment.
function closeOpenMarkup(text) {
  let fence = null
  let comment = false

  for (const line of text.split('\n')) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1]
      if (closing?.[0] === fence[0] && closing.length >= fence.length) {
        fence = null
      }
      continue
    }

    const opening = comment ? null : /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (opening) {
      fence = opening[1]
    } else if (!comment || line.includes('-->')) {
      comment = line.lastIndexOf('<!--') > line.lastIndexOf('-->')
    }
  }

  const closed = fence ? `${text}\n${fence}` : comment ? `${text} -->` : text
  const open = openHtmlBlocks(closed)

  return open.length > 0
    ? `${closed}\n${open.reverse().map((name) => `</${name}>`).join('')}`
    : closed
}

// The HTML a text leaves open, outermost first. An open <pre> or <table> takes the
// sections after it along, just as a fence does, and an open <b> carries on in them.
function openHtmlBlocks(text) {
  let prose = ''
  outsideCode(text, (part) => {
    prose += part

    return part
  })

  const open = []
  const tags =
    /<(\/?)(pre|table|div|blockquote|ul|ol|dl|a|abbr|b|center|code|del|em|h[1-6]|i|ins|kbd|q|s|samp|span|strike|strong|sub|sup|tt|var)\b[^>]*?(\/?)>/gi
  for (const [, closing, tag, selfClosing] of prose.replace(/<!--[\s\S]*?-->/g, '').matchAll(tags)) {
    const name = tag.toLowerCase()
    if (!closing && !selfClosing) {
      open.push(name)
    } else if (closing && open.includes(name)) {
      open.length = open.lastIndexOf(name)
    }
  }

  return open
}

function truncate(text, limit) {
  if (text.length <= limit) {
    return text
  }

  // The cut may land inside a tag, which would then swallow what follows it.
  const kept = text.slice(0, limit).trimEnd().replace(/<\/?[a-z][^<>]*$/i, '')

  return `${closeOpenMarkup(kept)}\n\n_… truncated._`
}

// Not every project publishes releases. The Go subrepositories publish none at
// all, the AWS SDK tags a release per day rather than per module version, and a
// GitLab project such as modernc.org/sqlite carries plain tags. The commits
// between the two tags are then the only account of the change there is.
function renderCommits(commits, total) {
  const listed = commits.slice(-COMMIT_LIST_LIMIT)
  const earlier = total - listed.length

  return [
    '_Commits in this range:_',
    '',
    ...(earlier > 0 ? [`- _… and ${earlier} earlier._`] : []),
    ...listed.map((commit) => `- [${defuseReferences(commit.title)}](${quietLink(commit.url)})`),
  ].join('\n')
}

// A release that carries no description is no better than no release at all.
// emersion/go-smtp, for one, publishes a release per tag and describes none of
// them, so the commits have to stand in.
function documented(releases) {
  return releases.some((release) => release.body?.trim())
}

// The module path the updates share, cut at a path element: the repository
// for modules that one repository publishes.
function commonModulePath(updates) {
  const [first, ...rest] = updates.map((update) => update.name.split('/'))
  let length = first.length
  for (const name of rest) {
    while (name.slice(0, length).join('/') !== first.slice(0, length).join('/')) {
      length--
    }
  }

  return first.slice(0, length).join('/')
}

function indirectMark(update) {
  return update.indirect ? ' (indirect)' : ''
}

function renderSummary(updates) {
  if (updates.length === 1) {
    const [update] = updates

    return `<code>${update.name}</code> — ${update.from} → ${update.to}${indirectMark(update)}`
  }

  // Packages of one repository need not share a path: react and react-dom.
  const shared = commonModulePath(updates) || compareFor(updates[0])?.project || updates[0].name

  return `<code>${shared}</code> — ${updates.length} packages`
}

// The notes of a dependency, oldest first, as far back as they fit: the version
// the update arrives at is the one a reviewer is deciding on. Whole notes go, so
// that nothing is cut in the middle, and each one is capped well below the limit.
function keepNewest(notes, limit) {
  const separator = '\n\n---\n\n'
  const kept = []
  let length = 0

  for (const note of notes.toReversed()) {
    if (kept.length > 0 && length + separator.length + note.length > limit) {
      break
    }

    kept.unshift(note)
    length += separator.length + note.length
  }

  const left = notes.length - kept.length
  const omitted = left > 0 ? [`_… and ${left} earlier ${left === 1 ? 'release' : 'releases'}._`] : []

  return [...omitted, ...kept].join(separator)
}

// Several updates share a section when their ranges list the same commits. The
// first one's links stand for all of them, since every range spans those commits.
function renderDependency({ updates, releases, commits, total, incomplete, fromChangelog }) {
  const links = Object.entries(updates[0].links)
    .map(([label, url]) => `[${label}](${url})`)
    .join(' · ')

  // Undescribed releases give way to the commits, but they beat nothing at all.
  const notes = !documented(releases) && commits.length > 0
    ? []
    : releases.map((release) => {
        const name = release.name?.trim() || release.tag
        const date = release.date?.slice(0, 10)
        const title = name.replace(/[[\]]/g, '\\$&')
        const link = release.url ? `[${title}](${quietLink(release.url)})` : title
        const heading = `**${link}**${date ? ` — ${date}` : ''}`
        const body = release.body?.trim()
          ? truncate(
              closeOpenMarkup(
                escapeUnknownTags(stripDisclosures(defuseReferences(release.body.trim()))),
              ),
              RELEASE_BODY_LIMIT,
            )
          : '_No release notes._'

        return `${heading}\n\n${body}`
      })

  if (notes.length === 0) {
    notes.push(
      commits.length > 0
        ? renderCommits(commits, total)
        : '_No release notes available for this package._',
    )
  }

  const section = [
    '<details>',
    `<summary>${renderSummary(updates)}</summary>`,
    '',
    ...(updates.length > 1
      ? [
          ...updates.map(
            (update) =>
              `- \`${update.name}\` ${update.from} → ${update.to}${indirectMark(update)}`,
          ),
          '',
        ]
      : []),
    ...(fromChangelog ? ['_From the changelog._', ''] : []),
    ...(incomplete ? ['_Older releases in this range were not read._', ''] : []),
    keepNewest(notes, DEPENDENCY_LIMIT),
    ...(links ? ['', links] : []),
    '</details>',
  ].join('\n')

  return section
}

// How far an update moves: the first part of the version that changes.
function bumpKind({ from, to }) {
  if (isCommitHash(from) || isCommitHash(to)) {
    return 'commit'
  }

  const [left, right] = [parseVersion(from, ''), parseVersion(to, '')]
  if (!left || !right) {
    return '—'
  }

  const part = [0, 1, 2].find((index) => (left.parts[index] ?? 0) !== (right.parts[index] ?? 0))

  return ['**major**', 'minor', 'patch'][part] ?? '—'
}

function shortRef(ref) {
  return isCommitHash(ref) ? ref.slice(0, 7) : ref
}

function notesKind({ releases, commits, fromChangelog }) {
  if (documented(releases)) {
    return fromChangelog
      ? 'Changelog'
      : `${releases.length} ${releases.length === 1 ? 'release' : 'releases'}`
  }

  return commits.length > 0 ? 'Commits' : 'None'
}

// A table of everything the update moves, since the notes may run over several
// comments and each section is folded.
function renderOverview(entries, listed = []) {
  const rows = [
    ...entries.flatMap((entry) => entry.updates.map((update) => ({ update, notes: notesKind(entry) }))),
    ...listed.map((update) => ({ update, notes: 'Not read' })),
  ]
  if (rows.length < 2 && !(listed.length > 0 && entries.length === 0)) {
    return null
  }

  const scoped = rows.some(({ update }) => update.indirect !== undefined)
  const lines = [
    `| Package | Update | Bump |${scoped ? ' Scope |' : ''} Notes |`,
    `| --- | --- | --- |${scoped ? ' --- |' : ''} --- |`,
  ]

  let length = 0
  let shown = 0
  for (const { update, notes } of rows) {
    const scope = update.indirect ? 'indirect' : 'direct'
    const line =
      `| \`${update.name}\` | \`${shortRef(update.from)}\` → \`${shortRef(update.to)}\` | ` +
      `${bumpKind(update)} |${scoped ? ` ${scope} |` : ''} ${notes} |`
    if (length + line.length > OVERVIEW_LIMIT) {
      break
    }

    lines.push(line)
    length += line.length + 1
    shown++
  }

  return [
    ...lines,
    ...(shown < rows.length ? ['', `_… and ${rows.length - shown} more._`] : []),
  ].join('\n')
}

function intoComments(sections) {
  const comments = []
  let current = []
  let length = 0

  for (const section of sections) {
    if (current.length > 0 && length + section.length > COMMENT_BUDGET) {
      comments.push(current)
      current = []
      length = 0
    }

    current.push(section)
    length += section.length + 2
  }

  if (current.length > 0) {
    comments.push(current)
  }

  return comments.map((sections, index) => {
    const part = comments.length > 1 ? ` (${index + 1}/${comments.length})` : ''

    return [
      MARKER,
      `### Release notes${part}`,
      '',
      sections.join('\n\n'),
    ].join('\n')
  })
}

async function previousComments() {
  const comments = await listAll(`/repos/${repository}/issues/${pullRequest}/comments`)

  // Anyone can write the marker into a comment, and those are not ours to edit.
  return comments.filter(
    (comment) => comment.user?.login === commentAuthor && comment.body?.startsWith(MARKER),
  )
}

// A guessed tag may carry the "v" the Go convention asks for or it may not, or be
// spelled after the package, and only the project knows which. An empty answer
// means the wrong guess.
async function listCommits(compare) {
  const attempts = [[compare.base, compare.head]]

  if (compare.tagsAreGuessed) {
    const bare = (tag) => tag.replace(/(^|\/)v(?=\d)/, '$1')
    attempts.push([bare(compare.base), bare(compare.head)])

    const packaged = packagePrefix(compare.name)
    if (packaged) {
      const prefix = headPrefix(compare.head)
      const spell = (tag) => `${packaged}${bareTag(tag, prefix)}`
      attempts.push([spell(compare.base), spell(compare.head)])
    }
  }

  const tried = new Set()
  for (const [base, head] of attempts) {
    if (tried.has(`${base}...${head}`)) {
      continue
    }
    tried.add(`${base}...${head}`)

    const found = await compare.forge.commits(compare.project, base, head)
    if (found.commits.length > 0) {
      return found
    }
  }

  return { commits: [], total: 0 }
}

// Once rate limited, the other lookups would only fail too and dig the hole deeper.
async function orNothing(update, lookup, nothing = []) {
  if (rateLimited) {
    return nothing
  }

  try {
    return await lookup()
  } catch (error) {
    console.warn(`${update.name}: ${error.message}`)
    recordFailure(error)

    return nothing
  }
}

// The action runs with a write token, and a pull request's commit messages and
// description decide what it asks for and quotes, so they have to be Dependabot's.
// A commit pushed on top of Dependabot's has no say, unless any-author is set.
async function readPullRequest() {
  const path = `/repos/${repository}/pulls/${pullRequest}`
  const pull = await api(path)
  if (!pull) {
    throw new Error(`GET ${path}: 404, check the pull request number and the token's access`)
  }

  if (pull.user?.login !== DEPENDABOT && !anyAuthor) {
    throw new Error(
      `Pull request ${pullRequest} was opened by ${pull.user?.login}, not ${DEPENDABOT}. ` +
        'Set any-author to run on it anyway.',
    )
  }

  return pull
}

// Every push to the pull request runs this again. Edit the comments already
// posted rather than replace them, so that they keep their place in the
// timeline and the replies and reactions they collected. A comment whose notes
// are unchanged is left alone, and only a part the notes no longer need goes,
// which is all of them once a push leaves nothing to report.
async function publish(comments) {
  if (dryRun) {
    if (comments.length > 0) {
      console.log(`\n${comments.join('\n\n========================================\n\n')}`)
    }

    return
  }

  const previous = await previousComments()

  // Notes that an outage left out are no reason to take back the ones already up.
  if (unavailable && previous.length > 0) {
    console.error('Keeping the comments already posted.')

    return
  }

  for (const [index, body] of comments.entries()) {
    const comment = previous[index]

    if (!comment) {
      await api(`/repos/${repository}/issues/${pullRequest}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
    } else if (comment.body !== body) {
      await api(`/repos/${repository}/issues/comments/${comment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      })
    }
  }

  for (const comment of previous.slice(comments.length)) {
    await api(`/repos/${repository}/issues/comments/${comment.id}`, { method: 'DELETE' })
  }
}

async function main() {
  if (!token || !repository || !pullRequest) {
    console.error('GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required')
    process.exit(1)
  }

  const pull = await readPullRequest()

  if (onlyWhenTruncated && !pull.body?.includes(TRUNCATED_DESCRIPTION)) {
    console.log('The description holds all of its notes, nothing to post.')
    await publish([])

    return
  }

  const commits = await listAll(`/repos/${repository}/pulls/${pullRequest}/commits`)
  const trusted = commits.filter((commit) => anyAuthor || commit.author?.login === DEPENDABOT)
  const announced = parseUpdates(
    trusted.map((commit) => commit.commit.message).join('\n'),
    pull.body ?? '',
  )
  const files = await listAll(`/repos/${repository}/pulls/${pullRequest}/files`)
  const listed = applyLockfileChanges(announced, await readLockfileChanges(files, trusted))
  const requirementChanges = parseRequirementChanges(files)

  const byRange = new Map(
    announced.map((update) => [`${update.name}@${update.from}...${update.to}`, update]),
  )
  const goUpdates = requirementChanges.map((change) => {
    const update = byRange.get(`${change.name}@${change.from}...${change.to}`)

    return update ? Object.assign(update, { indirect: change.indirect }) : change
  })

  // The go.mod changes stand in for the messages only as far as they speak for the
  // whole diff. A grouped update may move another ecosystem's packages too, and
  // GitHub leaves the patch out of a file too large to show.
  const diffIsReadable = files.every(
    (file) =>
      /(^|\/)go\.sum$/.test(file.filename) || (/(^|\/)go\.mod$/.test(file.filename) && file.patch),
  )
  const goNames = new Set(requirementChanges.map((change) => change.name))
  const updates = (
    requirementChanges.length > 0
      ? [
          ...goUpdates,
          ...(diffIsReadable ? [] : announced.filter((update) => !goNames.has(update.name))),
        ]
      : announced
  ).toSorted((left, right) => Number(Boolean(left.indirect)) - Number(Boolean(right.indirect)))

  // A requirement Dependabot did not announce, or announced only in a summary
  // table, has no compare link to read the tags from, and the one it did write
  // may name another module's. Without the proxy the tags are guessed from the
  // module path, which beats trusting a link known to be wrong.
  for (const update of goUpdates) {
    const foreign = hasForeignTags(update)
    if (update.links.Commits && !foreign) {
      continue
    }
    if (foreign) {
      delete update.links.Commits
    }

    const link = rateLimited ? null : await compareLinkFromProxy(update)
    if (link) {
      update.links.Commits = link
    }
  }

  // The AWS SDK publishes no releases and tags every module it ships on the same
  // release commit, so a single release moves a dozen modules through the same
  // commits. List those commits once, under all of the modules they moved. The
  // packages of one release, react and react-dom, share a section the same way.
  const entries = []
  const bySameNotes = new Map()
  for (const update of updates) {
    const compare = compareFor(update)
    let releases = compare ? await orNothing(update, () => releasesInRange(compare)) : []

    let fromChangelog = false
    if (!documented(releases)) {
      const notes = await orNothing(update, () => changelogNotes(update))
      if (documented(notes)) {
        releases = notes
        fromChangelog = true
      }
    }

    const { commits, total } =
      compare && !documented(releases)
        ? await orNothing(update, () => listCommits(compare), { commits: [], total: 0 })
        : { commits: [], total: 0 }

    const shown = documented(releases) || commits.length === 0 ? releases : commits
    const sameNotes =
      shown.length > 0
        ? shown.map((note) => `${note.url} ${note.name ?? note.title}`).join('\n')
        : null
    if (sameNotes && bySameNotes.has(sameNotes)) {
      bySameNotes.get(sameNotes).updates.push(update)
      continue
    }

    const entry = {
      updates: [update],
      releases,
      commits,
      total,
      incomplete: compare?.incomplete,
      fromChangelog,
    }
    entries.push(entry)
    if (sameNotes) {
      bySameNotes.set(sameNotes, entry)
    }
  }

  const overview = renderOverview(entries, listed)
  const comments = intoComments([
    ...(overview ? [overview] : []),
    ...entries.map(renderDependency),
  ])

  if (comments.length === 0) {
    console.log('No dependency updates found in the diff or the commit messages, nothing to post.')
  } else {
    console.log(
      `${updates.length} ${updates.length === 1 ? 'update' : 'updates'}, ` +
        (listed.length > 0 ? `${listed.length} listed from lockfiles, ` : '') +
        `${comments.length} comment(s): ` +
        comments.map((comment) => `${comment.length} chars`).join(', '),
    )
  }

  if (rateLimited) {
    console.error('Rate limited: some notes are missing. Run the action again later.')
  } else if (unavailable) {
    console.error('Some notes could not be read. Run the action again later.')
  }
  if (unavailable) {
    process.exitCode = 1
  }

  await publish(comments)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}

export {
  applyLockfileChanges,
  bumpKind,
  diffLockfile,
  parseCargoLock,
  parseComposerLock,
  parsePackageLock,
  changelogSections,
  closeOpenMarkup,
  compareFor,
  compareVersions,
  defuseReferences,
  escapeUnknownTags,
  hasForeignTags,
  headPrefix,
  isCommitHash,
  parseRequirementChanges,
  parseUpdates,
  parseVersion,
  projectFromLink,
  tagFromCommitsLink,
}
