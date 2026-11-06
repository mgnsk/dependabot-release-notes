import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  MARKER,
  REPOSITORY,
  PULL_REQUEST,
  TOKEN,
  compareRoute,
  goModFile,
  notFound,
  ok,
  proxyRoute,
  release,
  releasesRoute,
  runAction,
  upstreamCommit,
} from '../test-support/harness.mjs'

const ZERO_WIDTH_SPACE = '​'
const API = `https://api.github.com/repos/${REPOSITORY}`
const COMMITS_URL = `GET ${API}/pulls/${PULL_REQUEST}/commits?per_page=100&page=1`
const COMMENTS_URL = `${API}/issues/${PULL_REQUEST}/comments`

// An update announced the way a grouped Dependabot pull request does it.
function updatesBlock(name, from, to, compareUrl) {
  return `Updates \`${name}\` from ${from} to ${to}\n- [Commits](${compareUrl})`
}

function barUpdate(from = '1.0.0', to = '1.2.0') {
  return updatesBlock(
    'github.com/foo/bar',
    from,
    to,
    `https://github.com/foo/bar/compare/v${from}...v${to}`,
  )
}

// Enough separate projects, each with one release, to fill a comment or not.
function manyProjects(total, bodyLength) {
  const messages = []
  let routes = {}
  for (let index = 0; index < total; index++) {
    const name = `github.com/foo/project${index}`
    messages.push(updatesBlock(name, '1.0.0', '1.1.0', `https://${name}/compare/v1.0.0...v1.1.0`))
    routes = {
      ...routes,
      ...releasesRoute(`foo/project${index}`, [
        release('v1.1.0', 'x'.repeat(bodyLength), {
          html_url: `https://example.test/project${index}/v1.1.0`,
        }),
      ]),
    }
  }

  return { messages: [messages.join('\n\n')], routes }
}

// Runs the action, expects it to succeed and returns the run.
async function succeed(options) {
  const run = await runAction(options)
  assert.equal(run.code, 0, run.stderr)

  return run
}

// Runs the action and returns the one comment it is expected to post.
async function postedComment(options) {
  const run = await succeed(options)
  assert.equal(run.posted.length, 1)

  return run.posted[0]
}

// The log of a run that found no notes for anything, and so posted nothing.
async function withoutNotes(options) {
  const run = await succeed(options)
  assert.deepEqual(run.posted, [])
  assert.match(run.stdout, /No notes found, nothing to post/)

  return run.stdout
}

function count(text, needle) {
  return text.split(needle).length - 1
}

function assertInOrder(text, ...needles) {
  let position = -1
  for (const needle of needles) {
    const next = text.indexOf(needle, position + 1)
    assert.notEqual(next, -1, `expected "${needle}" after position ${position}`)
    position = next
  }
}

describe('startup and exit', () => {
  for (const name of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'PR_NUMBER']) {
    test(`exits 1 without ${name}`, async () => {
      const run = await runAction({ env: { [name]: undefined } })

      assert.equal(run.code, 1)
      assert.match(run.stderr, /are required/)
      assert.deepEqual(run.requests, [])
    })
  }

  for (const [name, value] of [
    ['PR_NUMBER', '7/../../../user'],
    ['PR_NUMBER', '7?x'],
    ['GITHUB_REPOSITORY', 'owner/repo/../../user'],
  ]) {
    test(`exits 1 on ${name}=${value}`, async () => {
      const run = await runAction({ env: { [name]: value } })

      assert.equal(run.code, 1)
      assert.deepEqual(run.requests, [])
    })
  }

  test('posts nothing when no updates are found', async () => {
    const run = await succeed({ messages: ['Fix a typo'] })

    assert.match(run.stdout, /nothing to post/)
    assert.deepEqual(run.posted, [])
  })

  test('fails on an API error, naming the status', async () => {
    const run = await runAction({
      routes: { [COMMITS_URL]: { status: 500, body: { message: 'boom' } } },
    })

    assert.notEqual(run.code, 0)
    assert.match(run.stderr, /500/)
    assert.deepEqual(run.posted, [])
  })
})

describe('finding updates in commit messages', () => {
  const noteRoutes = releasesRoute('foo/bar', [release('v1.2.0', 'bar notes')])

  test('collapses the copies an update repeats per directory', async () => {
    const comment = await postedComment({
      messages: [`${barUpdate()}\n\n${barUpdate()}\n\n${barUpdate()}`],
      routes: noteRoutes,
    })

    assert.equal(count(comment, '<details>'), 1)
    assert.equal(count(comment, 'bar notes'), 1)
  })

  test('keeps the links of the earliest copy', async () => {
    const comment = await postedComment({
      messages: [`${barUpdate()}\nUpdates \`github.com/foo/bar\` from 1.0.0 to 1.2.0`],
      routes: noteRoutes,
    })

    assert.match(comment, /\[Commits]\(https:\/\/github\.com\/foo\/bar\/compare\//)
    assert.match(comment, /bar notes/)
  })

  test('keeps different ranges of one package apart', async () => {
    const comment = await postedComment({
      messages: [`${barUpdate('1.0.0', '1.2.0')}\n\n${barUpdate('1.1.0', '1.2.0')}`],
      routes: releasesRoute('foo/bar', [
        release('v1.2.0', 'newer'),
        release('v1.1.0', 'older'),
        release('v1.0.0', 'oldest'),
      ]),
    })

    assert.equal(count(comment, '<details>'), 2)
  })

  for (const [form, message] of [
    ['a linked Bumps', 'Bumps [foo](https://example.test/foo) from 1.0.0 to 1.2.0.'],
    ['a plain Bumps', 'Bumps foo from 1.0.0 to 1.2.0.'],
    ['a linked Bumps with a directory', 'Bumps [foo](https://example.test) from 1.0.0 to 1.2.0 in /sub.'],
    ['a plain Bumps with a directory', 'Bumps foo from 1.0.0 to 1.2.0 in /sub'],
  ]) {
    test(`parses ${form}`, async () => {
      const log = await withoutNotes({ messages: [message] })

      assert.match(log, /foo 1\.0\.0 → 1\.2\.0/)
    })
  }

  test('fills in a summary table row that truncation cut the block of', async () => {
    const comment = await postedComment({
      messages: ['| [github.com/foo/bar](https://github.com/foo/bar) | `1.0.0` | `1.2.0` |'],
      routes: noteRoutes,
    })

    assert.match(comment, /bar notes/)
    assert.match(comment, /\[Repository]\(https:\/\/github\.com\/foo\/bar\)/)
  })

  test('accepts a summary table row without a project', async () => {
    const log = await withoutNotes({ messages: ['| foo | `1.0.0` | `1.2.0` |'] })

    assert.match(log, /foo 1\.0\.0 → 1\.2\.0/)
  })

  test('prefers a detail block over the table row of the same update', async () => {
    const comment = await postedComment({
      messages: [
        `| [github.com/foo/bar](https://github.com/foo/bar) | \`1.0.0\` | \`1.2.0\` |\n\n${barUpdate()}`,
      ],
      routes: noteRoutes,
    })

    assert.equal(count(comment, '<details>'), 1)
    assert.match(comment, /\[Commits]/)
    assert.doesNotMatch(comment, /\[Repository]/)
  })
})

describe('finding updates in go.mod', () => {
  const missing = (name, version) => ({
    [`GET https://proxy.golang.org/${name}/@v/${version}.info`]: notFound,
  })

  test('reads the diff in place of the messages, indirect requirements included', async () => {
    const comment = await postedComment({
      messages: [`${barUpdate()}\n\nUpdates \`only/announced\` from 1.0.0 to 2.0.0`],
      files: [
        goModFile([
          ['github.com/foo/bar', 'v1.0.0', 'v1.2.0'],
          ['example.test/indirect', 'v0.1.0 // indirect', 'v0.2.0 // indirect'],
        ]),
      ],
      routes: {
        ...releasesRoute('foo/bar', [release('v1.2.0', 'bar notes')]),
        ...missing('example.test/indirect', 'v0.1.0'),
        ...missing('example.test/indirect', 'v0.2.0'),
      },
    })

    assert.match(comment, /bar notes/)
    assert.match(comment, /\| `example\.test\/indirect` \| `0\.1\.0` → `0\.2\.0` \|/)
    assert.doesNotMatch(comment, /only\/announced/)
  })

  test('reads require lines and go.mod files in subdirectories', async () => {
    const log = await withoutNotes({
      files: [
        {
          filename: 'tools/go.mod',
          patch: '-require example.test/single v1.0.0\n+require example.test/single v1.1.0',
        },
      ],
      routes: {
        ...missing('example.test/single', 'v1.0.0'),
        ...missing('example.test/single', 'v1.1.0'),
      },
    })

    assert.match(log, /example\.test\/single 1\.0\.0 → 1\.1\.0/)
  })

  test('ignores what has no range to report', async () => {
    const run = await succeed({
      files: [
        {
          filename: 'go.mod',
          patch: [
            '--- a/go.mod',
            '+++ b/go.mod',
            '+\texample.test/added v1.0.0',
            '-\texample.test/dropped v1.0.0',
            '-\texample.test/replaced v1.0.0 => example.test/fork v1.0.0',
            '+\texample.test/replaced v1.1.0 => example.test/fork v1.1.0',
            '-\texample.test/comment v1.0.0 // indirect',
            '+\texample.test/comment v1.0.0',
          ].join('\n'),
        },
        { filename: 'go.sum', patch: '-\texample.test/sum v1.0.0\n+\texample.test/sum v1.1.0' },
        { filename: 'notgo.mod', patch: '-\texample.test/name v1.0.0\n+\texample.test/name v1.1.0' },
        { filename: 'vendor/blob.bin' },
      ],
    })

    assert.match(run.stdout, /nothing to post/)
  })

  test('reads the files past the first page', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({ filename: `file${index}.txt` }))
    const log = await withoutNotes({
      files: [...filler, goModFile([['example.test/late', 'v1.0.0', 'v1.1.0']])],
      routes: {
        ...missing('example.test/late', 'v1.0.0'),
        ...missing('example.test/late', 'v1.1.0'),
      },
    })

    assert.match(log, /example\.test\/late/)
  })
})

describe('Go module proxy', () => {
  const tagged = (version, url = 'https://github.com/foo/bar') => ({
    URL: url,
    Ref: `refs/tags/${version}`,
    Hash: 'unused',
  })

  test('reads the tags of an unannounced requirement', async () => {
    const run = await succeed({
      files: [goModFile([['example.test/vanity', 'v1.0.0', 'v1.2.0']])],
      routes: {
        ...proxyRoute('example.test/vanity', 'v1.0.0', tagged('v1.0.0')),
        ...proxyRoute('example.test/vanity', 'v1.2.0', tagged('v1.2.0')),
        ...releasesRoute('foo/bar', [release('v1.2.0', 'bar notes')]),
      },
    })

    assert.match(run.posted[0], /bar notes/)
    assert.match(run.posted[0], /\[Commits]\(https:\/\/github\.com\/foo\/bar\/compare\/v1\.0\.0\.\.\.v1\.2\.0\)/)

    for (const request of run.requests) {
      const host = new URL(request.url).host
      if (host === 'api.github.com') {
        assert.equal(request.headers.authorization, `Bearer ${TOKEN}`)
      } else {
        assert.equal(request.headers.authorization, undefined, request.url)
      }
    }
  })

  test('compares the hashes of a pseudo-version', async () => {
    const [AAA, BBB] = ['a'.repeat(40), 'b'.repeat(40)]
    const from = '0.0.0-20260101000000-aaaaaaaaaaaa'
    const to = '0.0.0-20260201000000-bbbbbbbbbbbb'
    const comment = await postedComment({
      files: [goModFile([['example.test/pseudo', `v${from}`, `v${to}`]])],
      routes: {
        ...proxyRoute('example.test/pseudo', `v${from}`, {
          URL: 'https://github.com/foo/bar',
          Hash: AAA,
        }),
        ...proxyRoute('example.test/pseudo', `v${to}`, {
          URL: 'https://github.com/foo/bar',
          Hash: BBB,
        }),
        ...compareRoute('foo/bar', AAA, BBB, [upstreamCommit('A change')]),
      },
    })

    assert.match(comment, /A change/)
  })

  test('maps go.googlesource.com to its GitHub mirror', async () => {
    const gerrit = 'https://go.googlesource.com/net'
    const comment = await postedComment({
      files: [goModFile([['golang.org/x/net', 'v0.1.0', 'v0.2.0']])],
      routes: {
        ...proxyRoute('golang.org/x/net', 'v0.1.0', tagged('v0.1.0', gerrit)),
        ...proxyRoute('golang.org/x/net', 'v0.2.0', tagged('v0.2.0', gerrit)),
        ...releasesRoute('golang/net', []),
        ...compareRoute('golang/net', 'v0.1.0', 'v0.2.0', [upstreamCommit('net: a change')]),
      },
    })

    assert.match(comment, /net: a change/)
  })

  test('escapes uppercase letters in the module path', async () => {
    const comment = await postedComment({
      files: [goModFile([['github.com/Azure/sdk', 'v1.0.0', 'v1.1.0']])],
      routes: {
        ...proxyRoute('github.com/!azure/sdk', 'v1.0.0', tagged('v1.0.0', 'https://github.com/Azure/sdk')),
        ...proxyRoute('github.com/!azure/sdk', 'v1.1.0', tagged('v1.1.0', 'https://github.com/Azure/sdk')),
        ...releasesRoute('Azure/sdk', [release('v1.1.0', 'azure notes')]),
      },
    })

    assert.match(comment, /azure notes/)
  })

  test('does not compare across repositories', async () => {
    await withoutNotes({
      files: [goModFile([['example.test/moved', 'v1.0.0', 'v1.1.0']])],
      routes: {
        ...proxyRoute('example.test/moved', 'v1.0.0', tagged('v1.0.0', 'https://github.com/old/home')),
        ...proxyRoute('example.test/moved', 'v1.1.0', tagged('v1.1.0', 'https://github.com/new/home')),
      },
    })
  })

  test('warns and carries on when the proxy fails', async () => {
    const failing = { status: 500, body: { message: 'proxy down' } }
    const run = await runAction({
      files: [goModFile([['example.test/flaky', 'v1.0.0', 'v1.1.0']])],
      routes: {
        'GET https://proxy.golang.org/example.test/flaky/@v/v1.0.0.info': failing,
        'GET https://proxy.golang.org/example.test/flaky/@v/v1.1.0.info': failing,
      },
    })

    assert.equal(run.code, 1)
    assert.match(run.stderr, /example\.test\/flaky@v1\.0\.0/)
    assert.deepEqual(run.posted, [])
  })
})

describe('finding the notes', () => {
  test('lists the releases in the range, oldest first', async () => {
    const comment = await postedComment({
      messages: [barUpdate('1.0.0', '1.2.0')],
      routes: releasesRoute('foo/bar', [
        release('v1.3.0', 'notes of 1.3.0'),
        release('v1.2.0', 'notes of 1.2.0'),
        release('v1.0.0', 'notes of 1.0.0'),
        release('v1.1.0', 'notes of 1.1.0'),
        release('v1.1.5', 'notes of a draft', { draft: true }),
      ]),
    })

    assertInOrder(comment, 'notes of 1.1.0', 'notes of 1.2.0')
    assert.doesNotMatch(comment, /notes of 1\.0\.0|notes of 1\.3\.0|notes of a draft/)
  })

  test('skips a prerelease on the way to a stable version', async () => {
    const comment = await postedComment({
      messages: [barUpdate('1.0.0', '1.2.0')],
      routes: releasesRoute('foo/bar', [
        release('v1.2.0-rc.1', 'candidate notes'),
        release('v1.2.0', 'stable notes'),
      ]),
    })

    assert.match(comment, /stable notes/)
    assert.doesNotMatch(comment, /candidate notes/)
  })

  test('shows a prerelease the update moves to', async () => {
    const comment = await postedComment({
      messages: [barUpdate('1.0.0', '1.2.0-rc.1')],
      routes: releasesRoute('foo/bar', [release('v1.2.0-rc.1', 'candidate notes')]),
    })

    assert.match(comment, /candidate notes/)
  })

  for (const [from, to] of [
    ['1.2.0-rc.9', '1.2.0-rc.10'],
    ['1.2.0-alpha.1', '1.2.0-beta.1'],
    ['1.2.0-rc', '1.2.0-rc.1'],
    ['1.2.0-rc.1', '1.2.0-rc.1.1'],
    ['1.2.0-1', '1.2.0-alpha'],
  ]) {
    test(`orders prerelease ${from} before ${to}`, async () => {
      const comment = await postedComment({
        messages: [barUpdate(from, to)],
        routes: releasesRoute('foo/bar', [release(`v${to}`, 'candidate notes')]),
      })

      assert.match(comment, /candidate notes/)
    })
  }

  test('finds no release when a prerelease moves backwards', async () => {
    const log = await withoutNotes({
      messages: [barUpdate('1.2.0-rc.10', '1.2.0-rc.9')],
      routes: {
        ...releasesRoute('foo/bar', [release('v1.2.0-rc.9', 'candidate notes')]),
        ...compareRoute('foo/bar', 'v1.2.0-rc.10', 'v1.2.0-rc.9', []),
      },
    })

    assert.doesNotMatch(log, /candidate notes/)
  })

  test('keeps the releases of the same path on two forges apart', async () => {
    const comment = await postedComment({
      messages: [
        [
          updatesBlock('example.test/hub', '1.0.0', '1.1.0', 'https://github.com/foo/bar/compare/v1.0.0...v1.1.0'),
          updatesBlock('example.test/lab', '1.0.0', '1.1.0', 'https://gitlab.com/foo/bar/-/compare/v1.0.0...v1.1.0'),
        ].join('\n\n'),
      ],
      routes: {
        ...releasesRoute('foo/bar', [release('v1.1.0', 'github notes')]),
        'GET https://gitlab.com/api/v4/projects/foo%2Fbar/releases?per_page=100&page=1': ok([
          { tag_name: 'v1.1.0', name: 'v1.1.0', description: 'gitlab notes' },
        ]),
      },
    })

    assert.match(comment, /github notes/)
    assert.match(comment, /gitlab notes/)
  })

  test('selects only the releases of a module tagged inside a monorepo', async () => {
    const comment = await postedComment({
      messages: [
        updatesBlock(
          'github.com/aws/sdk/service/s3',
          '1.0.0',
          '1.2.0',
          'https://github.com/aws/sdk/compare/service/s3/v1.0.0...service/s3/v1.2.0',
        ),
      ],
      routes: releasesRoute('aws/sdk', [
        release('service/s3/v1.2.0', 's3 notes'),
        release('service/sqs/v1.2.0', 'sqs notes'),
        release('v1.2.0', 'root notes'),
      ]),
    })

    assert.match(comment, /s3 notes/)
    assert.doesNotMatch(comment, /sqs notes|root notes/)
  })

  test('does not read release names', async () => {
    const comment = await postedComment({
      messages: [barUpdate('1.0.0', '1.2.0')],
      routes: {
        ...releasesRoute('foo/bar', [release('nightly', 'nightly notes', { name: 'Built on v1.2.0' })]),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', [upstreamCommit('A commit')]),
      },
    })

    assert.doesNotMatch(comment, /nightly notes/)
    assert.match(comment, /A commit/)
  })

  test('tolerates a project that is gone', async () => {
    await withoutNotes({
      messages: [barUpdate()],
      routes: {
        'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': notFound,
        'GET https://api.github.com/repos/foo/bar/compare/v1.0.0...v1.2.0': notFound,
      },
    })
  })

  describe('on GitLab', () => {
    const update = updatesBlock(
      'example.test/nested',
      '1.0.0',
      '1.2.0',
      'https://gitlab.com/group/sub/nested/-/compare/v1.0.0...v1.2.0',
    )
    const project = 'https://gitlab.com/api/v4/projects/group%2Fsub%2Fnested'

    test('reads the releases of a nested project without the token', async () => {
      const run = await succeed({
        messages: [update],
        routes: {
          [`GET ${project}/releases?per_page=100&page=1`]: ok([
            {
              tag_name: 'v1.2.0',
              name: 'One two',
              description: 'gitlab notes',
              released_at: '2026-03-04T00:00:00Z',
              _links: { self: 'https://gitlab.com/release' },
            },
            {
              tag_name: 'v1.1.0',
              name: 'Not out yet',
              description: 'upcoming notes',
              upcoming_release: true,
            },
          ]),
        },
      })

      assert.match(run.posted[0], /\*\*\[One two]\(https:\/\/gitlab\.com\/release\)\*\* — 2026-03-04/)
      assert.match(run.posted[0], /gitlab notes/)
      assert.doesNotMatch(run.posted[0], /upcoming notes/)

      const gitlab = run.requests.filter((request) => request.url.startsWith(project))
      assert.equal(gitlab.length, 1)
      assert.equal(gitlab[0].headers?.authorization, undefined)
    })

    test('lists the commits of a project without releases', async () => {
      const comment = await postedComment({
        messages: [update],
        routes: {
          [`GET ${project}/releases?per_page=100&page=1`]: ok([]),
          [`GET ${project}/repository/compare?from=v1.0.0&to=v1.2.0`]: ok({
            commits: [{ title: 'A gitlab commit', web_url: 'https://gitlab.com/commit' }],
          }),
        },
      })

      assert.match(comment, /- \[A gitlab commit]\(https:\/\/gitlab\.com\/commit\)/)
    })
  })

  test('retries a guessed tag without the "v"', async () => {
    const comment = await postedComment({
      messages: ['| [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) | `1.55.0` | `1.56.0` |'],
      routes: {
        'GET https://gitlab.com/api/v4/projects/cznic%2Fsqlite/releases?per_page=100&page=1': ok([]),
        'GET https://gitlab.com/api/v4/projects/cznic%2Fsqlite/repository/compare?from=v1.55.0&to=v1.56.0':
          notFound,
        'GET https://gitlab.com/api/v4/projects/cznic%2Fsqlite/repository/compare?from=1.55.0&to=1.56.0':
          ok({ commits: [{ title: 'Bare tags', web_url: 'https://gitlab.com/commit' }] }),
      },
    })

    assert.match(comment, /Bare tags/)
  })

  test('derives the tag prefix of a guessed tag from the module path', async () => {
    const comment = await postedComment({
      messages: ['| [github.com/foo/bar/sub/v2](https://github.com/foo/bar) | `2.0.0` | `2.1.0` |'],
      routes: releasesRoute('foo/bar', [
        release('sub/v2.1.0', 'submodule notes'),
        release('v2.1.0', 'root notes'),
      ]),
    })

    assert.match(comment, /submodule notes/)
    assert.doesNotMatch(comment, /root notes/)
  })
})

describe('rendering', () => {
  const withBody = (body) => ({
    messages: [barUpdate()],
    routes: releasesRoute('foo/bar', [release('v1.2.0', body)]),
  })

  test('renders the summary, heading, date and links of a section', async () => {
    const comment = await postedComment(withBody('Some notes'))

    assert.ok(comment.startsWith(`${MARKER}\n### Release notes\n`))
    assert.match(comment, /<summary><code>github\.com\/foo\/bar<\/code> — 1\.0\.0 → 1\.2\.0<\/summary>/)
    assert.match(comment, /\*\*\[v1\.2\.0]\(https:\/\/example\.test\/releases\/v1\.2\.0\)\*\* — 2026-01-02/)
    assert.match(comment, /\[Commits]\(https:\/\/github\.com\/foo\/bar\/compare\/v1\.0\.0\.\.\.v1\.2\.0\)/)
    assert.ok(comment.endsWith('</details>'))
  })

  test('defuses mentions and issue references in release notes', async () => {
    const comment = await postedComment(withBody('Thanks @alice for #123.\r\nNext line'))

    assert.ok(comment.includes(`@${ZERO_WIDTH_SPACE}alice`))
    assert.ok(comment.includes(`#${ZERO_WIDTH_SPACE}123`))
    assert.ok(!comment.includes('@alice'))
    assert.ok(!comment.includes('#123'))
    assert.ok(comment.includes('.\nNext line'))
  })

  test('defuses mentions and issue references in commit titles', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        ...releasesRoute('foo/bar', []),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', [upstreamCommit('Merge #9 from @bob')]),
      },
    })

    assert.ok(comment.includes(`Merge #${ZERO_WIDTH_SPACE}9 from @${ZERO_WIDTH_SPACE}bob`))
  })

  test('truncates a long release body', async () => {
    const comment = await postedComment(withBody('x'.repeat(4_001)))

    assert.equal(count(comment, 'x'.repeat(4_000)), 1)
    assert.ok(!comment.includes('x'.repeat(4_001)))
    assert.equal(count(comment, '_… truncated._'), 1)
  })

  test('leaves a release body at the limit alone', async () => {
    const comment = await postedComment(withBody('x'.repeat(4_000)))

    assert.ok(!comment.includes('truncated'))
  })

  test('keeps the newest releases of a dependency that fills its section', async () => {
    const releases = ['1', '2', '3', '4', '5'].map((minor) =>
      release(`v1.${minor}.0`, `notes of ${minor} ${'x'.repeat(3_900)}`),
    )
    const comment = await postedComment({
      messages: [barUpdate('1.0.0', '1.5.0')],
      routes: releasesRoute('foo/bar', releases),
    })

    assert.match(comment, /… and 2 earlier releases\./)
    assert.doesNotMatch(comment, /notes of 2 /)
    assertInOrder(comment, 'notes of 3 ', 'notes of 4 ', 'notes of 5 ')
    assert.ok(comment.length < 16_000, `${comment.length} chars`)
  })

  test('says nothing of earlier releases when all of them fit', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: releasesRoute('foo/bar', [release('v1.2.0', 'notes')]),
    })

    assert.doesNotMatch(comment, /earlier/)
  })

  test('caps a commit list and counts the rest', async () => {
    const commits = Array.from({ length: 23 }, (_, index) => upstreamCommit(`Commit ${index}`))
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        ...releasesRoute('foo/bar', []),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', commits),
      },
    })

    assert.match(comment, /Commits in this range/)
    assert.match(comment, /Commit 22]/)
    assert.match(comment, /Commit 3]/)
    assert.doesNotMatch(comment, /Commit 2]/)
    assert.match(comment, /… and 3 earlier\./)
    assert.doesNotMatch(comment, /The rest of the message/)
  })

  test('lists commits when no release in the range has a description', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        ...releasesRoute('foo/bar', [release('v1.2.0', '  \n '), release('v1.1.0', null)]),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', [upstreamCommit('A commit')]),
      },
    })

    assert.match(comment, /A commit/)
    assert.doesNotMatch(comment, /\*\*\[v1\.2\.0]/)
  })

  test('marks an undescribed release next to a described one', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: releasesRoute('foo/bar', [release('v1.2.0', 'real notes'), release('v1.1.0', '')]),
    })

    assertInOrder(comment, '_No release notes._', 'real notes')
  })

  test('falls back to the tag for a release without a name', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: releasesRoute('foo/bar', [release('v1.2.0', 'notes', { name: '  ' })]),
    })

    assert.match(comment, /\*\*\[v1\.2\.0]/)
  })

  test('shares a section between updates that move through the same commits', async () => {
    const modules = ['s3', 'sqs']
    const run = await succeed({
      messages: [
        modules
          .map((name) =>
            updatesBlock(
              `github.com/aws/sdk/service/${name}`,
              '1.0.0',
              '1.1.0',
              `https://github.com/aws/sdk/compare/service/${name}/v1.0.0...service/${name}/v1.1.0`,
            ),
          )
          .join('\n\n'),
      ],
      routes: {
        ...releasesRoute('aws/sdk', []),
        ...compareRoute('aws/sdk', 'service/s3/v1.0.0', 'service/s3/v1.1.0', [upstreamCommit('Release')]),
        ...compareRoute('aws/sdk', 'service/sqs/v1.0.0', 'service/sqs/v1.1.0', [upstreamCommit('Release')]),
      },
    })

    const [comment] = run.posted
    assert.equal(count(comment, '<details>'), 1)
    assert.match(comment, /<code>github\.com\/aws\/sdk\/service<\/code> — 2 packages/)
    assert.match(comment, /- `github\.com\/aws\/sdk\/service\/s3` 1\.0\.0 → 1\.1\.0/)
    assert.match(comment, /- `github\.com\/aws\/sdk\/service\/sqs` 1\.0\.0 → 1\.1\.0/)

    // One project supplies both modules, so its releases are asked for once.
    const asked = run.requests.filter((request) => request.url.includes('/aws/sdk/releases'))
    assert.equal(asked.length, 1)
  })

  test('keeps a single comment under the budget unnumbered', async () => {
    const comment = await postedComment(manyProjects(3, 100))

    assert.match(comment, /^### Release notes$/m)
  })

  test('splits what does not fit in one comment', async () => {
    const total = 20
    const run = await succeed(manyProjects(total, 4_000))

    assert.equal(run.posted.length, 2)
    run.posted.forEach((comment, index) => {
      assert.ok(comment.startsWith(`${MARKER}\n### Release notes (${index + 1}/2)\n`))
      assert.ok(comment.length < 65_536, `${comment.length} chars`)
    })

    const all = run.posted.join('\n')
    for (let index = 0; index < total; index++) {
      assert.equal(count(all, `<code>github.com/foo/project${index}</code>`), 1)
    }
  })
})

describe('posting', () => {
  const options = {
    messages: [barUpdate()],
    routes: releasesRoute('foo/bar', [release('v1.2.0', 'bar notes')]),
  }

  // The body the action would post for the options above.
  const body = async () => postedComment(options)

  test('prints the comments and writes nothing on a dry run', async () => {
    const run = await succeed({ ...options, args: ['--dry-run'] })

    assert.match(run.stdout, /bar notes/)
    assert.match(run.stdout, /1 update, 1 comment\(s\)/)
    assert.deepEqual(
      run.requests.filter((request) => request.method !== 'GET'),
      [],
    )
  })

  test('prints no workflow command on a dry run on a runner', async () => {
    const run = await succeed({
      messages: [barUpdate()],
      routes: releasesRoute('foo/bar', [release('v1.2.0', '::error::injected')]),
      args: ['--dry-run'],
      env: { GITHUB_ACTIONS: 'true' },
    })

    const [, resume] = /^::stop-commands::(\S+)$/m.exec(run.stdout) ?? []
    assert.ok(resume)
    const start = run.stdout.indexOf(`::stop-commands::${resume}`)
    const end = run.stdout.indexOf(`::${resume}::`)
    assert.ok(start < run.stdout.indexOf('::error::injected'))
    assert.ok(run.stdout.indexOf('::error::injected') < end)
  })

  test('posts a new comment with the token', async () => {
    const run = await succeed(options)

    const [post] = run.requests.filter((request) => request.method === 'POST')
    assert.equal(post.url, COMMENTS_URL)
    assert.equal(post.headers.authorization, `Bearer ${TOKEN}`)
    assert.ok(run.posted[0].startsWith(MARKER))
  })

  test('leaves an unchanged comment alone', async () => {
    const run = await succeed({ ...options, comments: [{ id: 1, body: await body() }] })

    assert.deepEqual(run.posted, [])
    assert.deepEqual(run.patched, [])
    assert.deepEqual(run.deleted, [])
  })

  test('edits a changed comment in place', async () => {
    const run = await succeed({ ...options, comments: [{ id: 1, body: `${MARKER}\nStale` }] })

    assert.deepEqual(run.posted, [])
    assert.deepEqual(run.patched, [{ id: 1, body: await body() }])
    assert.deepEqual(run.deleted, [])
  })

  test('deletes the parts the notes no longer need', async () => {
    const run = await succeed({
      ...options,
      comments: [
        { id: 1, body: await body() },
        { id: 2, body: `${MARKER}\nPart two` },
        { id: 3, body: `${MARKER}\nPart three` },
      ],
    })

    assert.deepEqual(run.posted, [])
    assert.deepEqual(run.patched, [])
    assert.deepEqual(run.deleted, [2, 3])
  })

  test('adds the parts the notes newly need', async () => {
    const run = await succeed({
      ...manyProjects(20, 4_000),
      comments: [{ id: 1, body: `${MARKER}\nStale` }],
    })

    assert.equal(run.patched.length, 1)
    assert.match(run.patched[0].body, /\(1\/2\)/)
    assert.equal(run.posted.length, 1)
    assert.match(run.posted[0], /\(2\/2\)/)
  })

  test('finds its own comment past the first page', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'Chatter' }))
    const run = await succeed({
      ...options,
      comments: [...filler, { id: 500, body: `${MARKER}\nStale` }],
    })

    assert.deepEqual(run.posted, [])
    assert.equal(run.patched[0]?.id, 500)
  })

  test('never touches a comment without the marker', async () => {
    const run = await succeed({
      ...options,
      comments: [
        { id: 1, body: 'A reviewer said something' },
        { id: 2, body: `Quoting: ${MARKER}` },
        { id: 3, body: null },
      ],
    })

    assert.equal(run.posted.length, 1)
    assert.deepEqual(run.patched, [])
    assert.deepEqual(run.deleted, [])
  })
})

const missing = (name, ...versions) =>
  Object.fromEntries(
    versions.map((version) => [`GET https://proxy.golang.org/${name}/@v/${version}.info`, notFound]),
  )
const failing = (status, headers) => ({ status, headers, body: { message: 'no' } })
const barRoutes = (body) => releasesRoute('foo/bar', [release('v1.2.0', body)])
const withBody = (body) => ({ messages: [barUpdate()], routes: barRoutes(body) })
const goChange = goModFile([['example.test/go', 'v1.0.0', 'v1.1.0']])
const goMissing = missing('example.test/go', 'v1.0.0', 'v1.1.0')

describe('updates outside go.mod', () => {
  const npm = updatesBlock('left-pad', '1.0.0', '1.1.0', 'https://github.com/foo/pad/compare/v1.0.0...v1.1.0')
  const padRoutes = releasesRoute('foo/pad', [release('v1.1.0', 'pad notes')])

  test('keeps another ecosystem in a mixed update, without asking the proxy', async () => {
    const run = await succeed({
      messages: [npm],
      files: [goChange, { filename: 'package.json', patch: '-a\n+b' }],
      routes: { ...goMissing, ...padRoutes },
    })

    assert.match(run.posted[0], /example\.test\/go/)
    assert.match(run.posted[0], /pad notes/)
    assert.ok(!run.requests.some((request) => request.url.includes('proxy.golang.org/left-pad')))
  })

  test('keeps an update announced for a go.mod without a patch', async () => {
    const comment = await postedComment({
      messages: [npm],
      files: [goChange, { filename: 'sub/go.mod' }],
      routes: { ...goMissing, ...padRoutes },
    })

    assert.match(comment, /pad notes/)
  })

  test('does not report a module twice when the message has another range', async () => {
    const comment = await withoutNotes({
      messages: [updatesBlock('example.test/go', '1.0.0', '1.0.5', 'https://github.com/foo/go/compare/v1.0.0...v1.0.5')],
      files: [goChange, { filename: 'package.json', patch: '-a\n+b' }],
      routes: goMissing,
    })

    assert.equal(count(comment, 'example.test/go '), 1)
    assert.match(comment, /1\.0\.0 → 1\.1\.0/)
  })
})

describe('a dependency that fails', () => {
  const two = `${barUpdate()}\n\n${updatesBlock('github.com/foo/ok', '1.0.0', '1.1.0', 'https://github.com/foo/ok/compare/v1.0.0...v1.1.0')}`
  const okUpdate = updatesBlock('github.com/foo/ok', '1.0.0', '1.1.0', 'https://github.com/foo/ok/compare/v1.0.0...v1.1.0')
  const okFirst = `${okUpdate}\n\n${barUpdate()}`
  const okRoutes = releasesRoute('foo/ok', [release('v1.1.0', 'ok notes')])

  test('costs the others nothing and the run still succeeds', async () => {
    const run = await succeed({
      messages: [two],
      routes: {
        'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': failing(403),
        'GET https://api.github.com/repos/foo/bar/compare/v1.0.0...v1.2.0': failing(403),
        ...okRoutes,
      },
    })

    assert.match(run.posted[0], /ok notes/)
    assert.match(run.posted[0], /\| `github\.com\/foo\/bar` .*\| None/)
    assert.match(run.stderr, /github\.com\/foo\/bar: GET .*403/)
  })

  test('still lists the commits when its releases are refused', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': failing(403),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', [upstreamCommit('A commit')]),
      },
    })

    assert.match(comment, /A commit/)
  })

  test('asks a failed project once', async () => {
    const run = await succeed({
      messages: [`${barUpdate()}\n\n${barUpdate('1.1.0', '1.2.0')}`],
      routes: {
        'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': failing(403),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', []),
        ...compareRoute('foo/bar', 'v1.1.0', 'v1.2.0', []),
      },
    })

    assert.equal(run.requests.filter((request) => request.url.includes('/releases')).length, 1)
  })

  for (const [name, route] of [
    ['a 429', failing(429)],
    ['a 403 with no requests left', failing(403, { 'x-ratelimit-remaining': '0' })],
    ['a 403 asking to retry', failing(403, { 'retry-after': '60' })],
    [
      'a 403 that only its message calls a secondary rate limit',
      { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } },
    ],
  ]) {
    test(`posts what it has and exits 1 on ${name}`, async () => {
      const run = await runAction({
        messages: [okFirst],
        routes: {
          'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': route,
          'GET https://api.github.com/repos/foo/bar/compare/v1.0.0...v1.2.0': route,
          ...okRoutes,
        },
      })

      assert.equal(run.code, 1)
      assert.match(run.stderr, /Rate limited/)
      assert.match(run.posted[0], /ok notes/)
    })
  }

  test('exits 1 on a dry run that was rate limited', async () => {
    const run = await runAction({
      messages: [barUpdate()],
      args: ['--dry-run'],
      routes: {
        'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': failing(429),
        'GET https://api.github.com/repos/foo/bar/compare/v1.0.0...v1.2.0': failing(429),
      },
    })

    assert.equal(run.code, 1)
  })
})

describe('markup in release bodies', () => {
  test('closes a code fence the truncation cut', async () => {
    const comment = await postedComment(withBody(`\`\`\`go\n${'x'.repeat(5_000)}`))

    assert.match(comment, /x\n```\n\n_… truncated\._/)
  })

  test('closes a tilde fence with its own length', async () => {
    const comment = await postedComment(withBody(`~~~~\n~~~\n${'x'.repeat(5_000)}`))

    assert.match(comment, /x\n~~~~\n\n_… truncated\._/)
  })

  test('does not close a fence the body closed itself', async () => {
    const comment = await postedComment(withBody(`\`\`\`\ncode\n\`\`\`\n${'x'.repeat(5_000)}`))

    assert.match(comment, /x\n\n_… truncated\._/)
  })

  test('closes an HTML comment the truncation cut', async () => {
    const comment = await postedComment(withBody(`<!-- ${'x'.repeat(5_000)}`))

    assert.match(comment, /x -->\n\n_… truncated\._/)
  })

  test('does not mistake a comment opener in code for a comment', async () => {
    const comment = await postedComment(withBody(`\`\`\`\n<!--\n\`\`\`\n${'x'.repeat(5_000)}`))

    assert.match(comment, /x\n\n_… truncated\._/)
  })

  test('closes what a short body left open', async () => {
    const fence = await postedComment(withBody('```\nnever closed'))
    const html = await postedComment(withBody('<!-- never closed'))

    assert.match(fence, /never closed\n```\n/)
    assert.match(html, /never closed -->\n/)
  })

  test('cuts nothing in the middle when a section is over its limit', async () => {
    const releases = ['1', '2', '3', '4', '5'].map((minor) =>
      release(`v1.${minor}.0`, `\`\`\`\n${'x'.repeat(3_950)}\n\`\`\``),
    )
    const comment = await postedComment({
      messages: [barUpdate('1.0.0', '1.5.0')],
      routes: releasesRoute('foo/bar', releases),
    })

    assert.equal(count(comment, '```') % 2, 0)
    assert.doesNotMatch(comment, /truncated/)
  })

  test('strips disclosure tags, but not from code', async () => {
    const comment = await postedComment(
      withBody('<details open><summary>More</summary>inner</details>\n\n`<details>`'),
    )

    assert.equal(count(comment, '<details>'), 2)
    assert.equal(count(comment, '</details>'), 1)
    assert.ok(comment.includes('Moreinner'))
  })
})

describe('versions that are not x.y.z', () => {
  const notes = (name, from, to, compare, project, releases) =>
    postedComment({
      messages: [updatesBlock(name, from, to, `https://github.com/${project}/compare/${compare}`)],
      routes: {
        ...releasesRoute(project, releases),
        ...compareRoute(project, ...compare.split('...'), []),
      },
    })

  test('reads a major version alone', async () => {
    const comment = await notes('actions/checkout', '4', '5', 'v4...v5', 'actions/checkout', [
      release('v5.1.0', 'too new'),
      release('v5.0.0', 'five notes'),
      release('v4.0.0', 'too old'),
    ])

    assert.match(comment, /five notes/)
    assert.doesNotMatch(comment, /too new|too old/)
  })

  for (const [from, to] of [
    ['1.1', '1.2'],
    ['1.2.3.3', '1.2.3.4'],
    ['2024.01.15', '2024.02.01'],
  ]) {
    test(`reads ${from} to ${to}`, async () => {
      const comment = await notes('foo', from, to, `${from}...${to}`, 'foo/foo', [
        release(to, 'the notes'),
        release(from, 'old notes'),
      ])

      assert.match(comment, /the notes/)
      assert.doesNotMatch(comment, /old notes/)
    })
  }

  test('orders a Python prerelease before its release', async () => {
    const comment = await notes('foo', '2.0.0rc1', '2.0.0', '2.0.0rc1...2.0.0', 'foo/foo', [
      release('2.0.0', 'final notes'),
    ])

    assert.match(comment, /final notes/)
  })

  test('ignores build metadata', async () => {
    const comment = await notes('foo', '1.0.0', '2.0.0+incompatible', 'v1.0.0...v2.0.0+incompatible', 'foo/foo', [
      release('v2.0.0', 'two notes'),
    ])

    assert.match(comment, /two notes/)
  })

  test('selects the releases of an npm package by its prefix', async () => {
    const comment = await notes(
      '@scope/pkg',
      '1.0.0',
      '1.2.0',
      '%40scope/pkg%401.0.0...%40scope/pkg%401.2.0',
      'foo/mono',
      [release('@scope/pkg@1.2.0', 'pkg notes'), release('@scope/other@1.2.0', 'other notes')],
    )

    assert.match(comment, /pkg notes/)
    assert.doesNotMatch(comment, /other notes/)
  })

  for (const [from, to] of [
    ['1.2.3', '1.2.3.post1'],
    ['release-1.2.3', 'release-1.2.4'],
  ]) {
    test(`finds the release tagged ${to} by name`, async () => {
      const comment = await notes('foo', from, to, `${from}...${to}`, 'foo/foo', [
        release(to, 'exact notes'),
        release('v9.0.0', 'other notes'),
      ])

      assert.match(comment, /exact notes/)
      assert.doesNotMatch(comment, /other notes/)
    })
  }
})

describe('paging', () => {
  const page = (start, tag = (index) => `other/v1.0.${index}`) =>
    Array.from({ length: 100 }, (_, index) => release(tag(start + index), 'filler'))
  const releasesUrl = (number) =>
    `GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=${number}`

  test('reads on to a release past the first page', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        [releasesUrl(1)]: ok(page(0)),
        [releasesUrl(2)]: ok([release('v1.2.0', 'late notes')]),
      },
    })

    assert.match(comment, /late notes/)
  })

  test('reads on past the first page on GitLab', async () => {
    const url = (number) =>
      `GET https://gitlab.com/api/v4/projects/foo%2Fbar/releases?per_page=100&page=${number}`
    const comment = await postedComment({
      messages: [updatesBlock('foo', '1.0.0', '1.2.0', 'https://gitlab.com/foo/bar/-/compare/v1.0.0...v1.2.0')],
      routes: {
        [url(1)]: ok(Array.from({ length: 100 }, (_, index) => ({ tag_name: `x/${index}`, name: 'x' }))),
        [url(2)]: ok([{ tag_name: 'v1.2.0', name: 'v1.2.0', description: 'late gitlab notes' }]),
      },
    })

    assert.match(comment, /late gitlab notes/)
  })

  // No route covers page 2, so asking for it would fail the test.
  test('stops once it has reached the base of the range', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        [releasesUrl(1)]: ok([release('v1.2.0', 'bar notes'), release('v1.0.0', 'old'), ...page(0).slice(2)]),
      },
    })

    assert.match(comment, /bar notes/)
  })

  test('stops at the page limit', async () => {
    const routes = compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', [])
    for (let number = 1; number <= 10; number++) {
      routes[releasesUrl(number)] = ok(page(number * 100))
    }

    const run = await succeed({ messages: [barUpdate()], routes })

    assert.equal(run.requests.filter((request) => request.url.includes('/releases')).length, 10)
  })

  test('reads the commits of the pull request past the first page', async () => {
    const filler = Array.from({ length: 100 }, () => 'A commit')
    const comment = await postedComment({
      messages: [...filler, barUpdate()],
      routes: barRoutes('bar notes'),
    })

    assert.match(comment, /bar notes/)
  })
})

describe('comments of other authors', () => {
  const user = (login) => ({ user: { login } })

  test('are never touched, whatever they start with', async () => {
    const run = await succeed({
      ...withBody('bar notes'),
      comments: [{ id: 1, body: `${MARKER}\nNot from the action`, ...user('mallory') }],
    })

    assert.equal(run.posted.length, 1)
    assert.deepEqual(run.patched, [])
    assert.deepEqual(run.deleted, [])
  })

  test('are not counted as a part', async () => {
    const run = await succeed({
      ...withBody('bar notes'),
      comments: [
        { id: 1, body: `${MARKER}\nPlanted`, ...user('mallory') },
        { id: 2, body: `${MARKER}\nStale` },
      ],
    })

    assert.deepEqual(run.patched.map((comment) => comment.id), [2])
  })

  test('are the action\'s own under the configured author', async () => {
    const run = await succeed({
      ...withBody('bar notes'),
      env: { COMMENT_AUTHOR: 'release-bot' },
      comments: [
        { id: 1, body: `${MARKER}\nStale`, ...user('release-bot') },
        { id: 2, body: `${MARKER}\nStale` },
      ],
    })

    assert.deepEqual(run.patched.map((comment) => comment.id), [1])
    assert.deepEqual(run.deleted, [])
  })
})

describe('a pull request that cannot be read', () => {
  for (const path of ['commits', 'files']) {
    test(`fails on a 404 from ${path}`, async () => {
      const run = await runAction({
        messages: ['Fix a typo'],
        routes: { [`GET ${API}/pulls/${PULL_REQUEST}/${path}?per_page=100&page=1`]: notFound },
      })

      assert.notEqual(run.code, 0)
      assert.match(run.stderr, /check the pull request number/)
    })
  }
})

describe('nothing left to report', () => {
  test('deletes the comments of earlier runs', async () => {
    const run = await succeed({
      messages: ['Fix a typo'],
      comments: [
        { id: 1, body: `${MARKER}\nOld` },
        { id: 2, body: `${MARKER}\nOld too` },
        { id: 3, body: 'A reviewer said something' },
      ],
    })

    assert.match(run.stdout, /nothing to post/)
    assert.deepEqual(run.deleted, [1, 2])
    assert.deepEqual(run.posted, [])
  })

  test('writes nothing on a dry run', async () => {
    const run = await succeed({
      messages: ['Fix a typo'],
      args: ['--dry-run'],
      comments: [{ id: 1, body: `${MARKER}\nOld` }],
    })

    assert.match(run.stdout, /nothing to post/)
    assert.deepEqual(run.deleted, [])
  })
})

describe('references', () => {
  test('sends links to github.com through the redirect host', async () => {
    const comment = await postedComment(
      withBody('by me in https://github.com/org/repo/pull/123 and [the fix](https://github.com/org/repo/pull/4)'),
    )

    assert.ok(comment.includes('in https://redirect.github.com/org/repo/pull/123 and'))
    assert.ok(comment.includes('[the fix](https://redirect.github.com/org/repo/pull/4)'))
    assert.ok(!comment.includes('https://github.com/org/repo/pull/123'))
  })

  test('quiets the links of commits and releases, not of the compare link', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        ...releasesRoute('foo/bar', []),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', [
          upstreamCommit('A commit', 'https://github.com/foo/bar/commit/abc'),
        ]),
      },
    })

    assert.ok(comment.includes('(https://redirect.github.com/foo/bar/commit/abc)'))
    assert.ok(comment.includes('[Commits](https://github.com/foo/bar/compare/'))

    const released = await postedComment({
      messages: [barUpdate()],
      routes: releasesRoute('foo/bar', [
        release('v1.2.0', 'notes', { html_url: 'https://github.com/foo/bar/releases/tag/v1.2.0' }),
      ]),
    })

    assert.ok(released.includes('(https://redirect.github.com/foo/bar/releases/tag/v1.2.0)'))
  })

  test('leaves other hosts alone', async () => {
    const comment = await postedComment(withBody('https://notgithub.com/a https://example.test/github.com/a'))

    assert.ok(comment.includes('https://notgithub.com/a https://example.test/github.com/a'))
  })

  for (const [what, text] of [
    ['a URL with an anchor', 'https://example.test/guide#install'],
    ['a URL with an @', 'https://example.test/tag/pkg@1.2.3'],
    ['a link to an anchor', '[up](#install)'],
    ['a link with an anchor', '[docs](https://example.test/guide#install)'],
    ['inline code', '`npm i @scope/pkg #1`'],
    ['a fenced block', '```\nnpm i @scope/pkg\n#1\n```'],
    ['a package version', 'pkg@1.2.3'],
  ]) {
    test(`leaves ${what} intact`, async () => {
      const comment = await postedComment(withBody(text))

      assert.ok(comment.includes(text), comment)
    })
  }

  for (const [what, text, defused] of [
    ['a handle in parentheses', '(@alice)', `(@${ZERO_WIDTH_SPACE}alice)`],
    ['a handle after a slash', 'see/@alice', `see/@${ZERO_WIDTH_SPACE}alice`],
    ['a handle after a dot', 'see.@alice', `see.@${ZERO_WIDTH_SPACE}alice`],
    ['a handle after a dash', 'see-@alice', `see-@${ZERO_WIDTH_SPACE}alice`],
    ['a handle after a hash', '#@alice', `#@${ZERO_WIDTH_SPACE}alice`],
    ['a handle after an at sign', '@@alice', `@@${ZERO_WIDTH_SPACE}alice`],
    ['no version of a package', 'pkg@1.2.3', 'pkg@1.2.3'],
    ['an issue in another repository', 'org/repo#123', `org/repo#${ZERO_WIDTH_SPACE}123`],
    ['an issue of another owner', 'owner#123', `owner#${ZERO_WIDTH_SPACE}123`],
    ['a handle beside code', '`a` @alice `b`', `\`a\` @${ZERO_WIDTH_SPACE}alice \`b\``],
  ]) {
    test(`defuses ${what}`, async () => {
      const comment = await postedComment(withBody(text))

      assert.ok(comment.includes(defused), comment)
    })
  }
})

describe('Dependabot link forms', () => {
  const babel = (form = 'Bumps [@babel/core](https://github.com/babel/babel/tree/HEAD/packages/babel-core) from 7.24.0 to 7.25.0.') =>
    `${form}\n- [Release notes](https://github.com/babel/babel/releases)\n- [Commits](https://github.com/babel/babel/commits/v7.25.0/packages/babel-core)`

  test('reads the releases of a package linked by its directory', async () => {
    const comment = await postedComment({
      messages: [babel()],
      routes: releasesRoute('babel/babel', [
        release('v7.25.0', 'new notes'),
        release('v7.24.0', 'old notes'),
      ]),
    })

    assert.match(comment, /new notes/)
    assert.doesNotMatch(comment, /old notes/)
  })

  test('reads the form that names the directory ahead of the versions', async () => {
    const comment = await postedComment({
      messages: [
        'Bumps [react-dom](https://github.com/react/react/tree/HEAD/packages/react-dom) in `/games` from 19.2.8 to 19.3.0.\n- [Commits](https://github.com/react/react/commits/v19.3.0/packages/react-dom)',
      ],
      routes: releasesRoute('react/react', [release('v19.3.0', 'react notes')]),
    })

    assert.match(comment, /react-dom<\/code> — 19\.2\.8 → 19\.3\.0/)
    assert.match(comment, /react notes/)
  })

  test('reads a tag with a package in it off the commits link', async () => {
    const comment = await postedComment({
      messages: [
        'Bumps [@sveltejs/kit](https://github.com/sveltejs/kit/tree/HEAD/packages/kit) from 3.0.1 to 3.1.0.\n- [Commits](https://github.com/sveltejs/kit/commits/@sveltejs/kit@3.1.0/packages/kit)',
      ],
      routes: releasesRoute('sveltejs/kit', [
        release('@sveltejs/package@3.1.0', 'other package'),
        release('@sveltejs/kit@3.1.0', 'kit notes'),
      ]),
    })

    assert.match(comment, /kit notes/)
    assert.doesNotMatch(comment, /other package/)
  })

  test('finds tags by package from a table row, which gives only the project', async () => {
    const comment = await postedComment({
      messages: ['| [@sveltejs/kit](https://github.com/sveltejs/kit/tree/HEAD/packages/kit) | `3.0.1` | `3.1.0` |'],
      routes: releasesRoute('sveltejs/kit', [
        release('@sveltejs/package@3.1.0', 'other package'),
        release('@sveltejs/kit@3.1.0', 'kit notes'),
      ]),
    })

    assert.match(comment, /kit notes/)
    assert.doesNotMatch(comment, /other package/)
  })

  test('lists commits under the tag spelled after the package', async () => {
    const empty = (base, head) => compareRoute('foo/mono', base, head, [])
    const comment = await postedComment({
      messages: ['| [pkg](https://github.com/foo/mono/tree/HEAD/packages/pkg) | `1.0.0` | `1.1.0` |'],
      routes: {
        ...releasesRoute('foo/mono', []),
        ...empty('v1.0.0', 'v1.1.0'),
        ...empty('1.0.0', '1.1.0'),
        ...compareRoute('foo/mono', 'pkg@1.0.0', 'pkg@1.1.0', [upstreamCommit('Package commit')]),
      },
    })

    assert.match(comment, /Package commit/)
  })

  test('refuses a link that climbs out of the API path', async () => {
    const run = await succeed({
      messages: [updatesBlock('x', '1.0.0', '2.0.0', 'https://github.com/foo/bar/compare/../../user...v2')],
    })

    assert.ok(!run.requests.some((request) => request.url.includes('..')))
  })
})

describe('commit hashes', () => {
  const [from, to] = [`4${'a'.repeat(39)}`, `6${'b'.repeat(39)}`]
  const pseudo = updatesBlock('x/y', '0.0.0-1', '0.0.0-2', `https://github.com/x/y/compare/${from}...${to}`)

  test('name no release, and only the commits are read', async () => {
    const run = await succeed({
      messages: [pseudo],
      routes: compareRoute('x/y', from, to, [upstreamCommit('The change')]),
    })

    assert.match(run.posted[0], /The change/)
    assert.ok(!run.requests.some((request) => request.url.includes('/releases')))
  })
})

describe('temporary failures', () => {
  const releases = 'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1'
  const compare = 'GET https://api.github.com/repos/foo/bar/compare/v1.0.0...v1.2.0'
  const down = { [releases]: { status: 502, body: {} }, [compare]: { status: 502, body: {} } }

  test('are retried', async () => {
    const run = await runAction({ messages: [barUpdate()], routes: down })

    assert.equal(run.requests.filter((request) => request.url.includes('/releases')).length, 3)
  })

  test('keep the comments of an earlier run and exit 1', async () => {
    const run = await runAction({
      messages: [barUpdate()],
      comments: [{ id: 1, body: `${MARKER}\ngood notes` }],
      routes: down,
    })

    assert.equal(run.code, 1)
    assert.deepEqual(run.patched, [])
    assert.deepEqual(run.deleted, [])
  })

  test('post nothing when no notes could be read, and exit 1', async () => {
    const run = await runAction({ messages: [barUpdate()], routes: down })

    assert.equal(run.code, 1)
    assert.deepEqual(run.posted, [])
  })

  test('stop the lookups once rate limited', async () => {
    const limited = { status: 429, body: {} }
    const other = updatesBlock('github.com/foo/ok', '1.0.0', '1.1.0', 'https://github.com/foo/ok/compare/v1.0.0...v1.1.0')
    const run = await runAction({
      messages: [`${barUpdate()}\n\n${other}`],
      routes: { [releases]: limited },
    })

    assert.equal(run.code, 1)
    assert.ok(!run.requests.some((request) => request.url.includes('/foo/ok/')))
  })
})

describe('writes', () => {
  test('fail on a 404', async () => {
    const run = await runAction({
      messages: [barUpdate()],
      routes: {
        ...releasesRoute('foo/bar', [release('v1.2.0', 'notes')]),
        [`POST ${COMMENTS_URL}`]: notFound,
      },
    })

    assert.notEqual(run.code, 0)
  })
})

describe('pull request author', () => {
  const opened = (login) => ({ [`GET ${API}/pulls/${PULL_REQUEST}`]: ok({ user: { login } }) })

  test('must be Dependabot', async () => {
    const run = await runAction({ messages: [barUpdate()], routes: opened('someone') })

    assert.notEqual(run.code, 0)
    assert.match(run.stderr, /opened by someone/)
    assert.deepEqual(run.posted, [])
  })
})

describe('action inputs', () => {
  test('stand in for the local variables', async () => {
    const run = await succeed({
      messages: [barUpdate()],
      env: { GITHUB_TOKEN: '', PR_NUMBER: '', INPUT_TOKEN: TOKEN, 'INPUT_PULL-REQUEST': PULL_REQUEST },
      routes: releasesRoute('foo/bar', [release('v1.2.0', 'notes')]),
    })

    assert.equal(run.posted.length, 1)
  })
})

describe('rendering, further', () => {
  const body = (text) => ({
    messages: [barUpdate()],
    routes: releasesRoute('foo/bar', [release('v1.2.0', text)]),
  })

  test('defuses GH- references', async () => {
    const comment = await postedComment(body('Fixes GH-123, not `GH-124`'))

    assert.ok(comment.includes(`GH${ZERO_WIDTH_SPACE}-123`))
    assert.ok(comment.includes('`GH-124`'))
  })

  test('names the repository for packages that share no path', async () => {
    const shared = (name) => updatesBlock(name, '1.0.0', '2.0.0', `https://github.com/f/r/compare/${name}-1...${name}-2`)
    const comment = await postedComment({
      messages: [`${shared('react')}\n\n${shared('react-dom')}`],
      routes: {
        ...releasesRoute('f/r', []),
        ...compareRoute('f/r', 'react-1', 'react-2', [upstreamCommit('c')]),
        ...compareRoute('f/r', 'react-dom-1', 'react-dom-2', [upstreamCommit('c')]),
      },
    })

    assert.match(comment, /<code>f\/r<\/code> — 2 packages/)
  })

  test('counts commits past what the compare returned', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        ...releasesRoute('foo/bar', []),
        'GET https://api.github.com/repos/foo/bar/compare/v1.0.0...v1.2.0': ok({
          total_commits: 2493,
          commits: Array.from({ length: 250 }, (_, index) => upstreamCommit(`Commit ${index}`)),
        }),
      },
    })

    assert.match(comment, /… and 2473 earlier\./)
    assert.match(comment, /Commit 249]/)
  })

  test('keeps the links of undescribed releases when there are no commits', async () => {
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        ...releasesRoute('foo/bar', [release('v1.2.0', '')]),
        ...compareRoute('foo/bar', 'v1.0.0', 'v1.2.0', []),
      },
    })

    assert.match(comment, /example\.test\/releases\/v1\.2\.0/)
    assert.match(comment, /No release notes\./)
  })

  test('closes an HTML block a body leaves open', async () => {
    const comment = await postedComment(body('<table><tr><td>cell'))

    assert.match(comment, /<\/table>\n/)
  })

  test('does not leave a tag cut in half', async () => {
    const comment = await postedComment(body(`${'x'.repeat(3_990)} <img src="https://example.test/a.png">`))

    assert.doesNotMatch(comment, /<img/)
  })
})

test('reads past a backport published after the versions above it', async () => {
  const page = Array.from({ length: 100 }, (_, index) => release(`v1.0.${index + 10}`, 'backport'))
  const comment = await postedComment({
    messages: [updatesBlock('github.com/foo/bar', '2.0.0', '2.1.0', 'https://github.com/foo/bar/compare/v2.0.0...v2.1.0')],
    routes: {
      'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': ok(page),
      'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=2': ok([
        release('v2.1.0', 'wanted notes'),
        release('v2.0.0', 'base notes'),
      ]),
    },
  })

  assert.match(comment, /wanted notes/)
})

test('reads past a base that is itself a backport', async () => {
  const comment = await postedComment({
    messages: [updatesBlock('github.com/foo/bar', '20.3.5', '21.1.0', 'https://github.com/foo/bar/compare/v20.3.5...v21.1.0')],
    routes: {
      'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=1': ok([
        release('v21.1.0', 'newest notes'),
        release('v20.3.5', 'base notes'),
        ...Array.from({ length: 98 }, (_, index) => release(`v19.0.${index + 1}`, 'older branch')),
      ]),
      'GET https://api.github.com/repos/foo/bar/releases?per_page=100&page=2': ok([
        release('v21.0.0', 'major notes'),
        release('v20.3.0', 'branch start'),
      ]),
    },
  })

  assertInOrder(comment, 'major notes', 'newest notes')
})

test('an exclude block is not a requirement', async () => {
  const run = await succeed({
    messages: ['Fix a typo'],
    files: [{ filename: 'go.mod', patch: '@@ -1,3 +1,3 @@ exclude (\n-\tfoo.test/a v1.0.0\n+\tfoo.test/a v1.1.0\n )' }],
  })

  assert.deepEqual(run.posted, [])
})
