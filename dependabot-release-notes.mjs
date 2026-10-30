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
// A lockfile of npm, pnpm, Yarn, uv, Poetry, Cargo or Composer holds the same
// account of what moved, the transitive packages included, but GitHub leaves the patch out of a large one, so
// the file itself is compared between the two ends of the branch. A package only
// the lockfile names has no link to any notes, and is listed in the overview.
//
// Usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
//          node dependabot-release-notes.mjs [--dry-run]

import { completeGoLinks, mergeRequirements } from './lib/go.mjs'
import { api, listAll, rateLimited, repository, token, unavailable, warn } from './lib/http.mjs'
import { applyLockfileChanges, readLockfileChanges } from './lib/lockfiles.mjs'
import { collectEntries } from './lib/notes.mjs'
import { MARKER, hasNotes, intoComments, renderDependency, renderOverview } from './lib/render.mjs'
import { parseUpdates } from './lib/updates.mjs'

const pullRequest = process.env['INPUT_PULL-REQUEST'] || process.env.PR_NUMBER

const commentAuthor =
  process.env.INPUT_AUTHOR || process.env.COMMENT_AUTHOR || 'github-actions[bot]'

const anyAuthor = (process.env['INPUT_ANY-AUTHOR'] || process.env.ANY_AUTHOR) === 'true'

const onlyWhenTruncated =
  (process.env['INPUT_ONLY-WHEN-TRUNCATED'] || process.env.ONLY_WHEN_TRUNCATED) === 'true'

const dryRun = process.argv.includes('--dry-run')

const DEPENDABOT = 'dependabot[bot]'

// What Dependabot ends a description with when it did not fit.
const TRUNCATED_DESCRIPTION = '_Description has been truncated_'

async function previousComments() {
  const comments = await listAll(`/repos/${repository}/issues/${pullRequest}/comments`)

  // Anyone can write the marker into a comment, and those are not ours to edit.
  return comments.filter(
    (comment) => comment.user?.login === commentAuthor && comment.body?.startsWith(MARKER),
  )
}

// The action runs with a write token, and a pull request's commit messages and
// description decide what it asks for and quotes, so they have to be Dependabot's.
// A commit pushed on top of Dependabot's has no say, unless any-author is set.
async function readPullRequest() {
  const path = `/repos/${repository}/pulls/${pullRequest}`
  const pull = await api(path)
  if (!pull) {
    throw new Error(`GET ${path}: 404, check the pull request number and the token's access`)
  }

  if (pull.user?.login !== DEPENDABOT && !anyAuthor) {
    throw new Error(
      `Pull request ${pullRequest} was opened by ${pull.user?.login}, not ${DEPENDABOT}. ` +
        'Set any-author to run on it anyway.',
    )
  }

  return pull
}

// Every push to the pull request runs this again. Edit the comments already
// posted rather than replace them, so that they keep their place in the
// timeline and the replies and reactions they collected. A comment whose notes
// are unchanged is left alone, and only a part the notes no longer need goes,
// which is all of them once a push leaves nothing to report.
async function publish(comments) {
  if (dryRun) {
    if (comments.length > 0) {
      console.log(`\n${comments.join('\n\n========================================\n\n')}`)
    }

    return
  }

  const previous = await previousComments()

  // Notes that an outage left out are no reason to take back the ones already up.
  if (unavailable && previous.length > 0) {
    console.error('Keeping the comments already posted.')

    return
  }

  for (const [index, body] of comments.entries()) {
    const comment = previous[index]

    if (!comment) {
      await api(`/repos/${repository}/issues/${pullRequest}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
    } else if (comment.body !== body) {
      await api(`/repos/${repository}/issues/comments/${comment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      })
    }
  }

  for (const comment of previous.slice(comments.length)) {
    await api(`/repos/${repository}/issues/comments/${comment.id}`, { method: 'DELETE' })
  }
}

function report(updates, listed, files, comments) {
  if (updates.length === 0 && listed.length === 0) {
    const nothing = 'No dependency updates found in the diff or the commit messages, nothing to post.'
    console.log(nothing)
    if (files.length > 0) {
      warn(`${nothing} The pull request changes ${files.length} file(s), so its format may be unknown.`)
    }
  } else if (comments.length === 0) {
    const moved = [...updates, ...listed].map(({ name, from, to }) => `${name} ${from} → ${to}`)
    console.log(`No notes found, nothing to post. Updates: ${moved.join(', ')}`)
  } else {
    console.log(
      `${updates.length} ${updates.length === 1 ? 'update' : 'updates'}, ` +
        (listed.length > 0 ? `${listed.length} listed from lockfiles, ` : '') +
        `${comments.length} comment(s): ` +
        comments.map((comment) => `${comment.length} chars`).join(', '),
    )
  }
}

async function main() {
  if (!token || !repository || !pullRequest) {
    console.error('GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required')
    process.exit(1)
  }

  const pull = await readPullRequest()

  if (onlyWhenTruncated && !pull.body?.includes(TRUNCATED_DESCRIPTION)) {
    console.log('The description holds all of its notes, nothing to post.')
    await publish([])

    return
  }

  const commits = await listAll(`/repos/${repository}/pulls/${pullRequest}/commits`)
  const trusted = commits.filter((commit) => anyAuthor || commit.author?.login === DEPENDABOT)
  const announced = parseUpdates(
    trusted.map((commit) => commit.commit.message).join('\n'),
    pull.body ?? '',
  )
  const files = await listAll(`/repos/${repository}/pulls/${pullRequest}/files`)
  const listed = applyLockfileChanges(announced, await readLockfileChanges(files, trusted))
  const { updates, goUpdates } = mergeRequirements(files, announced)
  await completeGoLinks(goUpdates)

  const entries = await collectEntries(
    updates.toSorted((left, right) => Number(Boolean(left.indirect)) - Number(Boolean(right.indirect))),
  )

  // With no notes for anything there is nothing to add to what Dependabot wrote.
  const withNotes = entries.filter(hasNotes)
  const overview = withNotes.length > 0 ? renderOverview(entries, listed) : null
  const comments = intoComments([
    ...(overview ? [overview] : []),
    ...withNotes.map(renderDependency),
  ])

  report(updates, listed, files, comments)

  if (rateLimited) {
    console.error('Rate limited: some notes are missing. Run the action again later.')
  } else if (unavailable) {
    console.error('Some notes could not be read. Run the action again later.')
  }
  if (unavailable) {
    process.exitCode = 1
  }

  await publish(comments)
}

await main()
