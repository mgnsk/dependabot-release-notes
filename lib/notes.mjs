// Finding the notes of an update: its releases, its changelog or its commits.

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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    ? { host, project, ref, path }
    : null
}

// The version a changelog heading is about: 1.2.3, [1.2.3](link) - date, v1.2.3,
// Version 1.2.3, or pkg@1.2.3, which in a shared changelog may be another package's.
function headingVersion(title, name) {
  const escaped = escapeRegExp(name)
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
    file: { host: compare.host, project: compare.project, ref: compare.head, path },
    url: `https://${compare.host}/${compare.project}/${blob}/${compare.head}/${path}`,
  }
}

// A release that carries no description is no better than no release at all.
// emersion/go-smtp, for one, publishes a release per tag and describes none of
// them, so the commits have to stand in.
function documented(releases) {
  return releases.some((release) => release.body?.trim())
}


// The tags a range may go by. A guessed tag may carry the "v" the Go convention asks
// for or it may not, or be spelled after the package, and only the project knows which.
function tagSpellings(compare) {
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

  return [...new Map(attempts.map(([base, head]) => [`${base}...${head}`, { base, head }])).values()]
}

const NO_COMMITS = { commits: [], total: 0 }

// What one run asks the forges. One project supplies many of the modules in a single
// update, so each project, release and changelog is asked for once.
function createNotes({ client, forges }) {
  const releaseCache = new Map()
  const changelogs = new Map()

  // Read on only until the releases read so far are enough. A project that failed
  // is not asked again. Whether the pages ran out before the releases did is said.
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
        const { releases, done } = await forges[compare.host].releases(compare.project, state.pages + 1)
        state.releases.push(...releases)
        state.pages++
        state.done = done
      } catch (error) {
        state.failure = error

        throw error
      }
    }

    return { releases: state.releases, cutShort: !state.done && state.pages >= RELEASE_PAGE_LIMIT }
  }

  // Every release the update moves through, oldest first, so that a bump over
  // several versions shows all of them and not just the last one. A project may
  // publish more releases than are worth paging through, canaries above all, and the
  // range then lies past the pages read, which is said out loud.
  async function releasesInRange(compare) {
    if (isCommitHash(compare.base) || isCommitHash(compare.head)) {
      return compare.versionTags
        ? releasesInRange(compare.versionTags)
        : { releases: [], incomplete: false }
    }

    const prefix = headPrefix(compare.head)
    const from = parseVersion(compare.base, prefix)
    const to = parseVersion(compare.head, prefix)
    if (!from || !to) {
      return { releases: await releasesTagged(compare, prefix), incomplete: false }
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
    const { releases, cutShort } = await readReleases(compare, reachedBase)

    for (const { prefix, from, to, head } of ranges) {
      const inRange = selectRange(releases, prefix, from, to, head)
      if (inRange.length > 0) {
        return { releases: inRange, incomplete: cutShort }
      }
    }

    return { releases: [], incomplete: cutShort }
  }

  // A tag that cannot be ordered (release-1.2.3-hotfix_2) can still be found by
  // name, though not the releases on the way to it.
  async function releasesTagged(compare, prefix) {
    const wanted = bareTag(compare.head, prefix)
    const tagged = (release) =>
      release.tag.startsWith(prefix) && bareTag(release.tag, prefix) === wanted
    const { releases } = await readReleases(compare, (releases) => releases.some(tagged))

    return releases.filter(tagged)
  }

  // A project may keep its notes in a file and publish no releases at all. The notes
  // of the versions in the range come out looking like releases, oldest first, along
  // with where the file is.
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
      return { notes: [], url: null }
    }

    const { file, url } = found
    if (!changelogs.has(url)) {
      changelogs.set(url, forges[file.host].file(file.project, file.ref, file.path))
    }
    const text = await changelogs.get(url)
    if (!text) {
      return { notes: [], url }
    }

    const sections = new Map(
      changelogSections(text, update.name)
        .toReversed()
        .map(({ version, body }) => [version, body]),
    )
    const notes = [...sections].map(([version, body]) => ({ tag: version, name: version, body, url }))

    return { notes: selectRange(notes, '', from, to, update.to).filter((note) => note.body), url }
  }

  // An empty answer means a wrong guess at the tags.
  async function listCommits(compare) {
    for (const { base, head } of tagSpellings(compare)) {
      const found = await forges[compare.host].commits(compare.project, base, head)
      if (found.commits.length > 0) {
        return found
      }
    }

    return NO_COMMITS
  }

  // The notes of one update, from the first of its releases, its changelog and its
  // commits that has any. The update comes back with the changelog it was found in.
  async function notesOf(update) {
    const compare = compareFor(update)
    const inRange = compare
      ? await client.orNothing(update.name, () => releasesInRange(compare), { releases: [], incomplete: false })
      : { releases: [], incomplete: false }

    if (!documented(inRange.releases)) {
      const changelog = await client.orNothing(update.name, () => changelogNotes(update, compare), {
        notes: [],
        url: null,
      })
      if (documented(changelog.notes)) {
        return {
          update: { ...update, links: { ...update.links, Changelog: update.links.Changelog ?? changelog.url } },
          releases: changelog.notes,
          commits: [],
          total: 0,
          incomplete: inRange.incomplete,
          fromChangelog: true,
        }
      }
    }

    const { commits, total } =
      compare && !documented(inRange.releases)
        ? await client.orNothing(update.name, () => listCommits(compare), NO_COMMITS)
        : NO_COMMITS

    return { update, ...inRange, commits, total, fromChangelog: false }
  }

  // The notes of every update. The AWS SDK publishes no releases and tags every module
  // it ships on the same release commit, so a single release moves a dozen modules
  // through the same commits. List those commits once, under all of the modules they
  // moved. The packages of one release, react and react-dom, share a section the same
  // way.
  async function collectEntries(updates) {
    const entries = []
    const bySameNotes = new Map()

    for (const original of updates) {
      const { update, releases, commits, total, incomplete, fromChangelog } = await notesOf(original)

      const shown = documented(releases) || commits.length === 0 ? releases : commits
      const sameNotes =
        shown.length > 0
          ? shown.map((note) => `${note.url} ${note.name ?? note.title}`).join('\n')
          : null
      const shared = sameNotes && bySameNotes.get(sameNotes)
      if (shared) {
        shared.updates.push(update)
        // One range may reach further back than the others, past what was read.
        shared.incomplete ||= incomplete
        continue
      }

      const entry = { updates: [update], releases, commits, total, incomplete, fromChangelog }
      entries.push(entry)
      if (sameNotes) {
        bySameNotes.set(sameNotes, entry)
      }
    }

    return entries
  }

  return { collectEntries }
}

export {
  changelogSections,
  createNotes,
  documented,
}
