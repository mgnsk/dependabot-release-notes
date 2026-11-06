// HTTP with retries, and what a run has learned about failures along the way.

const REQUEST_TIMEOUT = 30_000

// How many times to ask before a read counts as failed. A write is never
// repeated, since one that timed out may still have gone through.
const READ_ATTEMPTS = 3

// How long a rate limited answer that names no time is waited out: the minute
// GitHub asks for of its secondary limit.
const UNSAID_RATE_LIMIT_WAIT = 60_000

// On a runner a warning becomes an annotation of the run, which someone may see. A
// message may quote an answer from elsewhere, and must not run a workflow command.
function warn(message) {
  const annotation = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

  console.warn(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${annotation}` : message)
}

// How long a rate limited answer asks to wait, or null for any other answer. GitHub's
// secondary limit gives the seconds and its primary one the moment the allowance comes
// back. A secondary limit may say neither, only its message.
function rateLimitWait(response, text) {
  if (response.status !== 429 && response.status !== 403) {
    return null
  }

  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null) {
    return /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : UNSAID_RATE_LIMIT_WAIT
  }

  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = response.headers.get('x-ratelimit-reset')

    return /^\d+$/.test(reset ?? '')
      ? Math.max(Number(reset) * 1_000 - Date.now(), 0)
      : UNSAID_RATE_LIMIT_WAIT
  }

  return response.status === 429 || /rate limit/i.test(text ?? '') ? UNSAID_RATE_LIMIT_WAIT : null
}

// A tag spelled for a URL path, where its "/" and "@" may stay as they are.
function pathRef(ref) {
  return encodeURIComponent(ref).replaceAll('%2F', '/').replaceAll('%40', '@')
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

// The HTTP of one run. It also keeps what the run has learned about failures: one
// dependency that cannot be read must not cost the others their notes. A failure
// that a later run would not repeat is worth failing for, at the end, since the notes
// are then incomplete for no reason of the dependency's own. A project the token may
// not read is no such failure: it would fail every run.
function createClient({
  token,
  retryDelay = 1_000,
  rateLimitWait: maximumWait = 60_000,
  fetch = (...args) => globalThis.fetch(...args),
}) {
  const failures = { rateLimited: false, unavailable: false }

  async function request(url, init = {}) {
    const { raw, ...options } = init
    const method = options.method ?? 'GET'
    const attempts = method === 'GET' ? READ_ATTEMPTS : 1

    for (let attempt = 1; ; attempt++) {
      let response
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT), ...options })
      } catch (error) {
        if (attempt < attempts) {
          await sleep(attempt * retryDelay)
          continue
        }

        throw Object.assign(new Error(`${method} ${url}: ${error.message}`), { transient: true })
      }

      if (response.status >= 500 && attempt < attempts) {
        await sleep(attempt * retryDelay)
        continue
      }

      // A refusal says in its body whether it is a rate limit.
      const text = response.ok ? null : await response.text()
      const wait = rateLimitWait(response, text)
      if (wait !== null && wait <= maximumWait && attempt < attempts) {
        await sleep(wait)
        continue
      }

      // Nothing there is an answer to a read or a delete. A write that finds
      // nothing has not done what it was asked.
      if (response.status === 404 && (method === 'GET' || method === 'DELETE')) {
        return null
      }

      if (!response.ok) {
        const error = new Error(`${method} ${url}: ${response.status} ${text}`)
        error.rateLimited = wait !== null
        error.transient = error.rateLimited || response.status >= 500

        throw error
      }

      if (response.status === 204) {
        return null
      }

      return raw ? response.text() : response.json()
    }
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

  function recordFailure(error) {
    failures.rateLimited ||= Boolean(error.rateLimited)
    failures.unavailable ||= Boolean(error.transient)
  }

  // A lookup whose failure costs only its own result, which is then `nothing`. Once
  // rate limited, the other lookups would only fail too and dig the hole deeper.
  async function orNothing(what, lookup, nothing = null) {
    if (failures.rateLimited) {
      return nothing
    }

    try {
      return await lookup()
    } catch (error) {
      warn(`${what}: ${error.message}`)
      recordFailure(error)

      return nothing
    }
  }

  return {
    api,
    listAll,
    orNothing,
    request,
    get rateLimited() {
      return failures.rateLimited
    },
    get unavailable() {
      return failures.unavailable
    },
  }
}

export {
  createClient,
  pathRef,
  warn,
}
