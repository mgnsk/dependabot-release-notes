// Preloaded into the action's process in place of the network. Answers from a
// route table and logs every request for the test to read back. A request no
// route covers gets a 599 and is logged as such, so that the harness can fail a
// test on it even where the action swallows the error.

import { appendFileSync, readFileSync } from 'node:fs'

const routes = JSON.parse(readFileSync(process.env.FAKE_FETCH_ROUTES, 'utf8'))
const log = process.env.FAKE_FETCH_LOG

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'
  const route = routes[`${method} ${url}`] ?? {
    status: 599,
    body: { message: `No route for ${method} ${url}` },
  }

  appendFileSync(
    log,
    `${JSON.stringify({
      method,
      url,
      headers: init.headers ?? {},
      body: init.body ?? null,
      status: route.status,
    })}\n`,
  )

  // A route with text answers with a file as it is, rather than with JSON.
  return new Response(route.status === 204 ? null : (route.text ?? JSON.stringify(route.body)), {
    status: route.status,
    headers: route.headers,
  })
}
