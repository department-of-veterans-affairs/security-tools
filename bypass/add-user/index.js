const core = require('@actions/core')
const {Octokit} = require('@octokit/rest')
const {retry} = require('@octokit/plugin-retry')
const {throttling} = require('@octokit/plugin-throttling')

const newClient = async (token) => {
    const _Octokit = Octokit.plugin(retry, throttling)
    return new _Octokit({
        auth: token,
        baseUrl: process.env.API_URL,
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

const getInput = () => {
    try {
        const actor = core.getInput('actor', {required: true, trimWhitespace: true})
        const issue = parseInt(core.getInput('issue', {required: true, trimWhitespace: true}))
        const message = core.getInput('message', {required: true, trimWhitespace: true})
        const org = core.getInput('org', {required: true, trimWhitespace: true})
        const repo = core.getInput('repo', {required: true, trimWhitespace: true})
        const slug = core.getInput('slug', {required: true, trimWhitespace: true})
        const token = core.getInput('token', {required: true, trimWhitespace: true})

        return {
            actor: actor,
            issue: issue,
            org: org,
            repo: repo,
            message: message,
            slug: slug,
            token: token
        }
    } catch (e) {
        throw new Error(`Failed to retrieve input variables: ${e.message}`)
    }
}

const createComment = async (client, org, repo, pr, message) => {
    try {
        await client.pulls.createComment({
            owner: org,
            repo: repo,
            pull_number: pr,
            body: message
        })
    } catch (e) {
        throw new Error(`Failed to create comment: ${e.message}`)
    }
}

const addUserToTeam = async (client, org, team, user) => {
    try {
        await client.teams.addOrUpdateMembershipForUserInOrg({
            team_slug: team,
            username: user,
            org: org,
            role: 'member'
        })
    } catch (e) {
        throw new Error(`Failed to add user to team: ${e.message}`)
    }
}

const closeIssue = async (client, org, repo, issue) => {
    try {
        await client.issues.update({
            owner: org,
            repo: repo,
            issue_number: issue,
            state: 'closed'
        })
    } catch (e) {
        throw new Error(`Failed to close issue: ${e.message}`)
    }
}

const main = async () => {
    let client, input
    try {
        input = getInput()
        client = await newClient(input.token)
        core.info(`Adding ${input.actor} to ${input.slug} in ${input.org}`)
        await addUserToTeam(client, input.org, input.slug, input.actor)
        core.info(`Adding comment to ${input.repo}#${input.issue}`)
        await createComment(client, input.org, input.repo, input.issue, input.message)
        core.info(`Closing issue ${input.repo}#${input.issue}`)
        await closeIssue(client, input.org, input.repo, input.issue)
    } catch (e) {
        core.info(`Adding failure comment to ${input.org}/${input.repo}#${input.issue}`)
        await createComment(client, input.org, input.repo, input.issue, e.message)
        core.setFailed(e.message)
    }
}

main()