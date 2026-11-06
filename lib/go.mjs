// What go.mod and the Go module proxy add for Go modules.

import { rangeKey } from './updates.mjs'

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
        const update = { name, from: from.slice(1), to: to.slice(1), links: {} }
        const key = rangeKey(update)
        // A module that one go.mod imports itself is a direct dependency.
        changes.set(key, { ...update, indirect: indirect && (changes.get(key)?.indirect ?? true) })
      }
    }
  }

  return [...changes.values()]
}

// The module proxy records where it fetched each version from: the repository,
// and the tag or, for a pseudo-version, the commit. That names the tags exactly,
// even for a module that sits in a subdirectory or behind a vanity import path.
// The proxy is public, so it is asked without the token.
async function proxyOrigin(client, name, version) {
  const escape = (text) => text.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)
  const info = await client.orNothing(`${name}@${version}`, () =>
    client.request(`https://proxy.golang.org/${escape(name)}/@v/${escape(version)}.info`),
  )

  return info?.Origin ?? null
}

// The Go project hosts golang.org/x on its own Gerrit and mirrors each of those
// repositories to github.com/golang, where the commits can be compared. Its protobuf
// module is the exception: github.com/golang/protobuf is a different, older module.
const GERRIT_MIRRORS = {
  protobuf: 'protocolbuffers/protobuf-go',
}

function fromGerrit(url) {
  return url.replace(
    /^https:\/\/go\.googlesource\.com\/([^/]+)/,
    (_, name) => `https://github.com/${GERRIT_MIRRORS[name] ?? `golang/${name}`}`,
  )
}

async function compareLinkFromProxy(client, update) {
  const from = await proxyOrigin(client, update.name, `v${update.from}`)
  const to = await proxyOrigin(client, update.name, `v${update.to}`)
  if (!from || !to || from.URL !== to.URL) {
    return null
  }

  const project = /^https:\/\/(github\.com|gitlab\.com)\/(.+?)(?:\.git)?\/?$/.exec(
    fromGerrit(to.URL),
  )
  if (!project) {
    return null
  }

  const ref = (origin) =>
    origin.Ref?.startsWith('refs/tags/') ? origin.Ref.slice('refs/tags/'.length) : origin.Hash
  const compare = project[1] === 'gitlab.com' ? '-/compare' : 'compare'

  return `https://${project[1]}/${project[2]}/${compare}/${ref(from)}...${ref(to)}`
}

// What the go.mod changes make of the announced updates. They stand in for the
// messages only as far as they speak for the whole diff. A grouped update may move
// another ecosystem's packages too, and GitHub leaves the patch out of a file too
// large to show. Those of the announced updates that may be such are the others.
function mergeRequirements(files, announced) {
  const requirementChanges = parseRequirementChanges(files)
  if (requirementChanges.length === 0) {
    return { goUpdates: [], others: announced }
  }

  const byRange = new Map(announced.map((update) => [rangeKey(update), update]))
  const goUpdates = requirementChanges.map((change) => {
    const update = byRange.get(rangeKey(change))

    return update ? { ...update, indirect: change.indirect } : change
  })

  const diffIsReadable = files.every(
    (file) =>
      /(^|\/)go\.sum$/.test(file.filename) || (/(^|\/)go\.mod$/.test(file.filename) && file.patch),
  )
  const goNames = new Set(requirementChanges.map((change) => change.name))

  return {
    goUpdates,
    others: diffIsReadable ? [] : announced.filter((update) => !goNames.has(update.name)),
  }
}

// A requirement Dependabot did not announce, or announced only in a summary table,
// has no compare link to read the tags from. Without the proxy the tags are guessed
// from the module path.
async function completeGoLinks(client, goUpdates) {
  const completed = []

  for (const update of goUpdates) {
    const link =
      update.links.Commits || client.rateLimited ? null : await compareLinkFromProxy(client, update)
    completed.push(link ? { ...update, links: { ...update.links, Commits: link } } : update)
  }

  return completed
}

export {
  completeGoLinks,
  mergeRequirements,
}
