import { logger } from '../utils/logger'
import { buildSecretModal } from '../slack/view-builder'

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

  // Open the modal using views.open
  const modalView = buildSecretModal()
  logger.info({ modalView }, 'Built modal view')

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
