// The updates Dependabot announces in its commit messages and description.

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
  const blocks = new Set()

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
      blocks.add(name)
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
  // `org.springframework` from a to b", above the blocks of the packages in it. A
  // package's own headline stands above a block of the same name, and stays.
  for (const key of headlines) {
    const { name, from, to, links } = updates.get(key)
    if (!blocks.has(name) && detailed.has(`${from}...${to}`) && Object.keys(links).length === 0) {
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

export {
  parseUpdates,
}
