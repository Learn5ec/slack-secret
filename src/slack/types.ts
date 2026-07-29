import type { SlackEvent } from '@slack/bolt'

// Augment Slack payload types for our action callbacks
declare module '@slack/bolt' {
  interface ActionConstraints {
    'secret:view': { value?: string }
    'secret:viewed-by': { value?: string }
    'secret:cancel': { value?: string }
  }
}

export type SecretActionPayload = {
  actions: Array<{
    action_id: string
    value: string
    user: { id: string }
  }>
  trigger_id: string
  user: { id: string }
  channel: { id: string }
  message?: {
    ts: string
  }
  container: {
    message_ts?: string
  }
  view?: {
    private_metadata: string
  }
}

export type ModalSubmitPayload = {
  view: {
    id: string
    private_metadata: string
    state: {
      values: Record<string, Record<string, { value?: string }>>
    }
  }
  trigger_id: string
  user: { id: string }
  channel: { id: string }
}
