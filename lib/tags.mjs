// Reading versions out of tags, and tags out of Dependabot's links.

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

  return { host: compare[1], project: compare[2], base, head }
}

// A module that sits in a subdirectory of its repository is tagged with that
// subdirectory ahead of the version, which is how Go resolves a submodule tag.
// The major version suffix is part of the module path rather than the directory.
function tagPrefix(name, root) {
  const module = name.replace(/\/v\d+$/, '')

  return module.startsWith(`${root}/`) ? `${module.slice(root.length + 1)}/` : ''
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
// guessed: as the new tag a link gave, or else by the Go convention. Version matching
// strips a leading "v" from both sides, so the releases are found either way, and only
// the commits of a project that spells its tags otherwise are missed.
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
    project,
    base: head ? `${head.slice(0, -update.to.length)}${update.from}` : `${prefix}v${update.from}`,
    head: head ?? `${prefix}v${update.to}`,
  }
}

// What was found in a link goes into a request that carries the token, and a
// commit message is only as trustworthy as whoever pushed the commit.
function compareFor(update) {
  const compare = parseCompareLink(update.links.Commits) ?? compareFromProject(update)
  if (!compare || [compare.project, compare.base, compare.head].some((part) => part.includes('..'))) {
    return null
  }

  if (compare.host === 'github.com' && !/^[^/]+\/[^/]+$/.test(compare.project)) {
    return null
  }

  return { ...compare, versionTags: versionTagsOf(update, compare) }
}

// An action pinned to a commit hash links the two hashes, while the update still
// names the versions they stand for, and those are what its releases are tagged with.
// A Go pseudo-version names no release, as its zeros or its date give away.
function versionTagsOf(update, compare) {
  const pinned = isCommitHash(compare.base) || isCommitHash(compare.head)
  const named =
    !isPinned(update) &&
    [update.from, update.to].every(
      (version) => parseVersion(version, '') && !/^v?0\.0\.0-|\d{14}/.test(version),
    )
  if (!pinned || !named) {
    return null
  }

  return {
    ...compare,
    base: `v${update.from.replace(/^v/, '')}`,
    head: `v${update.to.replace(/^v/, '')}`,
  }
}

// The two sides of a pseudo-version's range are commit hashes, which name no
// release, and a hash that starts with digits would read as a version. A short one
// may be all digits, which only the quotes Dependabot puts around it tell apart.
function isCommitHash(ref) {
  return /^[0-9a-f]{40}$/i.test(ref) || (/^[0-9a-f]{7,39}$/i.test(ref) && /[a-f]/i.test(ref))
}

// Whether an update moves from one commit to another rather than between versions.
function isPinned(update) {
  return Boolean(update.pinned) || isCommitHash(update.from) || isCommitHash(update.to)
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

export {
  bareTag,
  compareFor,
  compareVersions,
  headPrefix,
  isCommitHash,
  isPinned,
  parseVersion,
  projectFromLink,
  startsBranchOf,
  tagFromCommitsLink,
}
