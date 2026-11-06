# Dependabot release notes

Posts the release notes of a Dependabot pull request as pull request comments, split across several comments when they do not fit in one.

GitHub caps a pull request description at 65,536 characters. A grouped update across many directories repeats every dependency's notes once per directory, so Dependabot's description is truncated and most dependencies end up with no notes at all.

The action reads the dependencies from the commit messages, the description and the `go.mod` changes in the diff, then collects the notes from GitHub and GitLab. A project that publishes no release notes gets the versions from the changelog Dependabot links or one beside the package, or else the list of commits in the range. An update of several packages opens with an overview of them, Go's indirect requirements marked and listed last, and packages with the same notes share a section. Later pushes edit the existing comments rather than posting new ones.

## Supported ecosystems

The action reads what Dependabot writes rather than the files of each language. These are the ones it is built and tested for:

| Package manager | Read from | What to expect |
| --- | --- | --- |
| npm, pnpm, Yarn | Commit messages, lockfile | Release notes or changelog excerpts, with transitive packages listed |
| uv, Poetry | Commit messages, lockfile | The same |
| pip | Commit messages | Release notes or changelog excerpts |
| Go modules | Commit messages, `go.mod`, module proxy | The same, for every requirement the update moves |
| Cargo, Composer | Commit messages, lockfile | The same as npm |
| Bundler | Commit messages | Release notes or changelog excerpts |
| Maven, Gradle | Commit messages | The same when Dependabot links a project, which it often does not, and older projects often have no release for a tag |
| NuGet | Commit messages, description | Release notes or changelog excerpts |
| GitHub Actions | Commit messages | The same for version tags, and a list of commits for an action pinned to a commit hash |
| Docker | Commit messages | Usually nothing, since Dependabot links no project for an image such as `alpine` |

Anything else Dependabot updates, such as Terraform, Hex, Pub or Git submodules, goes through the same reading of its commit messages on a best effort basis. Notes come from GitHub and GitLab only.

A lockfile tells which updates are direct, and what moves transitively. A transitive package only a lockfile names has no link to its notes, so the overview lists it with its range, in a folded table of its own. Go's module proxy supplies that link, so a Go module gets its notes either way. A package a lockfile only adds or only drops has no range and is left out.

A dependency without any notes gets a row in the overview and no section of its own, and when nothing has notes the action posts nothing. An update whose message the action cannot read gets no section, and a pull request with none of them logs a warning and still succeeds.

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

The action refuses a pull request that Dependabot did not open and ignores the messages of commits anyone else pushed to one, unless `any-author` is set, so that `workflow_dispatch` cannot be pointed at commit messages written by anyone else. A commit counts as Dependabot's only when GitHub signed it, since anyone can write Dependabot's address into a commit of their own.

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
