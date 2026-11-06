// What a run is asked to do. An action reads its inputs from INPUT_*, and a local
// run from the names given here.

function input(env, name, local) {
  return env[`INPUT_${name.toUpperCase()}`] || (local && env[local]) || undefined
}

function readConfig(env = process.env, argv = process.argv) {
  return {
    token: input(env, 'token', 'GITHUB_TOKEN'),
    repository: env.GITHUB_REPOSITORY || undefined,
    pullRequest: input(env, 'pull-request', 'PR_NUMBER'),
    author: input(env, 'author', 'COMMENT_AUTHOR') ?? 'github-actions[bot]',
    anyAuthor: input(env, 'any-author', 'ANY_AUTHOR') === 'true',
    onlyWhenTruncated: input(env, 'only-when-truncated', 'ONLY_WHEN_TRUNCATED') === 'true',
    dryRun: argv.includes('--dry-run'),
    onRunner: env.GITHUB_ACTIONS === 'true',
    // The tests have no time to wait.
    retryDelay: Number(env.RETRY_DELAY_MS ?? 1_000),
    // How long to wait for a rate limit to lift, rather than fail the run. A limit
    // that lifts later than this is left to a later run.
    rateLimitWait: Number(env.RATE_LIMIT_WAIT_MS ?? 60_000),
  }
}

// What is wrong with a configuration, if anything. The pull request number and the
// repository go into the path of every request, the writes included.
function configError({ token, repository, pullRequest }) {
  if (!token || !repository || !pullRequest) {
    return 'GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required'
  }

  if (!/^[1-9]\d*$/.test(pullRequest) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return `Not a pull request number and a repository: ${pullRequest}, ${repository}`
  }

  return null
}

export {
  configError,
  readConfig,
}
