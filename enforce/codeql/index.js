const core = require('@actions/core')
const {Octokit} = require('@octokit/rest')
const {retry} = require('@octokit/plugin-retry')
const {throttling} = require('@octokit/plugin-throttling')
const {parse} = require("../remediation/dist");

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
        const attempt = parseInt(core.getInput('attempt', {required: true, trimWhitespace: true}))
        const defaultBranch = core.getInput('default_branch', {required: true, trimWhitespace: true})
        const message = core.getInput('message', {required: true, trimWhitespace: true})
        const org = core.getInput('org', {required: true, trimWhitespace: true})
        const period = parseInt(core.getInput('period', {required: true, trimWhitespace: true}))
        const pr = parseInt(core.getInput('pull_request', {required: true, trimWhitespace: true}))
        const repo = core.getInput('repo', {required: true, trimWhitespace: true})
        const token = core.getInput('token', {required: true, trimWhitespace: true})

        return {
            attempt: attempt,
            defaultBranch: defaultBranch,
            org: org,
            repo: repo,
            message: message,
            period: period,
            pr: pr,
            token: token,
        }
    } catch (e) {
        throw new Error(`Failed to retrieve input variables: ${e.message}`)
    }
}

const getMostRecentAnalysis = async (client, org, repo, ref) => {
    try {
        const {data: response} = await client.request('GET /repos/{owner}/{repo}/code-scanning/analyses', {
            owner: org,
            repo: repo,
            ref: ref,
            tool_name: 'CodeQL',
            per_page: 1
        })

        if (response.length === 0) {
            return null
        }
        return response[0]
    } catch (e) {
        throw new Error(`Failed to retrieve most recent analysis: ${e.message}`)
    }

}

const validateAnalysisPeriod = (analysis, period) => {
    const now = new Date()
    const then = new Date(analysis.created_at)
    const diff = now.getTime() - then.getTime()
    const days = diff / (1000 * 3600 * 24)
    return days <= period
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

const main = async () => {
    const input = getInput()
    const client = await newClient(input.token)
    const ref = input.attempt === 1 ? input.defaultBranch : `refs/pull/${input.pr}/merge`
    const analysis = await getMostRecentAnalysis(client, input.org, input.repo, ref)
    if (analysis === null) {
        core.setFailed(`No analysis found, setting status to failed`)
        return await createComment(client, input.org, input.repo, input.pr, input.message)
    }
    if (!validateAnalysisPeriod(analysis, input.period)) {
        core.setFailed(`Most recent analysis is older than ${input.period} days, setting status to failed`)
        return await createComment(client, input.org, input.repo, input.pr, input.message)

    }
    core.info(`Analysis is within ${input.period} days, setting status to success`)
}

main()