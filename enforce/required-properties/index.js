import * as core from '@actions/core'
import {Octokit} from '@octokit/rest'
import {retry} from '@octokit/plugin-retry'
import {throttling} from '@octokit/plugin-throttling'

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
        },
        userAgent: 'va-security-tools-codeql-0.0.1'
    })
}

const getInput = () => {
    try {
        const message = core.getInput('message', {required: true, trimWhitespace: true})
        const org = core.getInput('org', {required: true, trimWhitespace: true})
        const pr = parseInt(core.getInput('pull_request', {required: true, trimWhitespace: true}))
        const repo = core.getInput('repo', {required: true, trimWhitespace: true})
        const token = core.getInput('token', {required: true, trimWhitespace: true})

        return {
            message: message,
            org: org,
            repo: repo,
            pr: pr,
            token: token
        }
    } catch (e) {
        throw new Error(`Failed to retrieve input variables: ${e.message}`)
    }
}

const createComment = async (client, org, repo, pr, message) => {
    try {
        await client.issues.createComment({
            owner: org,
            repo: repo,
            issue_number: pr,
            body: message
        })
    } catch (e) {
        throw new Error(`Failed to create comment: ${e.message}`)
    }
}

const listComments = async (client, org, repo, pr) => {
    try {
        const issues = await client.paginate(client.issues.listComments, {
            owner: org,
            repo: repo,
            issue_number: pr,
            per_page: 100
        })
        return issues.filter(issue => issue.user.login === 'github-actions[bot]' && issue.body.includes('Policy: Required Security Maintainers'))
    } catch (e) {
        throw new Error(`Failed to list comments: ${e.message}`)
    }
}

const deleteComment = async (client, org, repo, pr, comment) => {
    try {
        await client.issues.deleteComment({
            owner: org,
            repo: repo,
            comment_id: comment.id
        })
    } catch (e) {
        throw new Error(`Failed to delete comment: ${e.message}`)
    }

}

const main = async () => {
    try {
        const input = getInput()
        const client = await newClient(input.token)

        core.info(`Listing previous comments for https://${input.org}/${input.repo}/pull/${input.pr}`)
        const comments = await listComments(client, input.org, input.repo, input.pr)
        for(const comment of comments) {
            core.info(`Deleting previous comment for ${input.org}/${input.repo}/pull/${input.pr}`)
            await deleteComment(client, input.org, input.repo, input.pr, comment)
        }

        core.info(`Checking for required properties for ${input.org}/${input.repo}`)
        const {data} = await client.request('GET /repos/{owner}/{repo}/properties/values', {
            owner: input.org,
            repo: input.repo
        })

        core.info(`Checking for security_maintainers property`)
        const securityMaintainer = data.find(property => property.property_name === 'security_maintainers')
        if(!securityMaintainer) {
            core.setFailed('Security Maintainers property not found')
            return await createComment(client, input.org, input.repo, input.pr, input.message)
        }
        const maintainers = securityMaintainer.value.split(',').map(maintainer => maintainer.trim())
        if(maintainers.length === 0 || maintainers.filter(maintainer => maintainer.includes('@')).length === 0) {
            core.setFailed('Security Maintainers property is empty or does not contain any valid email addresses')
            return await createComment(client, input.org, input.repo, input.pr, input.message)
        }
        core.info(`Security Maintainers property found`)
    } catch (e) {
        core.setFailed(e.message)
    }
}

main()