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
        const defaultBranch = core.getInput('default_branch', {required: true, trimWhitespace: true})
        const messageNotFound = core.getInput('message_not_found', {required: true, trimWhitespace: true})
        const messageNoRecentAnalysis = core.getInput('message_no_recent_analysis', {
            required: true,
            trimWhitespace: true
        })
        const org = core.getInput('org', {required: true, trimWhitespace: true})
        const period = parseInt(core.getInput('period', {required: true, trimWhitespace: true}))
        const pr = parseInt(core.getInput('pull_request', {required: true, trimWhitespace: true}))
        const repo = core.getInput('repo', {required: true, trimWhitespace: true})
        const token = core.getInput('token', {required: true, trimWhitespace: true})

        return {
            defaultBranch: defaultBranch,
            org: org,
            repo: repo,
            messageNotFound: messageNotFound,
            messageNoRecentAnalysis: messageNoRecentAnalysis,
            period: period,
            pr: pr,
            token: token,
        }
    } catch (e) {
        throw new Error(`Failed to retrieve input variables: ${e.message}`)
    }
}

const getMostRecentAnalysis = async (client, org, repo, refs) => {
    try {
        core.info(`Retrieving most recent advanced configuration analysis for ref ${refs.pr}`)
        const {data: prAnalyses} = await client.codeScanning.listRecentAnalyses({
            owner: org,
            repo: repo,
            ref: refs.pr,
            tool_name: 'CodeQL',
            per_page: 1
        })
        if (prAnalyses.length > 0) {
            core.info(`Most recent advanced configuration analysis found for ref ${refs.pr}: ${JSON.stringify(prAnalyses[0])}`)
            return prAnalyses[0]
        }

        const head = refs.pr.replaceAll('merge', 'head')
        core.info(`No advanced configuration found, retrieving most recent default analysis for ref ${head}`)
        const {data: prAnalysesHead} = await client.codeScanning.listRecentAnalyses({
            owner: org,
            repo: repo,
            ref: head,
            tool_name: 'CodeQL',
            per_page: 1
        })
        if (prAnalysesHead.length > 0) {
            core.info(`Most recent default analysis found for ref ${head}: ${JSON.stringify(prAnalysesHead[0])}`)
            return prAnalysesHead[0]
        }
    } catch (e) {
        if (e.status === 404) {
            try {
                core.info(`No analysis found for ${refs.pr}, retrieving most recent analysis for ref ${refs.default}`)
                const {data: defaultAnalyses} = await client.codeScanning.listRecentAnalyses({
                    owner: org,
                    repo: repo,
                    ref: refs.default,
                    tool_name: 'CodeQL',
                    per_page: 1
                })
                if (defaultAnalyses.length > 0) {
                    core.info(`Most recent analysis found for ref ${refs.default}: ${JSON.stringify(defaultAnalyses[0])}`)
                    return defaultAnalyses[0]
                }

                core.warning(`No analysis found for ${refs.default}`)
                return null
            } catch (e) {
                if (e.status === 404) {
                    return null
                }
                throw new Error(`Failed to retrieve most recent analysis: ${e.message}`)
            }
        }
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
    try {
        const input = getInput()
        const client = await newClient(input.token)
        const refs = {
            default: input.defaultBranch,
            pr: `refs/pull/${input.pr}/merge`
        }
        core.info(`Retrieving most recent analysis for ${input.org}/${input.repo}/pull/${input.pr} with refs ${JSON.stringify(refs)}`)
        const analysis = await getMostRecentAnalysis(client, input.org, input.repo, refs)
        if (analysis === null) {
            core.setFailed(`No analysis found for any branch, setting status to failed`)
            return await createComment(client, input.org, input.repo, input.pr, input.messageNotFound)
        }
        if (!validateAnalysisPeriod(analysis, input.period)) {
            core.setFailed(`Most recent analysis is older than ${input.period} days, setting status to failed`)
            return await createComment(client, input.org, input.repo, input.pr, input.messageNoRecentAnalysis)
        }
        core.info(`Analysis is within ${input.period} days, setting status to success`)
    } catch (e) {
        core.setFailed(e.message)
    }
}

main()