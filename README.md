# Dependabot release notes

Posts the release notes of a Dependabot pull request as pull request comments, split across several comments when they do not fit in one.

GitHub caps a pull request description at 65,536 characters. A grouped update across many directories repeats every dependency's notes once per directory, so Dependabot's description is truncated and most dependencies end up with no notes at all.

The action reads the dependencies from the commit messages and from the `go.mod` changes in the diff, then collects the notes from GitHub and GitLab. A project that publishes no release notes gets the list of commits in the range. Later pushes edit the existing comments rather than posting new ones.

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
      - uses: mgnsk/dependabot-release-notes@v1
        with:
          pull-request: ${{ github.event.pull_request.number || inputs.pull-request }}
```

The job runs with a write token, so it must never check out or execute the code under review. It needs no checkout at all.

The runner must have `node` on its `PATH`, which GitHub-hosted runners do.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | `github.token` | Token that reads the pull request and writes its comments |
| `pull-request` | The triggering pull request | Pull request number to comment on |

## Running locally

`--dry-run` prints the comments instead of posting them:

```sh
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
  node dependabot-release-notes.mjs --dry-run
```
