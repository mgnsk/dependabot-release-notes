import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createClient } from '../lib/http.mjs'

// A client whose network answers every request with the same response.
function clientAnswering(status, body, headers = {}) {
  const requests = []
  const client = createClient({
    token: 't',
    retryDelay: 0,
    rateLimitWait: 0,
    fetch: async (url, init) => {
      requests.push({ url, init })

      return new Response(JSON.stringify(body), { status, headers })
    },
  })

  return { client, requests }
}

describe('a client', () => {
  test('starts with no failures of another run', async () => {
    const first = clientAnswering(429, {})
    await first.client.orNothing('x', () => first.client.api('/x'))

    assert.equal(first.client.rateLimited, true)
    assert.equal(clientAnswering(200, {}).client.rateLimited, false)
  })

  test('takes a 403 its message calls a rate limit for one', async () => {
    const { client } = clientAnswering(403, { message: 'You have exceeded a secondary rate limit.' })
    await client.orNothing('x', () => client.api('/x'))

    assert.equal(client.rateLimited, true)
    assert.equal(client.unavailable, true)
  })

  test('takes any other 403 for a lasting refusal', async () => {
    const { client } = clientAnswering(403, { message: 'Resource not accessible by integration' })
    await client.orNothing('x', () => client.api('/x'))

    assert.equal(client.rateLimited, false)
    assert.equal(client.unavailable, false)
  })

  test('stops asking once rate limited', async () => {
    const { client, requests } = clientAnswering(429, {})
    await client.orNothing('x', () => client.api('/x'))
    const before = requests.length

    assert.equal(await client.orNothing('y', () => client.api('/y'), 'nothing'), 'nothing')
    assert.equal(requests.length, before)
  })

  test('sends the token to GitHub alone', async () => {
    const { client, requests } = clientAnswering(200, {})
    await client.api('/x')
    await client.request('https://gitlab.com/api/v4/x')

    assert.equal(requests[0].init.headers.authorization, 'Bearer t')
    assert.equal(requests[1].init.headers, undefined)
  })
})
