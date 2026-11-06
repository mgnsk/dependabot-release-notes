// Finding the notes of an update: its releases, its changelog or its commits.

import { FORGES } from './forges.mjs'
import { rateLimited, recordFailure, warn } from './http.mjs'
import {
  bareTag,
  compareFor,
  compareVersions,
  headPrefix,
  isCommitHash,
  packagePrefix,
  parseVersion,
  startsBranchOf,
} from './tags.mjs'

// How many pages of 100 releases to read from one project, so that a project
// with thousands of releases cannot spend the token's whole hourly allowance.
const RELEASE_PAGE_LIMIT = 10

// How many releases to ask for by tag once those pages did not reach the base.
const RELEASE_LOOKUP_LIMIT = 20

// How many major versions to list the tags of on the way back from the new one.
const TAG_MAJOR_LIMIT = 5

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
    if (!compare.versionTags) {
      return []
    }

    const releases = await releasesInRange(compare.versionTags)
    compare.incomplete = compare.versionTags.incomplete

    return releases
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
    warn(`${compare.project}: ${error.message}`)
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
  if (!link) {
    return null
  }

  // The path is decoded before it is checked, so that %2e%2e cannot climb out of it.
  const [, host, project, ref, encodedPath] = link
  let path
  try {
    path = decodeURIComponent(encodedPath)
  } catch {
    return null
  }
  if ([project, ref, path].some((part) => part.includes('..'))) {
    return null
  }

  return host !== 'github.com' || /^[^/]+\/[^/]+$/.test(project)
    ? { forge: FORGES[host], project, ref, path }
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

// Where to look for a changelog when Dependabot links none: beside the package, when
// its tag or its commits link names the directory, and otherwise at the top of the
// repository. Each module of the AWS SDK keeps its own, for one, and publishes no
// releases at all.
function likelyChangelog(update, compare) {
  if (!compare) {
    return null
  }

  const inTag = /^(.*\/)[^/]*$/.exec(compare.head)?.[1]
  const inLink = update.links.Commits?.split(`/commits/${compare.head}/`)[1]
  const directory = inTag ?? (inLink ? `${inLink.replace(/\/$/, '')}/` : '')
  const path = `${directory}CHANGELOG.md`
  const blob = compare.host === 'gitlab.com' ? '-/blob' : 'blob'

  return {
    file: { forge: compare.forge, project: compare.project, ref: compare.head, path },
    url: `https://${compare.host}/${compare.project}/${blob}/${compare.head}/${path}`,
  }
}

const changelogs = new Map()

// A project may keep its notes in a file and publish no releases at all. The notes
// of the versions in the range come out looking like releases, oldest first.
async function changelogNotes(update, compare) {
  const linked = changelogFile(update.links.Changelog)
  const found = linked
    ? { file: linked, url: update.links.Changelog }
    : update.links.Changelog
      ? null
      : likelyChangelog(update, compare)
  const from = parseVersion(update.from, '')
  const to = parseVersion(update.to, '')
  if (!found || !from || !to) {
    return []
  }

  const { file, url } = found
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

  const inRange = selectRange(notes, '', from, to, update.to).filter((note) => note.body)
  if (inRange.length > 0) {
    update.links.Changelog ??= url
  }

  return inRange
}

// A release that carries no description is no better than no release at all.
// emersion/go-smtp, for one, publishes a release per tag and describes none of
// them, so the commits have to stand in.
function documented(releases) {
  return releases.some((release) => release.body?.trim())
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
    warn(`${update.name}: ${error.message}`)
    recordFailure(error)

    return nothing
  }
}

// The notes of every update. The AWS SDK publishes no releases and tags every module
// it ships on the same release commit, so a single release moves a dozen modules
// through the same commits. List those commits once, under all of the modules they
// moved. The packages of one release, react and react-dom, share a section the same
// way.
async function collectEntries(updates) {
  const entries = []
  const bySameNotes = new Map()

  for (const update of updates) {
    const compare = compareFor(update)
    let releases = compare ? await orNothing(update, () => releasesInRange(compare)) : []

    let fromChangelog = false
    if (!documented(releases)) {
      const notes = await orNothing(update, () => changelogNotes(update, compare))
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

  return entries
}

export {
  collectEntries,
  changelogNotes,
  changelogSections,
  documented,
  listCommits,
  orNothing,
  releasesInRange,
}
