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
// Usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
//          node dependabot-release-notes.mjs [--dry-run]

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

const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const pullRequest = process.env.PR_NUMBER
const dryRun = process.argv.includes('--dry-run')

if (!token || !repository || !pullRequest) {
  console.error('GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required')
  process.exit(1)
}

async function request(url, init = {}) {
  const response = await fetch(url, init)

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}`,
    )
  }

  return response.status === 204 ? null : response.json()
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

// A dependency's notes live on whichever forge hosts it, so each forge answers
// the same two questions: which releases does it publish, and which commits lie
// between two tags. Both shapes are normalised here and nowhere else.
const FORGES = {
  'github.com': {
    async releases(project) {
      const releases = await api(`/repos/${project}/releases?per_page=100`)

      return (releases ?? [])
        .filter((release) => !release.draft)
        .map((release) => ({
          tag: release.tag_name,
          name: release.name,
          body: release.body,
          url: release.html_url,
          date: release.published_at,
        }))
    },

    async commits(project, base, head) {
      const compare = await api(`/repos/${project}/compare/${base}...${head}`)

      return (compare?.commits ?? []).map((commit) => ({
        title: commit.commit.message.split('\n')[0],
        url: commit.html_url,
      }))
    },
  },

  'gitlab.com': {
    async releases(project) {
      const releases = await request(
        `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/releases?per_page=100`,
      )

      return (releases ?? [])
        .filter((release) => !release.upcoming_release)
        .map((release) => ({
          tag: release.tag_name,
          name: release.name,
          body: release.description,
          url: release._links?.self,
          date: release.released_at,
        }))
    },

    async commits(project, base, head) {
      const compare = await request(
        `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/repository/compare` +
          `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
      )

      return (compare?.commits ?? []).map((commit) => ({
        title: commit.title,
        url: commit.web_url,
      }))
    },
  },
}

// A grouped update repeats an "Updates `pkg` from a to b" block, followed by its
// links, once per directory the dependency was updated in. A dependency that
// matches no group gets a pull request of its own, and that one opens with
// "Bumps [pkg](url) from a to b." and carries no Updates block at all.
const UPDATE_FORMS = [
  /^Updates `([^`]+)` from (\S+) to (\S+)$/,
  /^Bumps \[([^\]]+)]\([^)]+\) from (\S+) to (\S+?)(?: in \S+)?\.?$/,
  /^Bumps ([^\s[\]]+) from (\S+) to (\S+?)(?: in \S+)?\.?$/,
]

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
function parseUpdates(message) {
  const lines = message.split('\n')
  const updates = new Map()

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
    const [, name, from, to] = update
    const key = `${name}@${from}...${to}`
    if (!updates.has(key)) {
      updates.set(key, { name, from, to, links })
    }
  }

  for (const tabled of parseTables(message)) {
    const key = `${tabled.name}@${tabled.from}...${tabled.to}`
    if (!updates.has(key)) {
      updates.set(key, tabled)
    }
  }

  return [...updates.values()]
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
    tabled.push({ name, from, to, links: project ? { Repository: project } : {}, project })
  }

  return tabled
}

// A requirement in go.mod, inside a require block or on a require line of its
// own. A replace directive carries "=>" after the version and never matches.
const REQUIREMENT = /^([-+])(?:require\s+|\s+)(\S+)\s+(v\S+)(?:\s+\/\/.*)?$/

// Every requirement whose version a go.mod file in the diff changes. A module
// the diff only adds or only drops has no range to report.
function parseRequirementChanges(files) {
  const changes = new Map()

  for (const file of files.filter((file) => /(^|\/)go\.mod$/.test(file.filename))) {
    const removed = new Map()
    const added = new Map()

    for (const line of (file.patch ?? '').split('\n')) {
      const requirement = REQUIREMENT.exec(line)
      if (requirement) {
        ;(requirement[1] === '-' ? removed : added).set(requirement[2], requirement[3])
      }
    }

    // Dependabot writes versions without the "v" go.mod gives them, and the
    // ranges have to agree for its links to be found.
    for (const [name, to] of added) {
      const from = removed.get(name)
      if (from && from !== to) {
        const update = { name, from: from.slice(1), to: to.slice(1), links: {} }
        changes.set(`${name}@${update.from}...${update.to}`, update)
      }
    }
  }

  return [...changes.values()]
}

async function pullRequestFiles() {
  const files = []

  for (let page = 1; ; page++) {
    const batch =
      (await api(`/repos/${repository}/pulls/${pullRequest}/files?per_page=100&page=${page}`)) ??
      []
    files.push(...batch)

    if (batch.length < 100) {
      return files
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

  const [base, head] = compare[3].split('...')
  if (!base || !head) {
    return null
  }

  return { forge: FORGES[compare[1]], project: compare[2], base, head }
}

// A module that sits in a subdirectory of its repository is tagged with that
// subdirectory ahead of the version, which is how Go resolves a submodule tag.
// The major version suffix is part of the module path rather than the directory.
function tagPrefix(name, root) {
  const module = name.replace(/\/v\d+$/, '')

  return module.startsWith(`${root}/`) ? `${module.slice(root.length + 1)}/` : ''
}

// A dependency recovered from a summary table has a project but no tags. Version
// matching strips a leading "v" from both sides, so the releases are found
// either way; only the compare call needs the tag spelled as the project spells
// it, and that is settled by trying the Go convention first.
function compareFromProject(update) {
  const project = /^https:\/\/(github\.com|gitlab\.com)\/(.+?)\/?$/.exec(update.project ?? '')
  if (!project) {
    return null
  }

  const [, host, path] = project
  const prefix = tagPrefix(update.name, `${host}/${path}`)

  return {
    forge: FORGES[host],
    project: path,
    base: `${prefix}v${update.from}`,
    head: `${prefix}v${update.to}`,
    tagsAreGuessed: true,
  }
}

function parseVersion(tag, prefix) {
  if (!tag.startsWith(prefix)) {
    return null
  }

  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(
    tag.slice(prefix.length).replace(/^v/, ''),
  )
  if (!version) {
    return null
  }

  return {
    parts: [Number(version[1]), Number(version[2]), Number(version[3])],
    prerelease: version[4] ?? null,
  }
}

function compareVersions(left, right) {
  for (let part = 0; part < 3; part++) {
    if (left.parts[part] !== right.parts[part]) {
      return left.parts[part] - right.parts[part]
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

  return left.prerelease < right.prerelease ? -1 : 1
}

const releaseCache = new Map()

// One project supplies many of the modules in a single update, so ask it once.
async function listReleases(compare) {
  const key = `${compare.project}`
  if (!releaseCache.has(key)) {
    releaseCache.set(key, await compare.forge.releases(compare.project))
  }

  return releaseCache.get(key)
}

// A module tagged inside a monorepo does not always have a release of its own.
// The OpenTelemetry contrib repository, for one, publishes a single release per
// core version and names it after every module version that release carries
// ("Release v1.45.0/v2.5.2/v0.70.0/…"), so look for the new version in the
// release name when no release matches the tag itself. A guessed tag reaches
// here too, since guessing cannot reproduce a tag the project never used.
function releaseNamingVersion(releases, head) {
  const version = head.slice(head.lastIndexOf('/') + 1).replace(/^v/, '')
  const mentioned = new RegExp(`(?:^|[^\\w.])v?${version.replace(/\./g, '\\.')}(?![\\w.])`)

  return releases.filter((release) => mentioned.test(release.name ?? ''))
}

// Every release the update moves through, oldest first, so that a bump over
// several versions shows all of them and not just the last one.
async function releasesInRange(compare) {
  const prefix = compare.head.slice(0, compare.head.lastIndexOf('/') + 1)
  const from = parseVersion(compare.base, prefix)
  const to = parseVersion(compare.head, prefix)
  if (!from || !to) {
    return []
  }

  const releases = await listReleases(compare)
  const inRange = selectRange(releases, prefix, from, to, compare.head)

  if (inRange.length > 0 || (prefix === '' && !compare.tagsAreGuessed)) {
    return inRange
  }

  return releaseNamingVersion(releases, compare.head)
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

// Release notes are written for their own repository: a bare @handle or #123
// would notify people and link to unrelated issues once quoted here. Dependabot
// breaks them with a zero width space and so do we.
function defuseReferences(text) {
  return text.replace(/\r\n/g, '\n').replace(/([@#])(?=[\w-])/g, '$1​')
}

function truncate(text, limit) {
  if (text.length <= limit) {
    return text
  }

  return `${text.slice(0, limit).trimEnd()}\n\n_… truncated._`
}

// Not every project publishes releases. The Go subrepositories publish none at
// all, the AWS SDK tags a release per day rather than per module version, and a
// GitLab project such as modernc.org/sqlite carries plain tags. The commits
// between the two tags are then the only account of the change there is.
function renderCommits(commits) {
  const listed = commits.slice(0, COMMIT_LIST_LIMIT)
  const remaining = commits.length - listed.length

  return [
    '_No release published. Commits in this range:_',
    '',
    ...listed.map((commit) => `- [${defuseReferences(commit.title)}](${commit.url})`),
    ...(remaining > 0 ? [`- _… and ${remaining} more._`] : []),
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

function renderSummary(updates) {
  if (updates.length === 1) {
    const [update] = updates

    return `<code>${update.name}</code> — ${update.from} → ${update.to}`
  }

  return `<code>${commonModulePath(updates)}</code> — ${updates.length} modules`
}

// Several updates share a section when their ranges list the same commits. The
// first one's links stand for all of them, since every range spans those commits.
function renderDependency(updates, releases, commits) {
  const links = Object.entries(updates[0].links)
    .map(([label, url]) => `[${label}](${url})`)
    .join(' · ')

  const notes = !documented(releases)
    ? []
    : releases.map((release) => {
        const name = release.name?.trim() || release.tag
        const date = release.date?.slice(0, 10)
        const heading = `**[${name}](${release.url})**${date ? ` — ${date}` : ''}`
        const body = release.body?.trim()
          ? truncate(defuseReferences(release.body.trim()), RELEASE_BODY_LIMIT)
          : '_No release notes._'

        return `${heading}\n\n${body}`
      })

  if (notes.length === 0) {
    notes.push(
      commits.length > 0
        ? renderCommits(commits)
        : '_No release notes available for this package._',
    )
  }

  const section = [
    '<details>',
    `<summary>${renderSummary(updates)}</summary>`,
    '',
    ...(updates.length > 1
      ? [
          ...updates.map((update) => `- \`${update.name}\` ${update.from} → ${update.to}`),
          '',
        ]
      : []),
    truncate(notes.join('\n\n---\n\n'), DEPENDENCY_LIMIT),
    ...(links ? ['', links] : []),
    '</details>',
  ].join('\n')

  return section
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
  const comments =
    (await api(`/repos/${repository}/issues/${pullRequest}/comments?per_page=100`)) ?? []

  return comments.filter((comment) => comment.body?.startsWith(MARKER))
}

const commits = await api(`/repos/${repository}/pulls/${pullRequest}/commits?per_page=100`)
const announced = parseUpdates((commits ?? []).map((commit) => commit.commit.message).join('\n'))
const requirementChanges = parseRequirementChanges(await pullRequestFiles())

const byRange = new Map(
  announced.map((update) => [`${update.name}@${update.from}...${update.to}`, update]),
)
const updates =
  requirementChanges.length > 0
    ? requirementChanges.map(
        (change) => byRange.get(`${change.name}@${change.from}...${change.to}`) ?? change,
      )
    : announced

if (updates.length === 0) {
  console.log('No dependency updates found in the diff or the commit messages, nothing to post.')
  process.exit(0)
}

// A requirement Dependabot did not announce, or announced only in a summary
// table, has no compare link to read the tags from.
if (requirementChanges.length > 0) {
  for (const update of updates.filter((update) => !update.links.Commits)) {
    const link = await compareLinkFromProxy(update)
    if (link) {
      update.links.Commits = link
    }
  }
}

// A guessed tag may carry the "v" the Go convention asks for or it may not, and
// only the project knows which. An empty answer means the wrong guess.
async function listCommits(compare) {
  const commits = await compare.forge.commits(compare.project, compare.base, compare.head)
  if (commits.length > 0 || !compare.tagsAreGuessed) {
    return commits
  }

  const bare = (tag) => tag.replace(/(^|\/)v(?=\d)/, '$1')

  return compare.forge.commits(compare.project, bare(compare.base), bare(compare.head))
}

// The AWS SDK publishes no releases and tags every module it ships on the same
// release commit, so a single release moves a dozen modules through the same
// commits. List those commits once, under all of the modules they moved.
const entries = []
const byCommits = new Map()
for (const update of updates) {
  const compare = parseCompareLink(update.links.Commits) ?? compareFromProject(update)
  const releases = compare ? await releasesInRange(compare) : []
  const commits = compare && !documented(releases) ? await listCommits(compare) : []

  const range = commits.length > 0 ? commits.map((commit) => commit.url).join(' ') : null
  if (range && byCommits.has(range)) {
    byCommits.get(range).updates.push(update)
    continue
  }

  const entry = { updates: [update], releases, commits }
  entries.push(entry)
  if (range) {
    byCommits.set(range, entry)
  }
}

const sections = entries.map((entry) =>
  renderDependency(entry.updates, entry.releases, entry.commits),
)

const comments = intoComments(sections)

console.log(
  `${updates.length} updates, ${comments.length} comment(s): ` +
    comments.map((comment) => `${comment.length} chars`).join(', '),
)

if (dryRun) {
  console.log(`\n${comments.join('\n\n========================================\n\n')}`)
  process.exit(0)
}

// Every push to the pull request runs this again. Edit the comments already
// posted rather than replace them, so that they keep their place in the
// timeline and the replies and reactions they collected. A comment whose notes
// are unchanged is left alone, and only a part the notes no longer need goes.
const previous = await previousComments()

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
