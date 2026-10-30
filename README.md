# Dependabot release notes

Posts the release notes of a Dependabot pull request as pull request comments, split across several comments when they do not fit in one.

GitHub caps a pull request description at 65,536 characters. A grouped update across many directories repeats every dependency's notes once per directory, so Dependabot's description is truncated and most dependencies end up with no notes at all.

The action reads the dependencies from the commit messages, the description and the `go.mod` changes in the diff, then collects the notes from GitHub and GitLab. A project that publishes no release notes gets the versions from the changelog Dependabot links, or else the list of commits in the range. An update of several packages opens with an overview of them, Go's indirect requirements marked and listed last, and packages with the same notes share a section. Later pushes edit the existing comments rather than posting new ones.

## Supported ecosystems

The action reads what Dependabot writes rather than the files of each language, so it is meant to work with any ecosystem Dependabot updates. Go, npm, Cargo and Composer get more: `go.mod` and the lockfiles `package-lock.json`, `npm-shrinkwrap.json`, `Cargo.lock` and `composer.lock` also reveal what moves transitively, and which updates are direct. Notes come from GitHub and GitLab only.

A transitive package only a lockfile names has no link to its notes, so the overview lists it with its range, in a folded table of its own. A dependency without any notes gets a row in the overview and no section of its own, and when nothing has notes the action posts nothing. Go's module proxy supplies that link, so a Go module gets its notes either way. A package a lockfile only adds or only drops has no range and is left out.

| Ecosystem | What to expect |
| --- | --- |
| npm, pip, Cargo, Composer, Bundler, Terraform, Go | Release notes or changelog excerpts, when Dependabot links a project on GitHub or GitLab |
| NuGet | The same, with the versions read from the description |
| Maven | The same, though older projects often have no release for a tag |
| GitHub Actions | The same for version tags, and a list of commits for an action pinned to a commit hash |
| Git submodules | A list of commits |
| Docker | Usually no notes, since Dependabot links no project for an image such as `alpine` |

The ecosystems above were tried on real pull requests. Others, such as Gradle, Swift, Hex and Pub, have not been tried. An update whose message the action cannot read gets no section, and a pull request with none of them logs "nothing to post" and still succeeds.

## Usage

```yaml
name: Dependabot release notes

on:
  pull_request_target:
    types:
      - opened
      - synchronize
      - reopened
  workflow_dispatch:
    inputs:
      pull-request:
        description: "Pull request number to comment on"
        required: true

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: dependabot-release-notes-${{ github.event.pull_request.number || inputs.pull-request }}
  cancel-in-progress: true

jobs:
  comment:
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: mgnsk/dependabot-release-notes@<commit-sha> # v1
        with:
          pull-request: ${{ github.event.pull_request.number || inputs.pull-request }}
```

The job runs with a write token, so it must never check out or execute the code under review. It needs no checkout at all. For the same reason, pin the action to a full commit SHA rather than a tag that can move.

The action refuses a pull request that Dependabot did not open and ignores the messages of commits anyone else pushed to one, unless `any-author` is set, so that `workflow_dispatch` cannot be pointed at commit messages written by anyone else.

A rate limit that lifts within a minute is waited out. A temporary failure that persists, such as a longer rate limit or a 5xx through retries, fails the run. Comments from an earlier run are then left as they are; with none to keep, the action posts what it has.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | `github.token` | Token that reads the pull request and writes its comments |
| `pull-request` | The triggering pull request | Pull request number to comment on |
| `author` | `github-actions[bot]` | Login that the token posts as, whose comments the action may edit and delete. Set it when `token` belongs to another account |
| `any-author` | `false` | Run on a pull request that Dependabot did not open, and read commits anyone pushed to one |
| `only-when-truncated` | `false` | Post only when Dependabot had to truncate the description, and take back earlier comments otherwise |

## Running locally

`--dry-run` prints the comments instead of posting them:

```sh
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
  node dependabot-release-notes.mjs --dry-run
```

## Testing

The tests run the script as a subprocess against a fake network and need nothing installed:

```sh
node --test
```
