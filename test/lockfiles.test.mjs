import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyLockfileChanges,
  diffLockfile,
  parseCargoLock,
  parseComposerLock,
  parsePackageLock,
} from '../dependabot-release-notes.mjs'
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
    assert.equal(posted.split('<details>').length - 1, 1)
    assert.match(run.stdout + run.posted.length, /./)
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

  test('posts the list alone when nothing else names the packages', async () => {
    const run = await runAction({
      files,
      routes: {
        ...commitsRoute([{ ...commit, commit: { message: 'Bump things' } }]),
        ...file('package-lock.json', 'base', npm('1.0.0', '2.0.0', '3.0.0')),
        ...file('package-lock.json', 'head', npm('1.0.0', '2.1.0', '3.0.0')),
      },
    })

    assert.equal(run.posted.length, 1)
    assert.match(run.posted[0], /\| `b` \|/)
  })
})
