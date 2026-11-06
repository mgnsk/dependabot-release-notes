// What GitHub and GitLab answer, in one shape.

import { pathRef } from './http.mjs'

function githubRelease(release) {
  return {
      tag: release.tag_name,
      name: release.name,
      body: release.body,
      url: release.html_url,
      date: release.published_at,
    }
  }

  // A file over the contents API's size limit comes without its content.
  function decodeFile(file) {
    return file?.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : null
  }

  // A dependency's notes live on whichever forge hosts it, so each forge answers
  // the same questions: which releases does it publish, a page at a time and
  // newest first, which commits lie between two tags, and what does a file hold.
  // GitHub also lists tags and finds a release by tag, for a project with more
  // releases than are worth paging through. The shapes are normalised here and
  // nowhere else.
  function createForges({ api, request }) {
    return {
    'github.com': {
      async releases(project, page) {
        const releases =
          (await api(`/repos/${project}/releases?per_page=100&page=${page}`)) ?? []

        return {
          done: releases.length < 100,
          releases: releases
            .filter((release) => !release.draft)
            .map(githubRelease),
        }
      },

      async release(project, tag) {
        const release = await api(`/repos/${project}/releases/tags/${pathRef(tag)}`)

        return release && githubRelease(release)
      },

      // This one answers with every match at once, and would repeat them if paged.
      async tags(project, stem) {
        const refs = (await api(`/repos/${project}/git/matching-refs/tags/${pathRef(stem)}`)) ?? []

        return refs.map((ref) => ref.ref.slice('refs/tags/'.length))
      },

      async file(project, ref, path) {
        return decodeFile(
          await api(`/repos/${project}/contents/${pathRef(path)}?ref=${encodeURIComponent(ref)}`),
        )
      },

      async commits(project, base, head) {
        const compare = await api(`/repos/${project}/compare/${pathRef(base)}...${pathRef(head)}`)
        const commits = (compare?.commits ?? []).map((commit) => ({
          title: commit.commit.message.split('\n')[0],
          url: commit.html_url,
        }))

        // GitHub answers with the newest 250 commits and the count of them all.
        return { commits, total: compare?.total_commits ?? commits.length }
      },
    },

    'gitlab.com': {
      async releases(project, page) {
        const releases =
          (await request(
            `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/releases?per_page=100&page=${page}`,
          )) ?? []

        return {
          done: releases.length < 100,
          releases: releases
            .filter((release) => !release.upcoming_release)
            .map((release) => ({
              tag: release.tag_name,
              name: release.name,
              body: release.description,
              url: release._links?.self,
              date: release.released_at,
            })),
        }
      },

      async commits(project, base, head) {
        const compare = await request(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/repository/compare` +
            `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
        )

        const commits = (compare?.commits ?? []).map((commit) => ({
          title: commit.title,
          url: commit.web_url,
        }))

        return { commits, total: commits.length }
      },

      async file(project, ref, path) {
        return decodeFile(
          await request(
            `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/repository/files/` +
              `${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
          ),
        )
      },
    },
  }
}

export {
  createForges,
}
