// Turning notes into comments that GitHub can show safely.

import { documented } from './notes.mjs'
import { compareFor, isPinned, parseVersion } from './tags.mjs'

const MARKER = '<!-- dependabot-release-notes -->'

// GitHub rejects comments over 65,536 characters. Stay well below it: the
// budget is checked before a dependency is added, and the header is added after.
const COMMENT_BUDGET = 60_000

// Caps for a single release body and for one dependency's whole section, so
// that one project with an enormous changelog cannot fill a comment on its own.
const RELEASE_BODY_LIMIT = 4_000

const DEPENDENCY_LIMIT = 15_000

// How many commits to list for a project that publishes no releases.
const COMMIT_LIST_LIMIT = 20

// How many of the packages that share a section to name in it. The overview names
// them all, and a release of the AWS SDK moves hundreds.
const SHARED_LIST_LIMIT = 50

// A cap for the overview, so that it leaves room in the comment it opens.
const OVERVIEW_LIMIT = 20_000

// A fenced block, closed or running to the end of the text, or an inline span.
const CODE = /^ {0,3}(`{3,}|~{3,}).*$[\s\S]*?(?:^ {0,3}\1[`~]* *$|(?![\s\S]))|(?<!`)(`+)(?!`)[^\n]*?(?<!`)\2(?!`)/gm

function outsideCode(text, transform) {
  let result = ''
  let position = 0

  for (const code of text.matchAll(CODE)) {
    result += transform(text.slice(position, code.index)) + code[0]
    position = code.index + code[0].length
  }

  return result + transform(text.slice(position))
}

// A link to github.com cross-references just as a bare #123 does, adding an entry
// to the timeline of the issue it names. Dependabot sends them through the
// redirect host, which GitHub does not read as a reference.
function quietLink(url) {
  return url?.replace(/^(\]\()?https?:\/\/(?:www\.)?github\.com\//i, '$1https://redirect.github.com/')
}

// Release notes are written for their own repository: a bare @handle, #123 or
// GH-123 would notify people and link to unrelated issues once quoted here. Dependabot
// breaks them with a zero width space and so do we, but not where the text means
// something else: code, a link's address, or the "@" of pkg@1.2.3. An issue
// number stays a reference after a name, as in owner/repo#123, and a mention after
// any punctuation, as in see/@octocat.
function defuseReferences(text) {
  return outsideCode(text.replace(/\r\n/g, '\n'), (prose) =>
    prose.replace(
      /\]\([^)\s]+|https?:\/\/[^\s<>)\]]+|(?<![\w/.#@-])#(?=[\w-])|(?<!\w)@(?=[\w-])|#(?=\d)|(?<![\w/.#@-])gh(?=-\d)/gi,
      (match) => (/^(?:\]\(|http)/i.test(match) ? quietLink(match) : `${match}\u200b`),
    ),
  )
}

// A <details> in a release body would nest in or close the one around its section.
function stripDisclosures(text) {
  return outsideCode(text, (prose) => prose.replace(/<\/?(?:details|summary)\b[^>]*>/gi, ''))
}

// Tags GitHub renders that release notes have a use for. Any other is text that
// reads as a tag, as in "drop <object> and <iframe>", which GitHub may leave open
// over the other sections in the comment, so it stays text.
const KNOWN_TAGS = new Set(
  (
    'a abbr b blockquote br center code dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li ' +
    'ol p picture pre q s samp source span strike strong sub sup table tbody td tfoot th thead tr ' +
    'tt ul var video'
  ).split(' '),
)

function escapeUnknownTags(text) {
  return outsideCode(text, (prose) =>
    prose.replace(/<\/?([a-z][\w-]*)(?=[\s/>])[^<>]*>/gi, (tag, name) =>
      KNOWN_TAGS.has(name.toLowerCase()) ? tag : `&lt;${tag.slice(1)}`,
    ),
  )
}

// A code fence or HTML comment left open swallows everything after it, up to the
// other sections in the comment. A fence inside a list item ends with the item, and
// closes only at the item's indent: at the margin the closing line would open another.
function closeOpenMarkup(text) {
  let fence = null
  let comment = false
  const items = []

  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[ \t]+/, (space) => space.replaceAll('\t', '    '))
    const indent = line.search(/\S/)

    if (fence && indent >= 0 && indent < fence.offset) {
      fence = null
    }

    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line.slice(fence.offset))?.[1]
      if (closing?.[0] === fence.marks[0] && closing.length >= fence.marks.length) {
        fence = null
      }
      continue
    }

    if (comment) {
      if (line.includes('-->')) {
        comment = line.lastIndexOf('<!--') > line.lastIndexOf('-->')
      }
      continue
    }

    while (indent >= 0 && items.at(-1) > indent) {
      items.pop()
    }

    const marker = /^ *(?:(?:[-*+]|\d{1,9}[.)]) +)+/.exec(line)?.[0].length
    if (marker) {
      items.push(marker)
    }

    const offset = items.at(-1) ?? 0
    // A line such as ```x``` is inline code, whatever it starts with.
    const opening = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line.slice(offset))
    if (opening) {
      fence = { marks: opening[1], offset }
    } else {
      comment = line.lastIndexOf('<!--') > line.lastIndexOf('-->')
    }
  }

  const closed = fence
    ? `${text}\n${' '.repeat(fence.offset)}${fence.marks}`
    : comment
      ? `${text} -->`
      : text
  const open = openHtmlBlocks(closed)

  return open.length > 0
    ? `${closed}\n${open.reverse().map((name) => `</${name}>`).join('')}`
    : closed
}

// The HTML a text leaves open, outermost first. An open <pre> or <table> takes the
// sections after it along, just as a fence does, and an open <b> carries on in them.
function openHtmlBlocks(text) {
  let prose = ''
  outsideCode(text, (part) => {
    prose += part

    return part
  })

  const open = []
  const tags =
    /<(\/?)(pre|table|div|blockquote|ul|ol|dl|a|abbr|b|center|code|del|em|h[1-6]|i|ins|kbd|q|s|samp|span|strike|strong|sub|sup|tt|var)\b[^>]*?(\/?)>/gi
  for (const [, closing, tag, selfClosing] of prose.replace(/<!--[\s\S]*?-->/g, '').matchAll(tags)) {
    const name = tag.toLowerCase()
    if (!closing && !selfClosing) {
      open.push(name)
    } else if (closing && open.includes(name)) {
      open.length = open.lastIndexOf(name)
    }
  }

  return open
}

function truncate(text, limit) {
  if (text.length <= limit) {
    return text
  }

  // The cut may land inside a tag, which would then swallow what follows it.
  const kept = text.slice(0, limit).trimEnd().replace(/<\/?[a-z][^<>]*$/i, '')

  return `${closeOpenMarkup(kept)}\n\n_… truncated._`
}

// A line of someone else's text inside link text: a release name or a commit title.
// Its references are defused as a body's are, and no HTML or bracket of its own can
// close the section or end the link, or stay open over what follows.
function inlineText(text) {
  return outsideCode(defuseReferences(text.replace(/\s+/g, ' ').trim()), (prose) =>
    prose.replace(/</g, '&lt;').replace(/[[\]]/g, '\\$&'),
  )
}

// Not every project publishes releases. The Go subrepositories publish none at
// all, the AWS SDK tags a release per day rather than per module version, and a
// GitLab project such as modernc.org/sqlite carries plain tags. The commits
// between the two tags are then the only account of the change there is.
function renderCommits(commits, total) {
  const listed = commits.slice(-COMMIT_LIST_LIMIT)
  const earlier = total - listed.length

  return [
    '_Commits in this range:_',
    '',
    ...(earlier > 0 ? [`- _… and ${earlier} earlier._`] : []),
    ...listed.map((commit) => `- [${inlineText(commit.title)}](${quietLink(commit.url)})`),
  ].join('\n')
}

// The module path the updates share, cut at a path element: the repository
// for modules that one repository publishes.
function commonModulePath(updates) {
  const [first, ...rest] = updates.map((update) => update.name.split('/'))
  let length = first.length
  for (const name of rest) {
    while (name.slice(0, length).join('/') !== first.slice(0, length).join('/')) {
      length--
    }
  }

  return first.slice(0, length).join('/')
}

function indirectMark(update) {
  return update.indirect ? ' (indirect)' : ''
}

function renderSummary(updates) {
  if (updates.length === 1) {
    const [update] = updates

    return `<code>${update.name}</code> — ${update.from} → ${update.to}${indirectMark(update)}`
  }

  // Packages of one repository need not share a path: react and react-dom.
  const shared = commonModulePath(updates) || compareFor(updates[0])?.project || updates[0].name

  return `<code>${shared}</code> — ${updates.length} packages`
}

// The notes of a dependency, oldest first, as far back as they fit: the version
// the update arrives at is the one a reviewer is deciding on. Whole notes go, so
// that nothing is cut in the middle, and each one is capped well below the limit.
function keepNewest(notes, limit) {
  const separator = '\n\n---\n\n'
  const kept = []
  let length = 0

  for (const note of notes.toReversed()) {
    if (kept.length > 0 && length + separator.length + note.length > limit) {
      break
    }

    kept.unshift(note)
    length += separator.length + note.length
  }

  const left = notes.length - kept.length
  const omitted = left > 0 ? [`_… and ${left} earlier ${left === 1 ? 'release' : 'releases'}._`] : []

  return [...omitted, ...kept].join(separator)
}

// The links Dependabot gave an update, and any the notes were found at.
function renderLinks(update) {
  return Object.entries(update.links).map(([label, url]) => `[${label}](${url})`)
}

// Several updates share a section when their ranges list the same commits. The
// first one's links stand for all of them, since every range spans those commits.
function renderDependency({ updates, releases, commits, total, incomplete, fromChangelog }) {
  const links = renderLinks(updates[0]).join(' · ')

  // Undescribed releases give way to the commits, but they beat nothing at all.
  const notes = !documented(releases) && commits.length > 0
    ? []
    : releases.map((release) => {
        const name = release.name?.trim() || release.tag
        const date = release.date?.slice(0, 10)
        const title = inlineText(name)
        const link = release.url ? `[${title}](${quietLink(release.url)})` : title
        const heading = `**${link}**${date ? ` — ${date}` : ''}`
        const body = release.body?.trim()
          ? truncate(
              closeOpenMarkup(
                escapeUnknownTags(stripDisclosures(defuseReferences(release.body.trim()))),
              ),
              RELEASE_BODY_LIMIT,
            )
          : '_No release notes._'

        return `${heading}\n\n${body}`
      })

  if (notes.length === 0) {
    notes.push(renderCommits(commits, total))
  }

  const section = [
    '<details>',
    `<summary>${renderSummary(updates)}</summary>`,
    '',
    ...(updates.length > 1
      ? [
          ...updates
            .slice(0, SHARED_LIST_LIMIT)
            .map((update) => `- \`${update.name}\` ${update.from} → ${update.to}${indirectMark(update)}`),
          ...(updates.length > SHARED_LIST_LIMIT
            ? [`- _… and ${updates.length - SHARED_LIST_LIMIT} more._`]
            : []),
          '',
        ]
      : []),
    ...(fromChangelog ? ['_From the changelog._', ''] : []),
    ...(incomplete ? ['_Older releases in this range were not read._', ''] : []),
    keepNewest(notes, DEPENDENCY_LIMIT),
    ...(links ? ['', links] : []),
    '</details>',
  ].join('\n')

  return section
}

// How far an update moves: the first part of the version that changes.
function bumpKind(update) {
  if (isPinned(update)) {
    return 'commit'
  }

  const { from, to } = update
  const [left, right] = [parseVersion(from, ''), parseVersion(to, '')]
  if (!left || !right) {
    return '—'
  }

  const part = [0, 1, 2].find((index) => (left.parts[index] ?? 0) !== (right.parts[index] ?? 0))

  return ['**major**', 'minor', 'patch'][part] ?? '—'
}

function shortRef(update, ref) {
  return isPinned(update) ? ref.slice(0, 7) : ref
}

function notesKind({ releases, commits, fromChangelog }) {
  if (documented(releases)) {
    return fromChangelog
      ? 'Changelog'
      : `${releases.length} ${releases.length === 1 ? 'release' : 'releases'}`
  }

  return commits.length > 0 ? 'Commits' : 'None'
}

// A dependency without notes has no section, which leaves its links to the table.
function hasNotes({ releases, commits }) {
  return releases.length > 0 || commits.length > 0
}

function notesCell(entry) {
  return [notesKind(entry), ...(hasNotes(entry) ? [] : renderLinks(entry.updates[0]))].join(' · ')
}

// A table of everything the update moves, since the notes may run over several
// comments and each section is folded. The packages only a lockfile names can run
// to hundreds, so they are folded too, under the ones Dependabot set out to move.
function renderOverview(entries, listed = []) {
  const main = entries.flatMap((entry) =>
    entry.updates.map((update) => ({ update, notes: notesCell(entry) })),
  )
  const others = listed.map((update) => ({ update, notes: 'Not read' }))
  if (main.length + others.length < 2) {
    return null
  }

  const scoped = [...main, ...others].some(({ update }) => update.indirect !== undefined)
  let left = OVERVIEW_LIMIT

  const table = (rows) => {
    const lines = [
      `| Package | Update | Bump |${scoped ? ' Scope |' : ''} Notes |`,
      `| --- | --- | --- |${scoped ? ' --- |' : ''} --- |`,
    ]

    let shown = 0
    for (const { update, notes } of rows) {
      // A lockfile from before npm 7 does not say, and neither does an ecosystem without one.
      const scope = update.indirect === undefined ? '—' : update.indirect ? 'indirect' : 'direct'
      const line =
        `| \`${update.name}\` | \`${shortRef(update, update.from)}\` → \`${shortRef(update, update.to)}\` | ` +
        `${bumpKind(update)} |${scoped ? ` ${scope} |` : ''} ${notes} |`
      if (line.length >= left) {
        break
      }

      lines.push(line)
      left -= line.length + 1
      shown++
    }

    return [
      ...lines,
      ...(shown < rows.length ? ['', `_… and ${rows.length - shown} more._`] : []),
    ].join('\n')
  }

  return [
    ...(main.length > 0 ? [table(main)] : []),
    ...(others.length > 0
      ? [
          [
            '<details>',
            `<summary>${others.length} more ${others.length === 1 ? 'package' : 'packages'} from the lockfiles</summary>`,
            '',
            table(others),
            '',
            '</details>',
          ].join('\n'),
        ]
      : []),
  ].join('\n\n')
}

function intoComments(sections) {
  const comments = []
  let current = []
  let length = 0

  for (const section of sections) {
    if (current.length > 0 && length + section.length > COMMENT_BUDGET) {
      comments.push(current)
      current = []
      length = 0
    }

    current.push(section)
    length += section.length + 2
  }

  if (current.length > 0) {
    comments.push(current)
  }

  return comments.map((sections, index) => {
    const part = comments.length > 1 ? ` (${index + 1}/${comments.length})` : ''

    return [
      MARKER,
      `### Release notes${part}`,
      '',
      sections.join('\n\n'),
    ].join('\n')
  })
}

export {
  MARKER,
  bumpKind,
  closeOpenMarkup,
  escapeUnknownTags,
  hasNotes,
  intoComments,
  renderDependency,
  renderOverview,
}
