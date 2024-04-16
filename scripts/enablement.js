import fs from 'fs'
import {Octokit} from '@octokit/rest'
import {retry} from '@octokit/plugin-retry'
import {throttling} from '@octokit/plugin-throttling'

const newClient = async () => {
  const _Octokit = Octokit.plugin(retry, throttling)
  return new _Octokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`)
        if (options.request.retryCount === 0) {
          octokit.log.info(`Retrying after ${retryAfter} seconds!`)
          return true
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(`Abuse detected for request ${options.method} ${options.url}`)
        if (options.request.retryCount === 0) {
          octokit.log.info(`Retrying after ${retryAfter} seconds!`)
          return true
        }
      },
    }
  })
}

const main = async () => {
  let _repos
  const client = await newClient()
  if (fs.existsSync('repos.json')) {
    _repos = JSON.parse(fs.readFileSync('repos.json', 'utf8'))
  } else {
    _repos = await client.paginate(client.repos.listForOrg, {
      org: 'department-of-veterans-affairs',
      type: 'all',
      per_page: 100
    })
    await fs.writeFileSync('repos.json', JSON.stringify(_repos, null, 2))
  }

  const repos = _repos.filter(repo => {
    // Filter archived repos
    if (repo.archived) {
      return false
    }
    // Check if repo older than 6 months
    const now = new Date()
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(now.getMonth() - 6)
    const created = new Date(repo.updated_at)
    return created < sixMonthsAgo
  })

  for (const repo of repos) {
    console.log(`Enabling feature flag for ${repo.full_name}: ${repo.updated_at}`)
    continue
    const {data: properties} = await client.request('GET /repos/{owner}/{repo}/properties/values', {
      owner: repo.owner.login,
      repo: repo.name
    })
    for (let i = 0; i < properties.length; i++) {
      if (properties[i].property_name === 'feature_flag_codeql_rollout_enabled') {
        properties[i].value = 'true'
      }
    }
    await client.request('PATCH /repos/{owner}/{repo}/properties/values', {
      owner: repo.owner.login,
      repo: repo.name,
      properties: properties
    })
  }
}

main()