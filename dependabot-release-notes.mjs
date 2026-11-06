#!/usr/bin/env node

// Posts the release notes for a Dependabot pull request as pull request
// comments, split across several comments when they do not fit in one.
//
// Dependabot writes the notes into the pull request description, which GitHub
// caps at 65,536 characters. A grouped update across many directories repeats
// every dependency's notes once per directory, so the description is truncated
// long before it reaches the last directories and most dependencies end up with
// no notes at all. The commit message carries the same list without the expanded
// notes, so far more of it survives, and that is where the dependencies are read
// from. It is capped at 65,536 characters as well, and a large enough update
// truncates it too, so the summary tables Dependabot writes first fill in
// whatever the truncation cut off.
//
// A Go update is read from the go.mod changes in the pull request's diff
// instead. The commit messages name only what Dependabot bumped, while the diff
// holds every requirement the branch moves, the indirect ones included, and the
// ones a go mod tidy pushed on top of the bump. The messages then only supply
// the links Dependabot wrote, and the module proxy supplies the rest.
//
// Usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
//          node dependabot-release-notes.mjs [--dry-run]

import { randomUUID } from 'node:crypto'

import { configError, readConfig } from './lib/config.mjs'
import { createForges } from './lib/forges.mjs'
import { completeGoLinks, mergeRequirements } from './lib/go.mjs'
import { createClient, warn } from './lib/http.mjs'
import { createNotes } from './lib/notes.mjs'
import { MARKER, hasNotes, intoComments, renderDependency, renderOverview } from './lib/render.mjs'
import { parseUpdates } from './lib/updates.mjs'

const DEPENDABOT = 'dependabot[bot]'

// Anyone can write Dependabot's address into a commit, which GitHub then lists as
// Dependabot's. Only GitHub can sign a commit as itself, which it does for Dependabot's.
function isDependabots(commit) {
  return (
    commit.author?.login === DEPENDABOT &&
    commit.committer?.login === 'web-flow' &&
    commit.commit?.verification?.verified === true
  )
}

// The action runs with a write token, and a pull request's commit messages and
// description decide what it asks for and quotes, so they have to be Dependabot's.
// A commit pushed on top of Dependabot's has no say.
async function readPullRequest({ api }, { repository, pullRequest }) {
  const path = `/repos/${repository}/pulls/${pullRequest}`
  const pull = await api(path)
  if (!pull) {
    throw new Error(`GET ${path}: 404, check the pull request number and the token's access`)
  }

  if (pull.user?.login !== DEPENDABOT) {
    throw new Error(`Pull request ${pullRequest} was opened by ${pull.user?.login}, not ${DEPENDABOT}.`)
  }

  return pull
}

// On a runner a line of output that reads ::name:: is a workflow command, and the
// notes are someone else's words. Commands stay off until a token they cannot guess.
function printQuoted(text, onRunner) {
  if (!onRunner) {
    console.log(`\n${text}`)

    return
  }

  const resume = randomUUID()
  console.log(`::stop-commands::${resume}\n${text}\n::${resume}::`)
}

// Every push to the pull request runs this again. Edit the comments already
// posted rather than replace them, so that they keep their place in the
// timeline and the replies and reactions they collected. A comment whose notes
// are unchanged is left alone, and only a part the notes no longer need goes,
// which is all of them once a push leaves nothing to report.
async function publish(client, config, comments) {
  const { repository, pullRequest, author, dryRun, onRunner } = config
  if (dryRun) {
    if (comments.length > 0) {
      printQuoted(comments.join('\n\n========================================\n\n'), onRunner)
    }

    return
  }

  // Anyone can write the marker into a comment, and those are not ours to edit.
  const previous = (await client.listAll(`/repos/${repository}/issues/${pullRequest}/comments`)).filter(
    (comment) => comment.user?.login === author && comment.body?.startsWith(MARKER),
  )

  // Notes that an outage left out are no reason to take back the ones already up.
  if (client.unavailable && previous.length > 0) {
    console.error('Keeping the comments already posted.')

    return
  }

  for (const [index, body] of comments.entries()) {
    const comment = previous[index]

    if (!comment) {
      await client.api(`/repos/${repository}/issues/${pullRequest}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
    } else if (comment.body !== body) {
      await client.api(`/repos/${repository}/issues/comments/${comment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      })
    }
  }

  for (const comment of previous.slice(comments.length)) {
    await client.api(`/repos/${repository}/issues/comments/${comment.id}`, { method: 'DELETE' })
  }
}

function report(updates, files, comments) {
  if (updates.length === 0) {
    const nothing = 'No dependency updates found in the diff or the commit messages, nothing to post.'
    console.log(nothing)
    if (files.length > 0) {
      warn(`${nothing} The pull request changes ${files.length} file(s), so its format may be unknown.`)
    }
  } else if (comments.length === 0) {
    const moved = updates.map(({ name, from, to }) => `${name} ${from} → ${to}`)
    console.log(`No notes found, nothing to post. Updates: ${moved.join(', ')}`)
  } else {
    console.log(
      `${updates.length} ${updates.length === 1 ? 'update' : 'updates'}, ` +
        `${comments.length} comment(s): ` +
        comments.map((comment) => `${comment.length} chars`).join(', '),
    )
  }
}

// Every update the pull request makes, from its commits, its description and its diff.
async function readUpdates(client, config, pull) {
  const { repository, pullRequest } = config
  const commits = await client.listAll(`/repos/${repository}/pulls/${pullRequest}/commits`)
  const trusted = commits.filter(isDependabots)
  const files = await client.listAll(`/repos/${repository}/pulls/${pullRequest}/files`)

  const announced = parseUpdates(trusted.map((commit) => commit.commit.message).join('\n'), pull.body ?? '')
  const { goUpdates, others } = mergeRequirements(files, announced)
  const updates = [...(await completeGoLinks(client, goUpdates)), ...others]

  return { updates, files }
}

async function main() {
  const config = readConfig()
  const error = configError(config)
  if (error) {
    console.error(error)
    process.exit(1)
  }

  const client = createClient(config)
  const pull = await readPullRequest(client, config)

  const { updates, files } = await readUpdates(client, config, pull)
  const { collectEntries } = createNotes({ client, forges: createForges(client) })
  const entries = await collectEntries(
    updates.toSorted((left, right) => Number(Boolean(left.indirect)) - Number(Boolean(right.indirect))),
  )

  // With no notes for anything there is nothing to add to what Dependabot wrote.
  const withNotes = entries.filter(hasNotes)
  const overview = withNotes.length > 0 ? renderOverview(entries) : null
  const comments = intoComments([
    ...(overview ? [overview] : []),
    ...withNotes.map(renderDependency),
  ])

  report(updates, files, comments)

  if (client.rateLimited) {
    console.error('Rate limited: some notes are missing. Run the action again later.')
  } else if (client.unavailable) {
    console.error('Some notes could not be read. Run the action again later.')
  }
  if (client.unavailable) {
    process.exitCode = 1
  }

  await publish(client, config, comments)
}

await main()
