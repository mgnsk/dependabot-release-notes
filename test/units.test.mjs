import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { closeOpenMarkup } from '../lib/render.mjs'
import {
  compareVersions,
  isCommitHash,
  parseVersion,
  projectFromLink,
  tagFromCommitsLink,
} from '../lib/tags.mjs'

const order = (left, right) => compareVersions(parseVersion(left, ''), parseVersion(right, ''))

describe('versions', () => {
  for (const [lower, higher] of [
    ['2.0.0rc9', '2.0.0rc10'],
    ['1.0.0-beta.2', '1.0.0-beta.10'],
    ['1.0.0-alpha', '1.0.0-beta'],
    ['1.0.0-rc.1', '1.0.0'],
  ]) {
    test(`${lower} sorts before ${higher}`, () => {
      assert.ok(order(lower, higher) < 0)
      assert.ok(order(higher, lower) > 0)
    })
  }
})

describe('commit hashes', () => {
  for (const ref of ['4aaaaaa', 'abcdef1234', 'a'.repeat(40)]) {
    test(`${ref} is one`, () => assert.ok(isCommitHash(ref)))
  }
  for (const ref of ['v1.2.3', '1.2.3', '20240101', '1234567', 'abc']) {
    test(`${ref} is not`, () => assert.ok(!isCommitHash(ref)))
  }
})

describe('project links', () => {
  for (const [url, project] of [
    ['https://github.com/babel/babel/tree/HEAD/packages/babel-core', 'babel/babel'],
    ['https://github.com/babel/babel/releases', 'babel/babel'],
    ['https://github.com/babel/babel/blob/main/CHANGELOG.md', 'babel/babel'],
    ['https://github.com/foo/bar.git', 'foo/bar'],
    ['https://github.com/foo/bar#readme', 'foo/bar'],
    ['https://gitlab.com/a/b/c/-/tree/main', 'a/b/c'],
  ]) {
    test(`${url} is ${project}`, () => assert.equal(projectFromLink(url).project, project))
  }

  test('of another host are ignored', () => {
    assert.equal(projectFromLink('https://example.test/a/b'), null)
  })
})

describe('commits links', () => {
  for (const [path, version, tag] of [
    ['commits/v7.25.0/packages/core', '7.25.0', 'v7.25.0'],
    ['commits/@sveltejs/kit@3.1.0/packages/kit', '3.1.0', '@sveltejs/kit@3.1.0'],
    ['commits/%40sveltejs/kit%403.1.0/packages/kit', '3.1.0', '@sveltejs/kit@3.1.0'],
    ['commits/HEAD/types/node', '22.0.0', null],
    ['commits/v11.25.0/packages/core', '1.25.0', null],
  ]) {
    test(`${path} gives ${tag}`, () => {
      assert.equal(tagFromCommitsLink(`https://github.com/o/r/${path}`, version), tag)
    })
  }
})

describe('an open code fence', () => {
  for (const [what, text, closed] of [
    ['at the margin', '```js\ncode', '```js\ncode\n```'],
    ['in a list item', '- item\n\n  ```js\n  code', '- item\n\n  ```js\n  code\n  ```'],
    ['on a list marker', '1. ```js\n   code', '1. ```js\n   code\n   ```'],
    ['in a nested list item', '- a\n  - b\n\n    ~~~\n    code', '- a\n  - b\n\n    ~~~\n    code\n    ~~~'],
    ['back in the outer item', '- a\n  - b\n\n  ```\n  code', '- a\n  - b\n\n  ```\n  code\n  ```'],
    ['indented with a tab', '- item\n\n\t```\n\tcode', '- item\n\n\t```\n\tcode\n  ```'],
  ]) {
    test(`is closed ${what}`, () => {
      assert.equal(closeOpenMarkup(text), closed)
    })
  }

  for (const [what, text] of [
    ['a closed fence in a list item', '- item\n\n  ```\n  code\n  ```'],
    ['a fence its list item ended', '- item\n\n  ```\n  code\nafter'],
    ['inline code that fills a line', '```x```'],
    ['a fence too deep to be one', '    ```\n    code'],
  ]) {
    test(`is not read from ${what}`, () => {
      assert.equal(closeOpenMarkup(text), text)
    })
  }

  test('after a list item it ended is still found', () => {
    assert.equal(closeOpenMarkup('- item\n\n  ```\n  code\n```\nmore'), '- item\n\n  ```\n  code\n```\nmore\n```')
  })
})

describe('open HTML', () => {
  test('is closed innermost first', () => {
    assert.equal(closeOpenMarkup('<div><pre>x'), '<div><pre>x\n</pre></div>')
  })

  test('is not read from code', () => {
    assert.equal(closeOpenMarkup('`<pre>` x'), '`<pre>` x')
  })

  test('that was closed is left alone', () => {
    assert.equal(closeOpenMarkup('<table>x</table>'), '<table>x</table>')
  })
})
