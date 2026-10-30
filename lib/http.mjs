// HTTP with retries, and what the run has learned about failures along the way.

const REQUEST_TIMEOUT = 30_000

// How many times to ask before a read counts as failed. A write is never
// repeated, since one that timed out may still have gone through.
const READ_ATTEMPTS = 3

const RETRY_DELAY = Number(process.env.RETRY_DELAY_MS ?? 1_000)

// How long to wait for a rate limit to lift, rather than fail the run. A limit that
// lifts later than this is left to a later run.
const RATE_LIMIT_WAIT = Number(process.env.RATE_LIMIT_WAIT_MS ?? 60_000)

// An action reads its inputs from INPUT_*, and a local run from the names below.
const token = process.env.INPUT_TOKEN || process.env.GITHUB_TOKEN

const repository = process.env.GITHUB_REPOSITORY

// On a runner a warning becomes an annotation of the run, which someone may see. A
// message may quote an answer from elsewhere, and must not run a workflow command.
function warn(message) {
  const annotation = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

  console.warn(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${annotation}` : message)
}

async function request(url, init = {}) {
  const method = init.method ?? 'GET'
  const attempts = method === 'GET' ? READ_ATTEMPTS : 1

  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT), ...init })
    } catch (error) {
      if (attempt < attempts) {
        await pause(attempt)
        continue
      }

      throw Object.assign(new Error(`${method} ${url}: ${error.message}`), { transient: true })
    }

    if (response.status >= 500 && attempt < attempts) {
      await pause(attempt)
      continue
    }

    const wait = rateLimitWait(response)
    if (wait !== null && wait <= RATE_LIMIT_WAIT && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, wait))
      continue
    }

    // Nothing there is an answer to a read or a delete. A write that finds
    // nothing has not done what it was asked.
    if (response.status === 404 && (method === 'GET' || method === 'DELETE')) {
      return null
    }

    if (!response.ok) {
      const error = new Error(`${method} ${url}: ${response.status} ${await response.text()}`)
      error.rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0'))
      error.transient = error.rateLimited || response.status >= 500

      throw error
    }

    if (response.status === 204) {
      return null
    }

    return init.raw ? response.text() : response.json()
  }
}

// How long a rate limited answer asks to wait, if it says. GitHub's secondary limit
// gives the seconds and its primary one the moment the allowance comes back.
function rateLimitWait(response) {
  if (response.status !== 429 && response.status !== 403) {
    return null
  }

  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
    return Number(retryAfter) * 1_000
  }

  const reset = response.headers.get('x-ratelimit-reset')
  if (response.headers.get('x-ratelimit-remaining') === '0' && /^\d+$/.test(reset ?? '')) {
    return Math.max(Number(reset) * 1_000 - Date.now(), 0)
  }

  return null
}

function pause(attempt) {
  return new Promise((resolve) => setTimeout(resolve, attempt * RETRY_DELAY))
}

// One dependency that cannot be read must not cost the others their notes. A
// failure that a later run would not repeat is worth failing for, at the end,
// since the notes are then incomplete for no reason of the dependency's own. A
// project the token may not read is no such failure: it would fail every run.
let rateLimited = false

let unavailable = false

function recordFailure(error) {
  rateLimited ||= Boolean(error.rateLimited)
  unavailable ||= Boolean(error.transient)
}

// The token authenticates every GitHub call, including the public ones: reading
// two dozen projects' releases unauthenticated would exhaust the sixty requests
// an hour that GitHub grants an anonymous caller. It goes to GitHub and nowhere
// else — another forge must never see it.
function api(path, init = {}) {
  return request(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  })
}

// A tag spelled for a URL path, where its "/" and "@" may stay as they are.
function pathRef(ref) {
  return encodeURIComponent(ref).replaceAll('%2F', '/').replaceAll('%40', '@')
}

async function listAll(path) {
  const items = []

  for (let page = 1; ; page++) {
    const batch = await api(`${path}?per_page=100&page=${page}`)
    // Only a pull request that cannot be read gets here with a 404: a wrong
    // number, or a token without access to the repository. Neither is empty.
    if (!batch) {
      throw new Error(`GET ${path}: 404, check the pull request number and the token's access`)
    }

    items.push(...batch)

    if (batch.length < 100) {
      return items
    }
  }
}

export {
  api,
  listAll,
  pathRef,
  rateLimited,
  recordFailure,
  repository,
  request,
  token,
  unavailable,
  warn,
}
