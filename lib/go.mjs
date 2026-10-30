// What go.mod and the Go module proxy add for Go modules.

import { rateLimited, recordFailure, request, warn } from './http.mjs'
import { headPrefix, isCommitHash, parseCompareLink, tagPrefix } from './tags.mjs'

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
    warn(`${name}@${version}: ${error.message}`)
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

// What the go.mod changes make of the announced updates. They stand in for the
// messages only as far as they speak for the whole diff. A grouped update may move
// another ecosystem's packages too, and GitHub leaves the patch out of a file too
// large to show.
function mergeRequirements(files, announced) {
  const requirementChanges = parseRequirementChanges(files)
  if (requirementChanges.length === 0) {
    return { updates: announced, goUpdates: [] }
  }

  const byRange = new Map(
    announced.map((update) => [`${update.name}@${update.from}...${update.to}`, update]),
  )
  const goUpdates = requirementChanges.map((change) => {
    const update = byRange.get(`${change.name}@${change.from}...${change.to}`)

    return update ? Object.assign(update, { indirect: change.indirect }) : change
  })

  const diffIsReadable = files.every(
    (file) =>
      /(^|\/)go\.sum$/.test(file.filename) || (/(^|\/)go\.mod$/.test(file.filename) && file.patch),
  )
  const goNames = new Set(requirementChanges.map((change) => change.name))

  return {
    goUpdates,
    updates: [
      ...goUpdates,
      ...(diffIsReadable ? [] : announced.filter((update) => !goNames.has(update.name))),
    ],
  }
}

// A requirement Dependabot did not announce, or announced only in a summary table,
// has no compare link to read the tags from, and the one it did write may name
// another module's. Without the proxy the tags are guessed from the module path,
// which beats trusting a link known to be wrong.
async function completeGoLinks(goUpdates) {
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
}

export {
  completeGoLinks,
  mergeRequirements,
  compareLinkFromProxy,
  hasForeignTags,
  parseRequirementChanges,
}
