'use server'

/**
 * Agent-management server actions (HT-54) — the write path for
 * `/manage/agents/**` (moved off `/settings/team/**` per TJ's 2026-07-18
 * admin-IA fidelity review). Unlike `actions.ts`'s conversation mutations (which
 * call bearer-only engine endpoints, so each action re-verifies the session
 * cookie itself before ever touching the API — see that file's module doc),
 * every call here goes through `lib/api.ts`'s acting-Agent path
 * (`actingAgent: true`), which ALREADY verifies the session cookie and
 * refuses to call the engine at all when it's missing/invalid. No separate
 * `hasValidSession()` gate is needed here: the engine also re-checks the
 * Agent's live status (active/disabled/deleted) on every such call, a
 * stronger guarantee than a cookie-only check could give.
 */

import { revalidatePath } from 'next/cache'
import {
  type Agent,
  type AgentRole,
  ApiError,
  createAgent,
  deleteAgent,
  patchAgent,
  putAgentMailboxes,
  resendInvite,
  setAgentPassword,
} from './api'

export interface AgentActionResult {
  ok: boolean
  code?: string
  message?: string
}

function toActionResult(error: unknown): AgentActionResult {
  if (error instanceof ApiError) {
    return { ok: false, code: error.code, message: error.message }
  }
  return { ok: false, code: 'network', message: 'Could not reach the server.' }
}

export interface CreateAgentActionInput {
  name: string
  email: string
  role: AgentRole
  sendInvite: boolean
  password?: string
}

export interface CreateAgentActionResult extends AgentActionResult {
  agent?: Agent
  inviteSent?: boolean
}

export async function createAgentAction(
  input: CreateAgentActionInput,
): Promise<CreateAgentActionResult> {
  try {
    const result = await createAgent(input)
    revalidatePath('/manage/agents')
    return { ok: true, agent: result.agent, inviteSent: result.inviteSent }
  } catch (error) {
    return toActionResult(error)
  }
}

export interface PatchAgentActionInput {
  name?: string
  timezone?: string
  role?: AgentRole
  status?: 'active' | 'disabled'
}

export async function patchAgentAction(
  id: string,
  input: PatchAgentActionInput,
): Promise<AgentActionResult> {
  try {
    await patchAgent(id, input)
    revalidatePath('/manage/agents')
    revalidatePath(`/manage/agents/${id}`)
    return { ok: true }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function deleteAgentAction(id: string): Promise<AgentActionResult> {
  try {
    await deleteAgent(id)
    revalidatePath('/manage/agents')
    return { ok: true }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function setAgentPasswordAction(
  id: string,
  password: string,
): Promise<AgentActionResult> {
  try {
    await setAgentPassword(id, password)
    return { ok: true }
  } catch (error) {
    return toActionResult(error)
  }
}

export async function resendInviteAction(id: string): Promise<AgentActionResult> {
  try {
    await resendInvite(id)
    revalidatePath('/manage/agents')
    revalidatePath(`/manage/agents/${id}`)
    return { ok: true }
  } catch (error) {
    return toActionResult(error)
  }
}

/** `/manage/agents/{id}/permissions` Save — replaces the Agent's mailbox-access grants in one transaction (spec §6). */
export async function putAgentMailboxesAction(
  id: string,
  mailboxIds: string[],
): Promise<AgentActionResult> {
  try {
    await putAgentMailboxes(id, mailboxIds)
    revalidatePath(`/manage/agents/${id}/permissions`)
    return { ok: true }
  } catch (error) {
    return toActionResult(error)
  }
}
