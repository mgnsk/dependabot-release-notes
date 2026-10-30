import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyLockfileChanges,
  diffLockfile,
  parseCargoLock,
  parseComposerLock,
  parsePackageLock,
  parsePnpmLock,
  parsePoetryLock,
  parseUvLock,
  parseYarnLock,
} from '../lib/lockfiles.mjs'
import {
  PULL_REQUEST,
  REPOSITORY,
  notFound,
  ok,
  release,
  releasesRoute,
  runAction,
} from '../test-support/harness.mjs'

const API = `https://api.github.com/repos/${REPOSITORY}`

const packageLock = (packages) => JSON.stringify({ lockfileVersion: 3, packages })
const npm = (a, b, c = '3.0.0') =>
  packageLock({
    '': { dependencies: { a: '^1.0.0' }, devDependencies: { d: '1' } },
    'packages/app': { version: '9.9.9', dependencies: { w: '1' } },
    'node_modules/app': { link: true, resolved: 'packages/app' },
    'node_modules/a': { version: a },
    'node_modules/b': { version: b },
    'node_modules/a/node_modules/c': { version: c },
    'node_modules/w': { version: '1.0.0' },
  })

const summary = (changes) => changes.map((c) => `${c.name} ${c.from} ${c.to} ${c.indirect}`)
const moved = (before, after) => summary(diffLockfile(before, after))

describe('package-lock.json', () => {
  test('gives the versions and the names asked for, workspaces included', () => {
    const { versions, direct } = parsePackageLock(npm('1.0.0', '2.0.0'))

    assert.deepEqual([...versions.keys()], ['a', 'b', 'c', 'w'])
    assert.deepEqual([...direct].sort(), ['a', 'd', 'w'])
  })

  test('reads an alias under its own name', () => {
    const { versions } = parsePackageLock(
      packageLock({ 'node_modules/x': { name: 'real', version: '1.0.0' } }),
    )

    assert.deepEqual([...versions.keys()], ['real'])
  })

  test('from before npm 7 nests its packages and names no direct ones', () => {
    const { versions, direct } = parsePackageLock(
      JSON.stringify({ dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } } }),
    )

    assert.deepEqual([...versions.keys()], ['a', 'b'])
    assert.equal(direct, null)
  })

  test('marks what moved direct or indirect', () => {
    assert.deepEqual(moved(parsePackageLock(npm('1.0.0', '2.0.0')), parsePackageLock(npm('1.1.0', '2.1.0'))), [
      'a 1.0.0 1.1.0 false',
      'b 2.0.0 2.1.0 true',
    ])
  })
})

describe('Cargo.lock', () => {
  const lock = (serde, core) => `version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
 "dup 1.0.0",
]

[[package]]
name = "serde"
version = "${serde}"
source = "registry+https://example.test/index"
checksum = "aa"
dependencies = [
 "serde_core",
]

[[package]]
name = "serde_core"
version = "${core}"
source = "registry+https://example.test/index"
`

  test('takes the direct names from the crates of the workspace', () => {
    const { versions, direct } = parseCargoLock(lock('1.0.0', '1.0.0'))

    assert.deepEqual([...versions.keys()], ['serde', 'serde_core'])
    assert.deepEqual([...direct], ['serde', 'dup'])
  })

  test('marks what moved direct or indirect', () => {
    assert.deepEqual(moved(parseCargoLock(lock('1.0.0', '1.0.0')), parseCargoLock(lock('1.0.1', '1.0.2'))), [
      'serde 1.0.0 1.0.1 false',
      'serde_core 1.0.0 1.0.2 true',
    ])
  })
})

describe('composer.lock', () => {
  const lock = (version) =>
    JSON.stringify({
      packages: [
        { name: 'symfony/asset', version, source: { url: 'https://github.com/symfony/asset.git' } },
      ],
      'packages-dev': [{ name: 'phpunit/phpunit', version: '10.0.0' }],
    })

  test('drops the "v" and reads direct names from the manifest', () => {
    const { versions, direct, projects } = parseComposerLock(
      lock('v7.4.8'),
      JSON.stringify({ require: { php: '>=8', 'symfony/asset': '*' } }),
    )

    assert.deepEqual([...versions.get('symfony/asset')], ['7.4.8'])
    assert.deepEqual([...direct], ['php', 'symfony/asset'])
    assert.equal(projects.get('symfony/asset'), 'https://github.com/symfony/asset.git')
  })

  test('without a manifest cannot tell direct from indirect', () => {
    assert.equal(parseComposerLock(lock('v1.0.0'), null).direct, null)
  })
})

describe('comparing lockfiles', () => {
  const reading = (entries, direct = null) => ({
    versions: new Map(entries.map(([name, ...versions]) => [name, new Set(versions)])),
    direct,
  })

  test('ignores a package that only moved, was added or was dropped', () => {
    assert.deepEqual(moved(reading([['same', '1.0'], ['gone', '1.0']]), reading([['same', '1.0'], ['new', '1.0']])), [])
  })

  test('pairs several versions of one package from the highest down', () => {
    assert.deepEqual(moved(reading([['a', '1.2.0', '2.9.0', '3.0.0']]), reading([['a', '1.10.0', '2.10.0', '3.0.0']])), [
      'a 2.9.0 2.10.0 undefined',
      'a 1.2.0 1.10.0 undefined',
    ])
  })

  test('refuses a name or version that could break out of the table', () => {
    assert.deepEqual(moved(reading([['a|b', '1.0'], ['c', '1.0']]), reading([['a|b', '2.0'], ['c', '`2.0']])), [])
  })
})

describe('what the lockfiles add', () => {
  const update = (name, from, to, indirect) => ({ name, from, to, links: {}, indirect })

  test('settles whether an announced update is direct, also across directories', () => {
    const announced = [update('a', '1.0', '2.0'), update('b', '0.9', '2.0')]
    const listed = applyLockfileChanges(announced, [update('a', '1.0', '2.0', true), update('b', '1.0', '2.0', false)])

    assert.deepEqual(announced.map(({ indirect }) => indirect), [true, false])
    assert.deepEqual(listed, [])
  })

  test('adds a direct update and lists the rest', () => {
    const announced = []
    const listed = applyLockfileChanges(announced, [
      update('direct', '1.0', '2.0', false),
      update('deep', '1.0', '2.0', true),
      update('unknown', '1.0', '2.0', undefined),
    ])

    assert.deepEqual(announced.map(({ name }) => name), ['direct'])
    assert.deepEqual(listed.map(({ name }) => name), ['deep', 'unknown'])
  })
})

describe('a pull request with a lockfile', () => {
  const file = (path, sha, text) => ({
    [`GET ${API}/contents/${path}?ref=${sha}`]: text === null ? notFound : { status: 200, text },
  })
  const commitsRoute = (commits) => ({
    [`GET ${API}/pulls/${PULL_REQUEST}/commits?per_page=100&page=1`]: ok(commits),
  })
  const message =
    'Updates `a` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/a/compare/v1.0.0...v1.1.0)'
  const dependabot = { login: 'dependabot[bot]' }
  const commit = {
    sha: 'head',
    parents: [{ sha: 'base' }],
    author: dependabot,
    commit: { message },
  }
  const files = [{ filename: 'package-lock.json', status: 'modified' }]
  const notes = releasesRoute('o/a', [release('v1.1.0', 'a notes'), release('v1.0.0', 'old')])

  test('lists the transitive packages after the updates with notes', async () => {
    const run = await runAction({
      files,
      routes: {
        ...commitsRoute([commit]),
        ...notes,
        ...file('package-lock.json', 'base', npm('1.0.0', '2.0.0')),
        ...file('package-lock.json', 'head', npm('1.1.0', '2.1.0')),
      },
    })

    assert.equal(run.code, 0, run.stderr)
    const [posted] = run.posted
    assert.match(posted, /\| `a` \| `1\.0\.0` → `1\.1\.0` \| minor \| direct \| 1 release \|/)
    assert.match(posted, /\| `b` \| `2\.0\.0` → `2\.1\.0` \| minor \| indirect \| Not read \|/)
    assert.ok(posted.indexOf('`a`') < posted.indexOf('<summary>1 more package from the lockfiles</summary>'))
    assert.ok(posted.indexOf('<summary>1 more package') < posted.indexOf('`b`'))
    assert.equal(posted.split('<summary>').length - 1, 2)
  })

  test('asks for the file as it is', async () => {
    const run = await runAction({
      files,
      routes: {
        ...commitsRoute([commit]),
        ...notes,
        ...file('package-lock.json', 'base', npm('1.0.0', '2.0.0')),
        ...file('package-lock.json', 'head', npm('1.1.0', '2.1.0')),
      },
    })

    const read = run.requests.find((request) => request.url.includes('/contents/'))
    assert.equal(read.headers.accept, 'application/vnd.github.raw+json')
  })

  test('compares the ends of Dependabot\'s own commits, not what others pushed', async () => {
    const run = await runAction({
      files,
      routes: {
        ...commitsRoute([commit, { sha: 'human', author: { login: 'someone' }, parents: [{ sha: 'head' }], commit: { message: 'x' } }]),
        ...notes,
        ...file('package-lock.json', 'base', npm('1.0.0', '2.0.0')),
        ...file('package-lock.json', 'head', npm('1.1.0', '2.0.0')),
      },
    })

    assert.equal(run.code, 0, run.stderr)
    assert.ok(!run.requests.some((request) => request.url.endsWith('ref=human')))
  })

  test('reads composer.json beside composer.lock', async () => {
    const lock = (version) => JSON.stringify({ packages: [{ name: 'a', version }, { name: 'z/deep', version }] })
    const manifest = JSON.stringify({ require: { a: '*' } })
    const run = await runAction({
      files: [{ filename: 'sub/composer.lock', status: 'modified' }],
      routes: {
        ...commitsRoute([commit]),
        ...notes,
        ...file('sub/composer.lock', 'base', lock('v1.0.0')),
        ...file('sub/composer.lock', 'head', lock('v1.1.0')),
        ...file('sub/composer.json', 'base', manifest),
        ...file('sub/composer.json', 'head', manifest),
      },
    })

    assert.match(run.posted[0], /\| `z\/deep` .*\| indirect \| Not read \|/)
  })

  const oldLock = (version) => JSON.stringify({ dependencies: { old: { version } } })

  test('from before npm 7 leaves out a scope no lockfile can tell', async () => {
    const run = await runAction({
      files,
      routes: {
        ...commitsRoute([commit]),
        ...notes,
        ...file('package-lock.json', 'base', oldLock('1.0.0')),
        ...file('package-lock.json', 'head', oldLock('1.1.0')),
      },
    })

    assert.equal(run.code, 0, run.stderr)
    assert.match(run.posted[0], /\| Package \| Update \| Bump \| Notes \|/)
    assert.match(run.posted[0], /\| `old` \| `1\.0\.0` → `1\.1\.0` \| minor \| Not read \|/)
  })

  test('from before npm 7 does not call a package direct next to one that can tell', async () => {
    const run = await runAction({
      files: [
        { filename: 'old/package-lock.json', status: 'modified' },
        { filename: 'new/package-lock.json', status: 'modified' },
      ],
      routes: {
        ...commitsRoute([commit]),
        ...notes,
        ...file('old/package-lock.json', 'base', oldLock('1.0.0')),
        ...file('old/package-lock.json', 'head', oldLock('1.1.0')),
        ...file('new/package-lock.json', 'base', npm('1.0.0', '2.0.0')),
        ...file('new/package-lock.json', 'head', npm('1.1.0', '2.0.0')),
      },
    })

    assert.equal(run.code, 0, run.stderr)
    assert.match(run.posted[0], /\| `a` .*\| direct \|/)
    assert.match(run.posted[0], /\| `old` .*\| — \| Not read \|/)
  })

  test('survives a lockfile it cannot parse', async () => {
    const run = await runAction({
      files,
      routes: {
        ...commitsRoute([commit]),
        ...notes,
        ...file('package-lock.json', 'base', 'not json'),
        ...file('package-lock.json', 'head', 'not json'),
      },
    })

    assert.equal(run.code, 0, run.stderr)
    assert.match(run.posted[0], /a notes/)
    assert.match(run.stderr, /package-lock\.json/)
  })

  test('skips a lockfile the pull request adds', async () => {
    const run = await runAction({
      files: [{ filename: 'package-lock.json', status: 'added' }],
      routes: { ...commitsRoute([commit]), ...notes },
    })

    assert.equal(run.code, 0, run.stderr)
    assert.ok(!run.requests.some((request) => request.url.includes('/contents/')))
  })

  test('posts nothing when only a lockfile names the packages', async () => {
    const run = await runAction({
      files,
      routes: {
        ...commitsRoute([{ ...commit, commit: { message: 'Bump things' } }]),
        ...file('package-lock.json', 'base', npm('1.0.0', '2.0.0', '3.0.0')),
        ...file('package-lock.json', 'head', npm('1.0.0', '2.1.0', '3.0.0')),
      },
    })

    assert.deepEqual(run.posted, [])
    assert.match(run.stdout, /No notes found, nothing to post\. Updates: b 2\.0\.0 → 2\.1\.0/)
  })
})

const names = (reading) => [...reading.versions].map(([name, versions]) => `${name} ${[...versions].join(' ')}`)

describe('pnpm-lock.yaml', () => {
  const lock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.2.3
      '@scope/bar':
        specifier: ^2.0.0
        version: 2.0.0(foo@1.2.3)
    devDependencies:
      dev:
        specifier: 3.0.0
        version: 3.0.0

  packages/app:
    dependencies:
      work:
        specifier: workspace:*
        version: link:../work

packages:

  '@scope/bar@2.0.0':
    resolution: {integrity: sha512-a}
    peerDependencies:
      foo: '*'

  foo@1.2.3:
    resolution: {integrity: sha512-b}

  dep@1.0.0:
    resolution: {integrity: sha512-c}

  dep@2.0.0:
    resolution: {integrity: sha512-d}

snapshots:

  foo@1.2.3: {}

  other@9.9.9: {}
`

  test('gives the versions of the packages alone', () => {
    assert.deepEqual(names(parsePnpmLock(lock)), ['@scope/bar 2.0.0', 'foo 1.2.3', 'dep 1.0.0 2.0.0'])
  })

  test('takes the direct names from the importers', () => {
    assert.deepEqual([...parsePnpmLock(lock).direct], ['foo', '@scope/bar', 'dev', 'work'])
  })

  test('reads the slash and the peers of an older lockfile, and names at the top', () => {
    const reading = parsePnpmLock(`lockfileVersion: '6.0'

dependencies:
  foo:
    specifier: ^1
    version: 1.2.3

packages:

  /foo@1.2.3(bar@2.0.0):
    resolution: {integrity: sha512-b}

  /@scope/baz@4.0.0:
    resolution: {integrity: sha512-c}
`)

    assert.deepEqual(names(reading), ['foo 1.2.3', '@scope/baz 4.0.0'])
    assert.deepEqual([...reading.direct], ['foo'])
  })
})

describe('yarn.lock', () => {
  const classic = `# yarn lockfile v1


"@scope/foo@^1.0.0", "@scope/foo@^1.1.0":
  version "1.2.3"
  resolved "https://example.test/foo.tgz"
  dependencies:
    bar "^2.0.0"

bar@^2.0.0:
  version "2.1.0"

bar@^1.0.0:
  version "1.9.0"
`
  const berry = `__metadata:
  version: 8
  cacheKey: 10

"@scope/foo@npm:^1.0.0, @scope/foo@npm:^1.1.0":
  version: 1.2.3
  resolution: "@scope/foo@npm:1.2.3"
  dependencies:
    bar: "npm:^2.0.0"
  languageName: node

"bar@npm:^2.0.0":
  version: 2.1.0
  resolution: "bar@npm:2.1.0"

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    "@scope/foo": "npm:^1.0.0"
  devDependencies:
    bar: "npm:^2.0.0"
  languageName: unknown
`

  test('classic gives the versions, and the direct names of the package.json', () => {
    const reading = parseYarnLock(classic, JSON.stringify({ dependencies: { '@scope/foo': '^1' } }))

    assert.deepEqual(names(reading), ['@scope/foo 1.2.3', 'bar 2.1.0 1.9.0'])
    assert.deepEqual([...reading.direct], ['@scope/foo'])
  })

  test('classic cannot tell without a package.json, or with workspaces', () => {
    assert.equal(parseYarnLock(classic, null).direct, null)
    assert.equal(parseYarnLock(classic, JSON.stringify({ workspaces: ['a'] })).direct, null)
  })

  test('Berry gives the versions, and the direct names of its workspaces', () => {
    const reading = parseYarnLock(berry, null)

    assert.deepEqual(names(reading), ['@scope/foo 1.2.3', 'bar 2.1.0'])
    assert.deepEqual([...reading.direct], ['@scope/foo', 'bar'])
  })
})

describe('uv.lock', () => {
  const lock = `version = 1
requires-python = ">=3.12"

[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }
dependencies = [
    { name = "Requests" },
]

[package.optional-dependencies]
fast = [
    { name = "uvloop" },
]

[package.dev-dependencies]
dev = [
    { name = "ruff" },
]

[package.metadata]
requires-dist = [{ name = "not-read", specifier = ">=2" }]

[[package]]
name = "requests"
version = "2.32.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "urllib3" },
]
sdist = { url = "https://example.test/a.tar.gz", hash = "sha256:a" }

[[package]]
name = "urllib3"
version = "2.0.0"
source = { registry = "https://pypi.org/simple" }
`

  test('gives the versions, without the project', () => {
    assert.deepEqual(names(parseUvLock(lock)), ['requests 2.32.0', 'urllib3 2.0.0'])
  })

  test('takes the direct names from the project, groups included', () => {
    assert.deepEqual([...parseUvLock(lock).direct], ['requests', 'uvloop', 'ruff'])
  })
})

describe('poetry.lock', () => {
  const lock = `[[package]]
name = "Typing_Extensions"
version = "4.0.0"
description = "x"

[package.dependencies]
foo = ">=1"

[[package]]
name = "deep"
version = "1.0.0"

[metadata]
lock-version = "2.1"
`

  test('gives the versions under normalised names', () => {
    assert.deepEqual(names(parsePoetryLock(lock, null)), ['typing-extensions 4.0.0', 'deep 1.0.0'])
  })

  test('cannot tell direct from indirect without a pyproject.toml', () => {
    assert.equal(parsePoetryLock(lock, null).direct, null)
  })

  test("reads Poetry's tables from the pyproject.toml", () => {
    const { direct } = parsePoetryLock(
      lock,
      `[tool.poetry]
name = "app"

[tool.poetry.dependencies]
python = "^3.12"
Typing_Extensions = "^4"

[tool.poetry.group.dev.dependencies]
ruff = "^0.1"

[tool.other]
ignored = "1"
`,
    )

    assert.deepEqual([...direct], ['typing-extensions', 'ruff'])
  })

  test('reads the standard lists from the pyproject.toml', () => {
    const { direct } = parsePoetryLock(
      lock,
      `[project]
name = "app"
dependencies = [
    "requests>=2",
    "Typing_Extensions (>=4,<5)",
]

[project.optional-dependencies]
fast = ["uvloop"]

[dependency-groups]
dev = [
    "ruff",
]
`,
    )

    assert.deepEqual([...direct], ['requests', 'typing-extensions', 'uvloop', 'ruff'])
  })
})

describe('the spelling of a Python name', () => {
  test('does not hide that an announced update is direct', () => {
    const announced = [{ name: 'Typing_Extensions', from: '1.0', to: '2.0', links: {} }]
    const listed = applyLockfileChanges(announced, [
      { name: 'typing-extensions', from: '1.0', to: '2.0', links: {}, indirect: false },
    ])

    assert.deepEqual(listed, [])
    assert.equal(announced[0].indirect, false)
  })
})
