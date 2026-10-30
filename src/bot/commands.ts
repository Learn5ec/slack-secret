import { logger } from '../utils/logger'
import { buildSecretModal, UserGroupOption } from '../slack/view-builder'

// Fetch the workspace's selectable User Groups for the modal picker.
// Returns [] on any failure (e.g. free plan / no usergroups:read) so the
// modal still opens — the group picker just shows "No user groups available".
async function fetchUserGroups(client: any): Promise<UserGroupOption[]> {
  try {
    const result = await client.usergroups.list({ include_count: true, include_disabled: false })
    if (!result.ok || !Array.isArray(result.usergroups)) return []
    return result.usergroups
      .filter((g: any) => g && !g.deleted_by && g.is_visible !== false && !g.is_section && !g.is_idp_group)
      .map((g: any) => ({
        id: g.id as string,
        handle: (g.handle as string) ?? (g.name as string),
        name: (g.name as string) ?? (g.handle as string),
        user_count: typeof g.user_count === 'number' ? g.user_count : undefined,
      }))
  } catch (err: any) {
    logger.warn({ err, message: err.message }, 'Failed to fetch user groups for modal; continuing without group picker')
    return []
  }
}

type CommandArgs = {
  command: {
    trigger_id: string
    user_id: string
    text: string
  }
  ack: () => Promise<void>
  respond: (args: { response_type: string; text: string }) => Promise<void>
  client: any
}

export async function handleSecretCommand(args: CommandArgs): Promise<void> {
  const { command, ack, respond, client } = args

  logger.info({ command, userId: command.user_id }, 'Received /secret command')

  await ack()

  // Log for debugging
  logger.info({ trigger_id: command.trigger_id, has_client: !!client }, 'Attempting to open modal')

  // Fetch selectable User Groups (best-effort) and build the modal.
  const userGroups = await fetchUserGroups(client)
  const modalView = buildSecretModal(userGroups)
  logger.info({ groupCount: userGroups.length }, 'Built modal view')

  try {
    const result = await client.views.open({
      trigger_id: command.trigger_id,
      view: modalView,
    })

    logger.info({ result }, 'views.open result')

    if (!result.ok) {
      logger.error({ result }, 'Failed to open modal')
      await respond({
        response_type: 'ephemeral',
        text: `Error: ${result.error}`,
      })
    }
  } catch (err: any) {
    logger.error({ err, errMessage: err.message, errStack: err.stack }, 'Exception opening modal')
    await respond({
      response_type: 'ephemeral',
      text: `Error: ${err.message}`,
    })
  }
}
