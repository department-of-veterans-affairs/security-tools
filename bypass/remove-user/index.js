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
        const hours = parseInt(core.getInput('hours', {required: true, trimWhitespace: true}))
        const message = core.getInput('message', {required: true, trimWhitespace: true})
        const org = core.getInput('org', {required: true, trimWhitespace: true})
        const slug = core.getInput('slug', {required: true, trimWhitespace: true})
        const token = core.getInput('token', {required: true, trimWhitespace: true})

        return {
            actor: actor,
            hours: hours,
            org: org,
            message: message,
            slug: slug,
            token: token
        }
    } catch (e) {
        throw new Error(`Failed to retrieve input variables: ${e.message}`)
    }
}

const listTeamMembers = async (client, org, slug) => {
    try {
        const response = await client.paginate(client.teams.listMembersInOrg, {
            org: org,
            team_slug: slug,
            per_page: 100
        })
        return response.map(member => member.login)
    } catch (e) {
        throw new Error(`Failed to list team members: ${e.message}`)
    }
}

const retrieveAuditLog = async (client, org, actor, user, hours) => {
    try {
        const date = new Date()
        date.setHours(date.getHours() - hours)
        return await client.paginate('GET /orgs/{org}/audit-log', {
            org: org,
            phrase: `action:team.add_member operation:create actor:${actor} user:${user} created:>=${date.toISOString()}`,
            per_page: 1
        })
    } catch (e) {
        throw new Error(`Failed to retrieve audit log: ${e.message}`)
    }
}

const removeUserFromTeam = async (client, org, slug, user) => {
    try {
        await client.teams.removeMembershipForUserInOrg({
            org: org,
            team_slug: slug,
            username: user,
        })
    } catch (e) {
        throw new Error(`Failed to remove user from team: ${e.message}`)
    }

}

const main = async () => {
    try {
        const input = getInput()
        const client = await newClient(input.token)
        core.info(`Retrieving team members for ${input.slug} in ${input.org}`)
        const members = await listTeamMembers(client, input.org, input.slug)
        core.info(`Found ${members.length} members in ${input.slug} in ${input.org}`)
        for (const member of members) {
            try {
                core.info(`Retrieving audit log for ${member} in ${input.org}`)
                const log = await retrieveAuditLog(client, input.org, input.actor, member, input.hours)
                if (log.length === 0) {
                    core.info(`No audit log found for ${member} in ${input.org} in the last ${input.hours} hours, removing from team`)
                    await removeUserFromTeam(client, input.org, input.slug, member)
                } else {
                    core.info(`Audit log entry found for ${member} in the last ${input.hours} hours, users bypass permission has not yet expired`)
                }
            } catch (e) {
                core.warning(`Failed to remove ${member} from ${input.slug} in ${input.org}: ${e.message}`)
            }
        }
    } catch (e) {
        core.setFailed(e.message)
    }
}

main()