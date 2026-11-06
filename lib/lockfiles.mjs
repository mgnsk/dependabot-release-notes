// What moved according to the lockfiles of npm, pnpm, Yarn, uv, Poetry, Cargo and Composer.

import { api, pathRef, recordFailure, repository, warn } from './http.mjs'

// How many lockfiles to read, at two requests each, in an update across directories.
const LOCKFILE_LIMIT = 20

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

// The [[package]] tables of a TOML lockfile, each with what belongs to it.
function tomlPackages(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/^\[\[package]]$/m)
    .slice(1)
    .map((block) => {
      const table = block.split(/^\[\[/m)[0]

      return { table, field: (name) => new RegExp(`^${name} = "(.*)"$`, 'm').exec(table)?.[1] }
    })
}

// A package without a source is a crate of the workspace, and what those depend on
// is direct. A dependency reads "name", "name 1.2.3" or "name 1.2.3 (source)".
function parseCargoLock(text) {
  const versions = new Map()
  const direct = new Set()

  for (const { table, field } of tomlPackages(text)) {
    if (field('source')) {
      addVersion(versions, field('name'), field('version'))
    } else {
      const dependencies = /^dependencies = \[([^\]]*)]/m.exec(table)?.[1] ?? ''
      for (const [, name] of dependencies.matchAll(/"([^"\s]+)[^"]*"/g)) {
        direct.add(name)
      }
    }
  }

  return { versions, direct }
}

// Python folds the case and punctuation of a name: Typing_Extensions is
// typing-extensions, and Dependabot and the lockfile need not spell it alike.
function pythonName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

// A package with a source of its own in the project is the project or a workspace
// of it, and what it depends on is direct. Its metadata repeats those with their
// constraints, and is not read.
function parseUvLock(text) {
  const versions = new Map()
  const direct = new Set()

  for (const { table, field } of tomlPackages(text)) {
    if (/^source = \{ (?:virtual|editable|directory) =/m.test(table)) {
      const own = table.split(/^\[package\.metadata/m)[0]
      for (const [, name] of own.matchAll(/\{ name = "([^"]+)"/g)) {
        direct.add(pythonName(name))
      }
    } else if (field('name')) {
      addVersion(versions, pythonName(field('name')), field('version'))
    }
  }

  return { versions, direct, python: true }
}

// What a pyproject.toml asks for, in Poetry's tables and in the standard lists.
function pyprojectRequirements(text) {
  const names = new Set()
  let section = ''
  let inList = false

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^\[([^\]]+)]\s*$/.exec(line)
    if (header) {
      section = header[1]
      inList = false
      continue
    }

    const opensList =
      (section === 'project' && /^dependencies\s*=\s*\[/.test(line)) ||
      ((section === 'project.optional-dependencies' || section === 'dependency-groups') &&
        /^[\w.-]+\s*=\s*\[/.test(line))
    if (opensList || inList) {
      for (const [, name] of line.matchAll(/["']([A-Za-z0-9][\w.-]*)/g)) {
        names.add(pythonName(name))
      }
      inList = opensList ? !/]\s*(?:#.*)?$/.test(line) : !/^\s*]/.test(line)
    } else if (/^tool\.poetry\.(?:dev-dependencies|dependencies|group\.[^.]+\.dependencies)$/.test(section)) {
      const name = /^["']?([A-Za-z0-9][\w.-]*)["']?\s*=/.exec(line)?.[1]
      if (name && name !== 'python') {
        names.add(pythonName(name))
      }
    }
  }

  return names
}

// The lockfile does not say what the project asks for, but the pyproject.toml beside
// it does.
function parsePoetryLock(text, manifest) {
  const versions = new Map()
  for (const { field } of tomlPackages(text)) {
    addVersion(versions, field('name') && pythonName(field('name')), field('version'))
  }

  return {
    versions,
    direct: manifest === null ? null : pyprojectRequirements(manifest),
    python: true,
  }
}

// pnpm's YAML, read by indentation so as to need no parser. A package reads
// foo@1.2.3 or '@scope/foo@1.2.3', with a slash ahead of it before version 9, and
// with its peers behind it: foo@1.2.3(bar@2.0.0). The project and its workspaces are
// the importers, with the names they ask for two levels under each. A lockfile
// without workspaces may instead have them at the top.
function parsePnpmLock(text) {
  const versions = new Map()
  const direct = new Set()
  const groups = /^(?:dependencies|devDependencies|optionalDependencies):$/
  let section = ''
  let inGroup = false

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const indent = /^ */.exec(line)[0].length
    const key = line.trim()
    if (!key || key.startsWith('#')) {
      continue
    }

    if (indent === 0) {
      section = key
      inGroup = groups.test(key)
    } else if (section === 'importers:') {
      if (indent <= 4) {
        inGroup = indent === 4 && groups.test(key)
      } else if (indent === 6 && inGroup) {
        direct.add(key.slice(0, key.lastIndexOf(':')).replace(/^['"]|['"]$/g, ''))
      }
    } else if (section === 'packages:' && indent === 2) {
      const entry = /^['"]?\/?(.+?)['"]?:(?:\s.*)?$/.exec(key)?.[1].replace(/\(.*$/, '') ?? ''
      const at = entry.lastIndexOf('@')
      addVersion(versions, at > 0 ? entry.slice(0, at) : null, entry.slice(at + 1))
    } else if (inGroup && indent === 2) {
      direct.add(key.slice(0, key.lastIndexOf(':')).replace(/^['"]|['"]$/g, ''))
    }
  }

  return { versions, direct }
}

// Yarn writes the same shape in two dialects. Classic gives its entries as
//
//   "@scope/foo@^1.0.0", foo@^2:
//     version "1.2.3"
//
// and Berry as "@scope/foo@npm:^1.0.0, foo@npm:^2": with version: 1.2.3, where a
// workspace of the project is an entry too, with the names it asks for under it.
// Classic leaves those to the package.json beside it, which cannot speak for the
// other workspaces of a project that has them.
function parseYarnLock(text, manifest) {
  const versions = new Map()
  const direct = new Set()
  const groups = /^ {2}(?:dependencies|devDependencies|optionalDependencies|peerDependencies):$/
  let name = null
  let workspace = false
  let inGroup = false
  let berry = false

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('__metadata:')) {
      berry = true
    }

    if (line && !line.startsWith(' ') && !line.startsWith('#')) {
      const descriptor = line.replace(/^"/, '').split(/,\s*/)[0]
      const at = descriptor.indexOf('@', 1)
      name = at > 0 && !line.startsWith('__metadata') ? descriptor.slice(0, at) : null
      workspace = descriptor.includes('@workspace:')
      inGroup = false
      continue
    }

    const version = /^ {2}version:? "?([^"\s]+)"?\s*$/.exec(line)?.[1]
    if (version && name && !workspace) {
      addVersion(versions, name, version)
    }

    if (groups.test(line)) {
      inGroup = true
    } else if (/^ {2}\S/.test(line)) {
      inGroup = false
    } else if (inGroup && workspace) {
      const asked = /^ {4}"?([^":\s]+)"?:?\s/.exec(line)?.[1]
      if (asked) {
        direct.add(asked)
      }
    }
  }

  if (berry) {
    return { versions, direct }
  }

  const required = manifest ? JSON.parse(manifest) : null
  if (!required || required.workspaces) {
    return { versions, direct: null }
  }

  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    Object.keys(required[group] ?? {}).forEach((asked) => direct.add(asked))
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
  'pnpm-lock.yaml': { parse: parsePnpmLock },
  'yarn.lock': { parse: parseYarnLock, manifest: 'package.json' },
  'uv.lock': { parse: parseUvLock },
  'poetry.lock': { parse: parsePoetryLock, manifest: 'pyproject.toml' },
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
          ...(after.python ? { python: true } : {}),
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
    warn(`Reading ${LOCKFILE_LIMIT} of ${paths.length} lockfiles.`)
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
      warn(`${path}: ${error.message}`)
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

  // Only Python folds a name: npm's lodash.merge and lodash-merge are two packages.
  for (const { python, ...change } of changes) {
    const fold = python ? pythonName : (name) => name
    const sameName = ({ name }) => fold(name) === fold(change.name)
    const update =
      announced.find(
        (update) => sameName(update) && update.from === change.from && update.to === change.to,
      ) ?? announced.find((update) => sameName(update) && update.to === change.to)

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

export {
  applyLockfileChanges,
  diffLockfile,
  parseCargoLock,
  parseComposerLock,
  parsePackageLock,
  parsePnpmLock,
  parsePoetryLock,
  parseUvLock,
  parseYarnLock,
  readLockfileChanges,
}
