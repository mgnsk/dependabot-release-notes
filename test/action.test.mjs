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
} from './harness.mjs'

const ZERO_WIDTH_SPACE = '​'
const API = `https://api.github.com/repos/${REPOSITORY}`
const COMMITS_URL = `GET ${API}/pulls/${PULL_REQUEST}/commits?per_page=100`
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
      ...releasesRoute(`foo/project${index}`, [release('v1.1.0', 'x'.repeat(bodyLength))]),
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
      routes: noteRoutes,
    })

    assert.equal(count(comment, '<details>'), 2)
  })

  for (const [form, message] of [
    ['a linked Bumps', 'Bumps [foo](https://github.com/foo/foo) from 1.0.0 to 1.2.0.'],
    ['a plain Bumps', 'Bumps foo from 1.0.0 to 1.2.0.'],
    ['a linked Bumps with a directory', 'Bumps [foo](https://example.test) from 1.0.0 to 1.2.0 in /sub.'],
    ['a plain Bumps with a directory', 'Bumps foo from 1.0.0 to 1.2.0 in /sub'],
  ]) {
    test(`parses ${form}`, async () => {
      const comment = await postedComment({ messages: [message] })

      assert.match(comment, /<code>foo<\/code> — 1\.0\.0 → 1\.2\.0/)
      assert.match(comment, /No release notes available/)
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
    const comment = await postedComment({ messages: ['| foo | `1.0.0` | `1.2.0` |'] })

    assert.match(comment, /<code>foo<\/code> — 1\.0\.0 → 1\.2\.0/)
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
    assert.match(comment, /<code>example\.test\/indirect<\/code> — 0\.1\.0 → 0\.2\.0/)
    assert.doesNotMatch(comment, /only\/announced/)
  })

  test('reads require lines and go.mod files in subdirectories', async () => {
    const comment = await postedComment({
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

    assert.match(comment, /<code>example\.test\/single<\/code> — 1\.0\.0 → 1\.1\.0/)
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
    const run = await succeed({
      files: [...filler, goModFile([['example.test/late', 'v1.0.0', 'v1.1.0']])],
      routes: {
        ...missing('example.test/late', 'v1.0.0'),
        ...missing('example.test/late', 'v1.1.0'),
      },
    })

    assert.match(run.posted[0], /example\.test\/late/)
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
    const from = '0.0.0-20260101000000-aaaaaaaaaaaa'
    const to = '0.0.0-20260201000000-bbbbbbbbbbbb'
    const comment = await postedComment({
      files: [goModFile([['example.test/pseudo', `v${from}`, `v${to}`]])],
      routes: {
        ...proxyRoute('example.test/pseudo', `v${from}`, {
          URL: 'https://github.com/foo/bar',
          Hash: 'aaa',
        }),
        ...proxyRoute('example.test/pseudo', `v${to}`, {
          URL: 'https://github.com/foo/bar',
          Hash: 'bbb',
        }),
        ...compareRoute('foo/bar', 'aaa', 'bbb', [upstreamCommit('A change')]),
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
    const comment = await postedComment({
      files: [goModFile([['example.test/moved', 'v1.0.0', 'v1.1.0']])],
      routes: {
        ...proxyRoute('example.test/moved', 'v1.0.0', tagged('v1.0.0', 'https://github.com/old/home')),
        ...proxyRoute('example.test/moved', 'v1.1.0', tagged('v1.1.0', 'https://github.com/new/home')),
      },
    })

    assert.match(comment, /No release notes available/)
  })

  test('warns and carries on when the proxy fails', async () => {
    const failing = { status: 500, body: { message: 'proxy down' } }
    const run = await succeed({
      files: [goModFile([['example.test/flaky', 'v1.0.0', 'v1.1.0']])],
      routes: {
        'GET https://proxy.golang.org/example.test/flaky/@v/v1.0.0.info': failing,
        'GET https://proxy.golang.org/example.test/flaky/@v/v1.1.0.info': failing,
      },
    })

    assert.match(run.stderr, /example\.test\/flaky@v1\.0\.0/)
    assert.match(run.posted[0], /No release notes available/)
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
    const comment = await postedComment({
      messages: [barUpdate('1.2.0-rc.10', '1.2.0-rc.9')],
      routes: {
        ...releasesRoute('foo/bar', [release('v1.2.0-rc.9', 'candidate notes')]),
        ...compareRoute('foo/bar', 'v1.2.0-rc.10', 'v1.2.0-rc.9', []),
      },
    })

    assert.doesNotMatch(comment, /candidate notes/)
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
        'GET https://gitlab.com/api/v4/projects/foo%2Fbar/releases?per_page=100': ok([
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

  test('falls back to a release that names the version of a monorepo module', async () => {
    const comment = await postedComment({
      messages: [
        updatesBlock(
          'example.test/otel/contrib',
          '0.69.0',
          '0.70.0',
          'https://github.com/otel/contrib/compare/contrib/v0.69.0...contrib/v0.70.0',
        ),
      ],
      routes: releasesRoute('otel/contrib', [
        release('v1.45.0', 'the right notes', { name: 'Release v1.45.0/v2.5.2/v0.70.0/v0.1.0' }),
        release('v1.44.0', 'older notes', { name: 'Release v1.44.0/v0.69.0' }),
        release('v1.46.0', 'lookalike notes', { name: 'Release v1.46.0/v0.70.01/v10.70.0' }),
      ]),
    })

    assert.match(comment, /the right notes/)
    assert.doesNotMatch(comment, /older notes|lookalike notes/)
  })

  test('does not read release names for a module at the repository root', async () => {
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
    const comment = await postedComment({
      messages: [barUpdate()],
      routes: {
        'GET https://api.github.com/repos/foo/bar/releases?per_page=100': notFound,
        'GET https://api.github.com/repos/foo/bar/compare/v1.0.0...v1.2.0': notFound,
      },
    })

    assert.match(comment, /No release notes available/)
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
          [`GET ${project}/releases?per_page=100`]: ok([
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
          [`GET ${project}/releases?per_page=100`]: ok([]),
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
        'GET https://gitlab.com/api/v4/projects/cznic%2Fsqlite/releases?per_page=100': ok([]),
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

  test('truncates a dependency that fills its section', async () => {
    const releases = ['1', '2', '3', '4', '5'].map((minor) =>
      release(`v1.${minor}.0`, `notes of ${minor} ${'x'.repeat(3_900)}`),
    )
    const comment = await postedComment({
      messages: [barUpdate('1.0.0', '1.5.0')],
      routes: releasesRoute('foo/bar', releases),
    })

    assert.match(comment, /notes of 1 /)
    assert.doesNotMatch(comment, /notes of 5 /)
    assert.equal(count(comment, '_… truncated._'), 1)
    assert.ok(comment.length < 16_000, `${comment.length} chars`)
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

    assert.match(comment, /No release published\. Commits in this range/)
    assert.match(comment, /Commit 19]/)
    assert.doesNotMatch(comment, /Commit 20]/)
    assert.match(comment, /… and 3 more\./)
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
    assert.match(comment, /<code>github\.com\/aws\/sdk\/service<\/code> — 2 modules/)
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
    assert.match(run.stdout, /1 updates, 1 comment\(s\)/)
    assert.deepEqual(
      run.requests.filter((request) => request.method !== 'GET'),
      [],
    )
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

