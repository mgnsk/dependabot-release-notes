import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { hasForeignTags } from '../lib/go.mjs'
import { changelogSections } from '../lib/notes.mjs'
import { bumpKind, closeOpenMarkup, escapeUnknownTags } from '../lib/render.mjs'
import { compareVersions, headPrefix, parseVersion } from '../lib/tags.mjs'
import { parseUpdates } from '../lib/updates.mjs'
import {
  MARKER,
  PULL_REQUEST,
  REPOSITORY,
  compareRoute,
  dependabotCommit,
  goModFile,
  notFound,
  ok,
  proxyRoute,
  release,
  releasesRoute,
  runAction,
  upstreamCommit,
} from '../test-support/harness.mjs'

const API = `https://api.github.com/repos/${REPOSITORY}`
const PULL = `GET ${API}/pulls/${PULL_REQUEST}`

const heads = (comment) => [...comment.matchAll(/^\*\*\[(.*?)]\(/gm)].map((match) => match[1])
const count = (text, part) => text.split(part).length - 1

async function comment(options) {
  const run = await runAction(options)
  assert.equal(run.code, 0, run.stderr)

  return run.posted.join('\n')
}

function pullWith(body, login = 'dependabot[bot]') {
  return { [PULL]: ok({ user: { login }, body }) }
}

describe('tag prefixes', () => {
  for (const [tag, prefix] of [
    ['v1.2.3', ''],
    ['1.2.3-rc-1', ''],
    ['v1.2.3-4', ''],
    ['foo-v1.3.0', 'foo-'],
    ['foo-bar-v1.0', 'foo-bar-'],
    ['netty-4.1.102.Final', 'netty-'],
    ['service/s3/v1.2', 'service/s3/'],
    ['@a/b@1.2.3-beta-1', '@a/b@'],
  ]) {
    test(`${tag} has "${prefix}"`, () => assert.equal(headPrefix(tag), prefix))
  }
})

describe('qualifiers', () => {
  for (const version of ['33.0-jre', '4.1.100.Final', '4.3.8.RELEASE', '1.2.3.post1']) {
    test(`${version} is a final release`, () => {
      assert.equal(parseVersion(version, '').prerelease, null)
    })
  }

  for (const version of ['5.0.0.RC1', '1.2.3.beta1', '0.0.2-52']) {
    test(`${version} is not`, () => assert.ok(parseVersion(version, '').prerelease))
  }

  test('a post release follows its release', () => {
    const [plain, post] = ['1.2.3', '1.2.3.post1'].map((version) => parseVersion(version, ''))

    assert.ok(compareVersions(plain, post) < 0)
  })
})

describe('commit messages', () => {
  const ranges = (...args) =>
    parseUpdates(...args).map((update) => `${update.name} ${update.from} ${update.to}`)

  test('lose the backticks around a hash', () => {
    assert.deepEqual(ranges('Bumps [sub](https://github.com/o/sub) from `034a74c` to `a60f53e`.'), [
      'sub 034a74c a60f53e',
    ])
  })

  test('do not report the headline of a group', () => {
    assert.deepEqual(
      ranges('Bumps `org.spring` from 1.0 to 2.0.\n\nUpdates `core` from 1.0 to 2.0\n- [Commits](https://github.com/o/r/compare/v1.0...v2.0)'),
      ['core 1.0 2.0'],
    )
  })

  test('keep packages that are bumped side by side', () => {
    assert.deepEqual(ranges('Bumps a from 1.0 to 2.0\nBumps b from 1.0 to 2.0'), [
      'a 1.0 2.0',
      'b 1.0 2.0',
    ])
  })

  test('drop a last line the truncation cut inside its version', () => {
    assert.deepEqual(
      ranges('| [b](https://github.com/o/b) | `1.2.3` | `1.3.0` |\n\nUpdates `b` from 1.2.3 to 1.3'),
      ['b 1.2.3 1.3.0'],
    )
  })
})

describe('descriptions', () => {
  const body = [
    'Updated [Foo.Bar](https://github.com/o/foo) from 5.0.0 to 5.0.1.',
    '',
    '<details>',
    'Updated [Quoted](https://github.com/o/quoted) from 1.0.0 to 2.0.0.',
    'Commits viewable in [compare view](https://github.com/o/foo/compare/v5.0.0...v5.0.1).',
    '</details>',
    '',
    'Updated [Baz](https://github.com/o/baz) from 1.0.0 to 1.1.0.',
    '',
    '<details>',
    'Commits viewable in [compare view](https://github.com/o/baz/commits).',
    '</details>',
  ].join('\n')

  test('name the updates a commit message leaves out, and not the ones they quote', () => {
    const updates = parseUpdates('Bump Foo.Bar across 12 directories', body)

    assert.deepEqual(
      updates.map((update) => [update.name, update.from, update.to, update.links.Commits]),
      [
        ['Foo.Bar', '5.0.0', '5.0.1', 'https://github.com/o/foo/compare/v5.0.0...v5.0.1'],
        ['Baz', '1.0.0', '1.1.0', undefined],
      ],
    )
  })

  test('get an update all the way to its notes', async () => {
    const posted = await comment({
      messages: ['Bump Foo.Bar across 12 directories'],
      routes: {
        ...pullWith(body),
        ...releasesRoute('o/foo', [release('v5.0.1', 'foo notes'), release('v5.0.0', 'old')]),
        ...releasesRoute('o/baz', [release('v1.1.0', 'baz notes'), release('v1.0.0', 'old')]),
      },
    })

    assert.match(posted, /foo notes/)
    assert.match(posted, /baz notes/)
  })
})

describe('unknown tags', () => {
  test('stay text', () => {
    assert.equal(escapeUnknownTags('drop <object> and </iframe>'), 'drop &lt;object> and &lt;/iframe>')
  })

  test('in code and known ones are left alone', () => {
    const text = '`<object>` <b>x</b> <img src="a"> <https://example.test>\n```\n<applet>\n```'

    assert.equal(escapeUnknownTags(text), text)
  })

  test('do not take the next section along', async () => {
    const posted = await comment({
      messages: ['Updates `x` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/x/compare/v1.0.0...v1.1.0)'],
      routes: releasesRoute('o/x', [release('v1.1.0', 'block <object> tags'), release('v1.0.0', 'old')]),
    })

    assert.match(posted, /block &lt;object> tags/)
  })

  test('an open inline tag is closed as well', () => {
    assert.equal(closeOpenMarkup('<b>x'), '<b>x\n</b>')
  })
})

describe('Go links', () => {
  const update = (name, tags) => ({
    name,
    links: { Commits: `https://github.com/aws/sdk/compare/${tags}` },
  })

  for (const [name, tags, foreign] of [
    ['github.com/aws/sdk/credentials', 'service/kms/v1.0.0...service/emr/v1.0.1', true],
    ['github.com/aws/sdk/service/sts', 'service/s3/v1.0.0...service/sts/v1.0.1', true],
    ['github.com/aws/sdk/service/sts', 'service/sts/v1.0.0...service/sts/v1.0.1', false],
    ['github.com/aws/sdk', 'v1.0.0...v1.0.1', false],
    ['github.com/aws/sdk/v2', 'v2.0.0...v2.0.1', false],
    ['go.vanity.test/sdk/sub', 'sub/v1.0.0...sub/v1.0.1', false],
    ['github.com/aws/sdk/pseudo', 'abcdef1...abcdef2', false],
  ]) {
    test(`${name} with ${tags}: ${foreign}`, () => {
      assert.equal(hasForeignTags(update(name, tags)), foreign)
    })
  }

  test('with another module tags give way to the proxy', async () => {
    const name = 'github.com/aws/sdk/credentials'
    const origin = (tag) => ({ URL: 'https://github.com/aws/sdk', Ref: `refs/tags/${tag}` })
    const posted = await comment({
      messages: [
        `Updates \`${name}\` from 1.0.0 to 1.0.1\n- [Commits](https://github.com/aws/sdk/compare/service/kms/v1.0.0...service/emr/v1.0.1)`,
      ],
      files: [goModFile([[name, 'v1.0.0', 'v1.0.1']])],
      routes: {
        ...proxyRoute(name, 'v1.0.0', origin('credentials/v1.0.0')),
        ...proxyRoute(name, 'v1.0.1', origin('credentials/v1.0.1')),
        ...releasesRoute('aws/sdk', []),
        ...compareRoute('aws/sdk', 'credentials/v1.0.0', 'credentials/v1.0.1', [upstreamCommit('right')]),
      },
    })

    assert.match(posted, /right/)
    assert.doesNotMatch(posted, /service\/emr/)
  })
})

describe('more releases than the page limit', () => {
  const filler = (number) =>
    Array.from({ length: 100 }, (_, index) => release(`v9.${number}.${index}-canary.1`, 'filler'))
  const pages = () => {
    const routes = {}
    for (let number = 1; number <= 10; number++) {
      routes[`GET https://api.github.com/repos/o/r/releases?per_page=100&page=${number}`] = ok(filler(number))
    }

    return routes
  }
  const message = 'Updates `r` from 1.0.0 to 1.2.0\n- [Commits](https://github.com/o/r/compare/v1.0.0...v1.2.0)'
  const tagsRoute = (major, tags) => ({
    [`GET https://api.github.com/repos/o/r/git/matching-refs/tags/v${major}.`]: ok(
      tags.map((tag) => ({ ref: `refs/tags/${tag}` })),
    ),
  })
  const byTag = (tag, route) => ({ [`GET https://api.github.com/repos/o/r/releases/tags/${tag}`]: route })

  test('are found by their tags, skipping a tag without a release', async () => {
    const posted = await comment({
      messages: [message],
      routes: {
        ...pages(),
        ...tagsRoute(1, ['v1.0.0', 'v1.1.0', 'v1.1.5', 'v1.2.0', 'v1.2.0-rc.1', 'v1.3.0']),
        ...byTag('v1.1.0', ok(release('v1.1.0', 'one one'))),
        ...byTag('v1.1.5', notFound),
        ...byTag('v1.2.0', ok(release('v1.2.0', 'one two'))),
      },
    })

    assert.deepEqual(heads(posted), ['v1.1.0', 'v1.2.0'])
    assert.doesNotMatch(posted, /not read/)
  })

  test('say so when too many are left to look up', async () => {
    const tags = Array.from({ length: 25 }, (_, index) => `v1.1.${index}`)
    const routes = { ...pages(), ...tagsRoute(1, ['v1.0.0', ...tags, 'v1.2.0']) }
    for (const tag of [...tags, 'v1.2.0']) {
      routes[Object.keys(byTag(tag))[0]] = ok(release(tag, `notes ${tag}`))
    }

    const posted = await comment({ messages: [message], routes })

    assert.match(posted, /Older releases in this range were not read/)
    assert.equal(heads(posted).at(-1), 'v1.2.0')
    assert.equal(heads(posted).length, 20)
  })
})

describe('tag styles', () => {
  for (const [title, name, tags] of [
    ['a package and a dash', 'foo', ['foo-v1.2.2', 'foo-v1.2.3', 'foo-v1.3.0']],
    ['a Java qualifier', 'guava', ['v30.0-jre', 'v31.0-jre', 'v33.0-jre']],
    ['a dotted qualifier', 'netty', ['netty-4.1.100.Final', 'netty-4.1.101.Final', 'netty-4.1.102.Final']],
  ]) {
    test(`${title} shows the releases on the way`, async () => {
      const posted = await comment({
        messages: [
          `Updates \`${name}\` from 1.0 to 2.0\n- [Commits](https://github.com/o/m/compare/${tags[0]}...${tags[2]})`,
        ],
        routes: releasesRoute('o/m', tags.toReversed().map((tag) => release(tag, `notes ${tag}`))),
      })

      assert.deepEqual(heads(posted), tags.slice(1))
    })
  }
})

describe('changelogs', () => {
  const text = [
    '# Changes',
    '',
    '## 1.3.0 - 2026-02-01',
    '### Fixed',
    '- too new',
    '## [1.2.0](https://example.test) (2026-01-01)',
    '- two',
    '',
    '```',
    '## 1.1.5 in a fence',
    '```',
    '1.1.0',
    '-----',
    '- one',
    '## other@1.1.0',
    '- not ours',
    '## 1.0.0',
    '- old',
  ].join('\n')

  test('are cut at the headings of versions', () => {
    assert.deepEqual(
      changelogSections(text, 'pkg').map(({ version }) => version),
      ['1.3.0', '1.2.0', '1.1.0', '1.0.0'],
    )
    assert.equal(changelogSections(text, 'pkg')[2].body, '- one')
    assert.equal(changelogSections(text, 'pkg')[0].body, '### Fixed\n- too new')
  })

  const message =
    'Updates `pkg` from 1.0.0 to 1.2.0\n' +
    '- [Changelog](https://github.com/o/r/blob/main/packages/pkg/CHANGELOG.md)\n' +
    '- [Commits](https://github.com/o/r/compare/v1.0.0...v1.2.0)'
  const contents = 'GET https://api.github.com/repos/o/r/contents/packages/pkg/CHANGELOG.md?ref=main'
  const file = (content) => ok({ encoding: 'base64', content: Buffer.from(content).toString('base64') })

  test('stand in for releases that are missing', async () => {
    const posted = await comment({
      messages: [message],
      routes: { ...releasesRoute('o/r', []), [contents]: file(text) },
    })

    assert.deepEqual(heads(posted), ['1.1.0', '1.2.0'])
    assert.match(posted, /From the changelog/)
    assert.doesNotMatch(posted, /too new/)
  })

  test('are not read when the releases have notes', async () => {
    const run = await runAction({
      messages: [message],
      routes: releasesRoute('o/r', [release('v1.2.0', 'notes'), release('v1.0.0', 'old')]),
    })

    assert.ok(!run.requests.some((request) => request.url.includes('/contents/')))
  })

  test('give way to the commits when they do not cover the range', async () => {
    const posted = await comment({
      messages: [message],
      routes: {
        ...releasesRoute('o/r', []),
        [contents]: file('## 0.1.0\n- ancient'),
        ...compareRoute('o/r', 'v1.0.0', 'v1.2.0', [upstreamCommit('a commit')]),
      },
    })

    assert.match(posted, /a commit/)
  })

  test('are not read from a path that climbs out of the repository, escaped or not', async () => {
    for (const climb of ['..', '%2e%2e', '%2E.']) {
      const run = await runAction({
        messages: [
          message.replace('packages/pkg/CHANGELOG.md', `${climb}/${climb}/${climb}/other/secret/contents/x`),
        ],
        routes: {
          ...releasesRoute('o/r', []),
          ...compareRoute('o/r', 'v1.0.0', 'v1.2.0', [upstreamCommit('a commit')]),
        },
      })

      assert.equal(run.code, 0, run.stderr)
      assert.ok(!run.requests.some((request) => request.url.includes('/contents/')), climb)
    }
  })
})

describe('sections', () => {
  const block = (name) =>
    `Updates \`${name}\` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/r/compare/v1.0.0...v1.1.0)`

  test('merge packages with the same releases', async () => {
    const posted = await comment({
      messages: [`${block('react')}\n\n${block('react-dom')}`],
      routes: releasesRoute('o/r', [release('v1.1.0', 'notes'), release('v1.0.0', 'old')]),
    })

    assert.equal(count(posted, '<details>'), 1)
    assert.match(posted, /- `react-dom` 1\.0\.0 → 1\.1\.0/)
  })

  test('commits are not called a missing release', async () => {
    const posted = await comment({
      messages: [block('a')],
      routes: {
        ...releasesRoute('o/r', [release('v1.1.0', ''), release('v1.0.0', '')]),
        ...compareRoute('o/r', 'v1.0.0', 'v1.1.0', [upstreamCommit('work')]),
      },
    })

    assert.match(posted, /_Commits in this range:_/)
    assert.doesNotMatch(posted, /No release published/)
  })

  test('a release without an address has no link', async () => {
    const posted = await comment({
      messages: ['Updates `y` from 1.0.0 to 1.1.0\n- [Commits](https://gitlab.com/o/y/compare/v1.0.0...v1.1.0)'],
      routes: {
        'GET https://gitlab.com/api/v4/projects/o%2Fy/releases?per_page=100&page=1': ok([
          { tag_name: 'v1.1.0', name: 'v1.1.0', description: 'b' },
          { tag_name: 'v1.0.0', name: 'v1.0.0', description: 'a' },
        ]),
      },
    })

    assert.match(posted, /^\*\*v1\.1\.0\*\*$/m)
    assert.doesNotMatch(posted, /undefined/)
  })
})

describe('overview', () => {
  const update = (name, from, to) =>
    `Updates \`${name}\` from ${from} to ${to}\n- [Commits](https://github.com/o/${name}/compare/v${from}...v${to})`

  test('lists every update ahead of the notes', async () => {
    const posted = await comment({
      messages: [`${update('a', '1.0.0', '2.0.0')}\n\n${update('b', '1.0.0', '1.0.1')}`],
      routes: {
        ...releasesRoute('o/a', [release('v2.0.0', 'notes'), release('v1.0.0', 'old')]),
        ...releasesRoute('o/b', []),
        ...compareRoute('o/b', 'v1.0.0', 'v1.0.1', [upstreamCommit('work')]),
      },
    })

    assert.match(posted, /\| `a` \| `1\.0\.0` → `2\.0\.0` \| \*\*major\*\* \| 1 release \|/)
    assert.match(posted, /\| `b` \| `1\.0\.0` → `1\.0\.1` \| patch \| Commits \|/)
    assert.ok(posted.indexOf('| Package') < posted.indexOf('<details>'))
  })

  test('is left out for a single update', async () => {
    const posted = await comment({
      messages: [update('a', '1.0.0', '1.1.0')],
      routes: releasesRoute('o/a', [release('v1.1.0', 'notes'), release('v1.0.0', 'old')]),
    })

    assert.match(posted, /notes/)
    assert.doesNotMatch(posted, /\| Package/)
  })

  for (const [from, to, kind] of [
    ['1.0.0', '2.0.0', '**major**'],
    ['1.0.0', '1.1.0', 'minor'],
    ['1.0.0', '1.0.1', 'patch'],
    ['abcdef1', 'abcdef2', 'commit'],
    ['0.0.0-1-abc', '0.0.0-2-abc', '—'],
  ]) {
    test(`${from} to ${to} is ${kind}`, () => assert.equal(bumpKind({ from, to }), kind))
  }
})

describe('indirect requirements', () => {
  const files = [
    {
      filename: 'go.mod',
      patch: [
        '-\tgithub.com/o/deep v1.0.0 // indirect',
        '+\tgithub.com/o/deep v1.1.0 // indirect',
        '-\tgithub.com/o/top v1.0.0',
        '+\tgithub.com/o/top v1.1.0',
      ].join('\n'),
    },
  ]
  const link = (name) =>
    `Updates \`github.com/o/${name}\` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/${name}/compare/v1.0.0...v1.1.0)`

  test('are marked, and follow the direct ones', async () => {
    const posted = await comment({
      messages: [`${link('deep')}\n\n${link('top')}`],
      files,
      routes: {
        ...releasesRoute('o/deep', [
          release('v1.1.0', 'deep notes', { html_url: 'https://example.test/deep' }),
          release('v1.0.0', 'old'),
        ]),
        ...releasesRoute('o/top', [
          release('v1.1.0', 'top notes', { html_url: 'https://example.test/top' }),
          release('v1.0.0', 'old'),
        ]),
      },
    })

    assert.match(posted, /<code>github\.com\/o\/deep<\/code> — 1\.0\.0 → 1\.1\.0 \(indirect\)/)
    assert.doesNotMatch(posted, /o\/top<\/code> — 1\.0\.0 → 1\.1\.0 \(indirect\)/)
    assert.ok(posted.indexOf('top notes') < posted.indexOf('deep notes'))
    assert.match(posted, /\| `github\.com\/o\/deep` .*\| indirect \|/)
  })
})

describe('only-when-truncated', () => {
  const message = 'Updates `a` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/a/compare/v1.0.0...v1.1.0)'
  const env = { ONLY_WHEN_TRUNCATED: 'true' }
  const routes = releasesRoute('o/a', [release('v1.1.0', 'notes'), release('v1.0.0', 'old')])

  test('posts nothing for a description that fits, and asks for nothing', async () => {
    const run = await runAction({ messages: [message], env, routes: { ...routes, ...pullWith('Short') } })

    assert.equal(run.code, 0)
    assert.deepEqual(run.posted, [])
    assert.ok(!run.requests.some((request) => request.url.includes('/releases')))
  })

  test('takes back what it posted when the description fits again', async () => {
    const run = await runAction({
      messages: [message],
      env,
      comments: [{ id: 3, body: `${MARKER}\nOld` }],
      routes: { ...routes, ...pullWith('Short') },
    })

    assert.deepEqual(run.deleted, [3])
  })

  test('posts for a truncated description', async () => {
    const run = await runAction({
      messages: [message],
      env,
      routes: { ...routes, ...pullWith('Long...\n\n_Description has been truncated_') },
    })

    assert.match(run.posted[0], /notes/)
  })
})

describe('commits pushed on top', () => {
  const human = {
    author: { login: 'someone' },
    commit: {
      message: 'Updates `evil` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/evil/evil/compare/v1.0.0...v1.1.0)',
    },
  }
  const routes = { [`GET ${API}/pulls/${PULL_REQUEST}/commits?per_page=100&page=1`]: ok([human]) }

  test('are not read', async () => {
    const run = await runAction({ routes })

    assert.deepEqual(run.posted, [])
    assert.ok(!run.requests.some((request) => request.url.includes('/evil/')))
  })

  for (const [what, fields] of [
    ['an author spoofed with Dependabot\'s address', { committer: { login: 'someone' } }],
    ['an unsigned commit', { commit: { verification: { verified: false } } }],
  ]) {
    test(`are not read from ${what}`, async () => {
      const run = await runAction({
        routes: {
          [`GET ${API}/pulls/${PULL_REQUEST}/commits?per_page=100&page=1`]: ok([
            dependabotCommit(human.commit.message, fields),
          ]),
        },
      })

      assert.deepEqual(run.posted, [])
      assert.ok(!run.requests.some((request) => request.url.includes('/evil/')))
    })
  }

  test('are read with any-author', async () => {
    const run = await runAction({
      env: { ANY_AUTHOR: 'true' },
      routes: { ...routes, ...releasesRoute('evil/evil', [release('v1.1.0', 'x'), release('v1.0.0', 'y')]) },
    })

    assert.equal(run.posted.length, 1)
  })
})

describe('a headline above a block of the same name', () => {
  const message = 'Bumps gradle in `/gradle` from 9.7.1 to 9.8.1.\n\nUpdates `gradle` from 9.7.1 to 9.8.1\n\n---\n'

  test('stays', () => {
    assert.deepEqual(parseUpdates(message).map((update) => update.name), ['gradle'])
  })

  test('is reported as an update without notes, and without a warning', async () => {
    const run = await runAction({ messages: [message], files: [{ filename: 'gradle/Dockerfile' }] })

    assert.match(run.stdout, /gradle 9\.7\.1 → 9\.8\.1/)
    assert.doesNotMatch(run.stderr, /format may be unknown/)
  })
})

describe('rate limits', () => {
  const message = 'Updates `a` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/a/compare/v1.0.0...v1.1.0)'
  const releases = 'GET https://api.github.com/repos/o/a/releases?per_page=100&page=1'
  const limited = (headers) => ({ status: 429, headers, body: { message: 'slow down' } })
  const asked = async (headers) => {
    const run = await runAction({ messages: [message], routes: { [releases]: limited(headers) } })

    return run.requests.filter((request) => request.url.includes('/o/a/releases')).length
  }

  test('that lift in time are waited out', async () => {
    assert.equal(await asked({ 'retry-after': '0' }), 3)
  })

  test('that lift too late are not', async () => {
    assert.equal(await asked({ 'retry-after': '3600' }), 1)
    assert.equal(
      await asked({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': `${Math.floor(Date.now() / 1000) + 3600}` }),
      1,
    )
  })
})

describe('warnings', () => {
  const message = 'Updates `a` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/a/compare/v1.0.0...v1.1.0)'
  const routes = {
    'GET https://api.github.com/repos/o/a/releases?per_page=100&page=1': {
      status: 403,
      text: 'no\n::error::100%',
    },
    'GET https://api.github.com/repos/o/a/compare/v1.0.0...v1.1.0': notFound,
  }

  test('become annotations on a runner, and cannot run a workflow command', async () => {
    const run = await runAction({ messages: [message], routes, env: { GITHUB_ACTIONS: 'true' } })

    assert.match(run.stderr, /^::warning::a: GET .*no%0A::error::100%25$/m)
    assert.doesNotMatch(run.stderr, /^::error::/m)
  })

  test('stay plain elsewhere', async () => {
    const run = await runAction({ messages: [message], routes })

    assert.doesNotMatch(run.stderr, /::warning::/)
  })

  test('speak up when a pull request changes files but names no update', async () => {
    const run = await runAction({ messages: ['Something new'], files: [{ filename: 'x.lock' }] })

    assert.equal(run.code, 0)
    assert.match(run.stderr, /changes 1 file\(s\), so its format may be unknown/)
  })
})

describe('dependencies without notes', () => {
  const notes = 'Updates `a` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/a/compare/v1.0.0...v1.1.0)'
  const empty = 'Updates `b` from 1.0.0 to 1.1.0\n- [Changelog](https://example.test/changes)'
  const routes = releasesRoute('o/a', [release('v1.1.0', 'a notes'), release('v1.0.0', 'old')])

  test('get a row with their links and no section', async () => {
    const posted = await comment({ messages: [`${notes}\n\n${empty}`], routes })

    assert.match(posted, /\| `b` .*\| None · \[Changelog]\(https:\/\/example\.test\/changes\) \|/)
    assert.equal(count(posted, '<details>'), 1)
    assert.doesNotMatch(posted, /<code>b<\/code>/)
  })

  test('alone leave nothing to post, and take back what was posted', async () => {
    const run = await runAction({ messages: [empty], comments: [{ id: 4, body: `${MARKER}\nOld` }] })

    assert.deepEqual(run.posted, [])
    assert.deepEqual(run.deleted, [4])
    assert.match(run.stdout, /No notes found, nothing to post\. Updates: b 1\.0\.0 → 1\.1\.0/)
  })
})

describe('an action pinned to a commit hash', () => {
  const [base, head] = ['f06c13b6b1a9625abc9e6e439d9c05a8f2190e94', 'a4f02ab5355a589de60d917a659ce617ed19b3d0']
  const message =
    'Bumps [o/action](https://github.com/o/action) from 7.2.3 to 7.3.0.\n' +
    `- [Commits](https://github.com/o/action/compare/${base}...${head})`

  test('gets the releases of the versions it names', async () => {
    const posted = await comment({
      messages: [message],
      routes: releasesRoute('o/action', [release('v7.3.0', 'the notes'), release('v7.2.3', 'old')]),
    })

    assert.deepEqual(heads(posted), ['v7.3.0'])
  })

  test('gets the commits of its hashes when there are no releases', async () => {
    const posted = await comment({
      messages: [message],
      routes: {
        ...releasesRoute('o/action', []),
        ...compareRoute('o/action', base, head, [upstreamCommit('work')]),
      },
    })

    assert.match(posted, /work/)
  })

  test('that names only hashes reads no releases', async () => {
    const run = await runAction({
      messages: [
        `Bumps [o/action](https://github.com/o/action) from ${base} to ${head}.\n- [Commits](https://github.com/o/action/compare/${base}...${head})`,
      ],
      routes: compareRoute('o/action', base, head, [upstreamCommit('work')]),
    })

    assert.equal(run.code, 0, run.stderr)
    assert.ok(!run.requests.some((request) => request.url.includes('/releases')))
  })
})

describe('a changelog nobody linked', () => {
  const file = (text) => ({ status: 200, body: { encoding: 'base64', content: Buffer.from(text).toString('base64') } })
  const changes = '# v1.1.0 (2026-01-01)\n\n* a fix\n\n# v1.0.0 (2025-01-01)\n\n* old\n'

  test('is found beside a module its tag names', async () => {
    const name = 'github.com/o/sdk/service/sts'
    const posted = await comment({
      messages: [
        `Updates \`${name}\` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/sdk/compare/service/sts/v1.0.0...service/sts/v1.1.0)`,
      ],
      routes: {
        ...releasesRoute('o/sdk', []),
        'GET https://api.github.com/repos/o/sdk/contents/service/sts/CHANGELOG.md?ref=service%2Fsts%2Fv1.1.0': file(changes),
      },
    })

    assert.match(posted, /a fix/)
    assert.doesNotMatch(posted, /old/)
    assert.match(posted, /\[Changelog]\(https:\/\/github\.com\/o\/sdk\/blob\/service\/sts\/v1\.1\.0\/service\/sts\/CHANGELOG\.md\)/)
  })

  test('is found beside a package its commits link names', async () => {
    const posted = await comment({
      messages: ['Updates `p` from 1.0.0 to 1.1.0\n- [Commits](https://github.com/o/m/commits/v1.1.0/packages/p)'],
      routes: {
        ...releasesRoute('o/m', []),
        'GET https://api.github.com/repos/o/m/contents/packages/p/CHANGELOG.md?ref=v1.1.0': file(changes),
      },
    })

    assert.match(posted, /a fix/)
  })

  test('is not looked for when one is linked', async () => {
    const run = await runAction({
      messages: [
        'Updates `p` from 1.0.0 to 1.1.0\n- [Changelog](https://example.test/changes)\n- [Commits](https://github.com/o/p/compare/v1.0.0...v1.1.0)',
      ],
      routes: {
        ...releasesRoute('o/p', []),
        ...compareRoute('o/p', 'v1.0.0', 'v1.1.0', [upstreamCommit('work')]),
      },
    })

    assert.ok(!run.requests.some((request) => request.url.includes('CHANGELOG')))
  })
})

describe('the Go project mirrors', () => {
  const origin = (name, tag) => ({ URL: `https://go.googlesource.com/${name}`, Ref: `refs/tags/${tag}` })
  const go = (module, repo) => ({
    files: [goModFile([[module, 'v1.0.0', 'v1.1.0']])],
    routes: {
      ...proxyRoute(module, 'v1.0.0', origin(repo, 'v1.0.0')),
      ...proxyRoute(module, 'v1.1.0', origin(repo, 'v1.1.0')),
    },
  })

  test('send protobuf to its own repository', async () => {
    const { files, routes } = go('google.golang.org/protobuf', 'protobuf')
    const posted = await comment({
      files,
      routes: {
        ...routes,
        ...releasesRoute('protocolbuffers/protobuf-go', [release('v1.1.0', 'pb notes'), release('v1.0.0', 'old')]),
      },
    })

    assert.match(posted, /pb notes/)
  })

  test('send the rest to github.com/golang', async () => {
    const { files, routes } = go('golang.org/x/net', 'net')
    const posted = await comment({
      files,
      routes: {
        ...routes,
        ...releasesRoute('golang/net', []),
        ...compareRoute('golang/net', 'v1.0.0', 'v1.1.0', [upstreamCommit('net work')]),
      },
    })

    assert.match(posted, /net work/)
  })
})
