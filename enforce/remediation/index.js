import * as core from '@actions/core'
import {Octokit} from '@octokit/rest'
import {retry} from '@octokit/plugin-retry'
import {throttling} from '@octokit/plugin-throttling'

const thresholds = {
    critical: ['critical'],
    high: ['critical', 'high'],
    medium: ['critical', 'high', 'medium'],
    low: ['critical', 'high', 'medium', 'low'],
    warning: ['critical', 'high', 'medium', 'low', 'warning'],
    note: ['critical', 'high', 'medium', 'low', 'warning', 'note'],
    error: ['critical', 'high', 'medium', 'low', 'warning', 'note', 'error']
}

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
        userAgent: 'va-security-tools-remediation-0.0.1'
    })
}

const getInput = () => {
    try {
        const age = parseInt(core.getInput('age', {required: true, trimWhitespace: true}))
        const attempt = parseInt(core.getInput('attempt', {required: true, trimWhitespace: true}))
        const defaultBranch = core.getInput('default_branch', {required: true, trimWhitespace: true})
        const message = core.getInput('message', {required: true, trimWhitespace: true})
        const org = core.getInput('org', {required: true, trimWhitespace: true})
        const pr = parseInt(core.getInput('pull_request', {required: true, trimWhitespace: true}))
        const repo = core.getInput('repo', {required: true, trimWhitespace: true})
        const threshold = core.getInput('threshold', {required: true, trimWhitespace: true})
        const token = core.getInput('token', {required: true, trimWhitespace: true})
        const visibility = core.getInput('visibility', {required: true, trimWhitespace: true})

        return {
            age: age,
            attempt: attempt,
            defaultBranch: defaultBranch,
            org: org,
            repo: repo,
            message: message,
            pr: pr,
            threshold: threshold,
            token: token,
            visibility: visibility
        }
    } catch (e) {
        throw new Error(`Failed to retrieve input variables: ${e.message}`)
    }
}

const getAlerts = async (client, org, repo, refs, threshold, age) => {
    try {
        const alerts = []
        for (const severity of thresholds[threshold]) {
            for(const ref of refs) {
                const _alerts = await client.paginate('GET /repos/{owner}/{repo}/code-scanning/alerts', {
                    owner: org,
                    repo: repo,
                    ref: ref,
                    state: 'open',
                    severity: severity,
                    per_page: 100
                })
                alerts.push(..._alerts.map(alert => {
                    let exceedsAge = false
                    const created = new Date(alert.created_at)
                    const now = new Date()
                    const diff = now - created
                    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
                    if (days > age) {
                        exceedsAge = true
                    }
                    return {
                        number: alert.number,
                        html_url: alert.html_url,
                        exceedsAge: exceedsAge,
                        age: days
                    }
                }))
            }
        }

        return alerts
    } catch (e) {
        throw new Error(`Failed to retrieve code scanning alerts: ${e.message}`)
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
        return issues.filter(issue => issue.user.login === 'github-actions[bot]' && issue.body.includes('Code Scanning Policy Findings'))
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

        core.info(`Listing previous comments for ${input.org}/${input.repo}/pull/${input.pr}`)
        const comments = await listComments(client, input.org, input.repo, input.pr)
        for(const comment of comments) {
            core.info(`Deleting previous comment for ${input.org}/${input.repo}/pull/${input.pr}`)
            await deleteComment(client, input.org, input.repo, input.pr, comment)
        }

        const refs = []
        if(input.attempt === 1) {
            refs.push(input.defaultBranch)
        } else {
            refs.push(...[
                `refs/pull/${input.pr}/head`,
                `refs/pull/${input.pr}/merge`
            ])
        }
        core.info(`Retrieving code scanning alerts for ${input.org}/${input.repo}/pull/${input.pr} with ref(s) ${refs.join(', ')}`)
        const alerts = await getAlerts(client, input.org, input.repo, refs, input.threshold, input.age)
        if (alerts.length === 0) {
            return core.info(`No alerts found for ${input.org}/${input.repo}`)
        }

        core.info(`Found ${alerts.length} alerts for ${input.org}/${input.repo} with ${input.threshold} threshold`)
        const headers = [
            {data: 'Alert Number', header: true},
            {data: 'URL', header: true},
            {data: 'Age', header: true},
            {data: 'Policy Violation', header: true}
        ]
        const summary = core.summary
            .addHeading(`Code Scanning Policy Findings`, 2)
            .addRaw(input.message)
            .addSeparator()
            .addTable([
                headers,
                ...alerts.map(alert => [
                    `${alert.number}`,
                    `<a href="${alert.html_url}">${input.visibility === 'public' ? 'Link' : alert.html_url}</a>`,
                    `${alert.age} Days`,
                    `${alert.exceedsAge ? 'Yes' : 'No'}`
                ])
            ])

        core.info(`Creating comment for https://${input.org}/${input.repo}/pull/${input.pr}`)
        await createComment(client, input.org, input.repo, input.pr, summary.stringify())

        const violations = alerts.filter(alert => alert.exceedsAge)
        if (violations.length > 0) {
            core.setFailed(`Found ${violations.length} code scanning policy violations for ${input.org}/${input.repo}`)
        }
    } catch (e) {
        core.setFailed(e.message)
    }
}

main()