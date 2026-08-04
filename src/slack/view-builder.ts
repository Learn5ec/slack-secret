export function buildSecretModal() {
  return {
    type: 'modal',
    callback_id: 'secret_modal',
    title: {
      type: 'plain_text',
      text: 'Share a Secret',
      emoji: true,
    },
    submit: {
      type: 'plain_text',
      text: 'Send',
      emoji: true,
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
      emoji: true,
    },
    blocks: [
      {
        type: 'input',
        block_id: 'recipient_block',
        element: {
          type: 'users_select',
          placeholder: {
            type: 'plain_text',
            text: 'Select a recipient',
            emoji: true,
          },
          action_id: 'recipient',
        },
        label: {
          type: 'plain_text',
          text: 'Recipient',
          emoji: true,
        },
      },
      {
        type: 'input',
        block_id: 'text_block',
        element: {
          type: 'plain_text_input',
          multiline: true,
          min_length: 1,
          max_length: 3000,
          action_id: 'secret_text',
        },
        label: {
          type: 'plain_text',
          text: 'Secret Text',
          emoji: true,
        },
        optional: true,
      },
      {
        type: 'input',
        block_id: 'file_block',
        element: {
          type: 'file_input',
          action_id: 'file_input',
          max_files: 1,
        },
        label: {
          type: 'plain_text',
          text: 'File',
          emoji: true,
        },
        optional: true,
      },
    ],
  }
}

type SecretType = 'text' | 'file' | 'combined'

function describeSecretType(secretType: SecretType): { emoji: string; typeLabel: string } {
  if (secretType === 'text') return { emoji: '🔒', typeLabel: 'Secret' }
  if (secretType === 'file') return { emoji: '📎', typeLabel: 'File' }
  return { emoji: '🔒📎', typeLabel: 'Secret + File' }
}

export function buildPlaceholderBlocks(secretType: SecretType, senderName: string, recipientName?: string | null, secretId?: string) {
  const { emoji, typeLabel } = describeSecretType(secretType)

  // For sender: show all 3 buttons (View, Viewed By, Revoke)
  const headerText = recipientName
    ? `${emoji} *${senderName} shared a ${typeLabel.toLowerCase()} with ${recipientName}*\nClick View Secret to open.`
    : `${emoji} *${typeLabel} from ${senderName}*\nTap the button to reveal.`

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: headerText,
      },
    },
    {
      type: 'actions',
      block_id: 'secret_actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🔓 View Secret',
            emoji: true,
          },
          style: 'primary',
          action_id: 'secret:view',
          value: secretId || '',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '👁 Viewed By',
            emoji: true,
          },
          action_id: 'secret:viewed-by',
          value: secretId || '',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🗑 Revoke',
            emoji: true,
          },
          style: 'danger',
          action_id: 'secret:cancel',
          value: secretId || '',
        },
      ],
    },
  ]
}

export function buildRecipientPlaceholderBlocks(secretType: SecretType, senderName: string, recipientName?: string | null, secretId?: string) {
  const { emoji, typeLabel } = describeSecretType(secretType)

  // For recipient: show only View Secret button
  const headerText = recipientName
    ? `${emoji} *${senderName} shared a ${typeLabel.toLowerCase()} with you*\nClick View Secret to open.`
    : `${emoji} *${typeLabel} from ${senderName}*\nClick View Secret to open.`

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: headerText,
      },
    },
    {
      type: 'actions',
      block_id: 'secret_actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🔓 View Secret',
            emoji: true,
          },
          style: 'primary',
          action_id: 'secret:view',
          value: secretId || '',
        },
      ],
    },
  ]
}

export function buildViewedPlaceholderBlocks(secretType: SecretType, viewerCount: number) {
  const { typeLabel } = describeSecretType(secretType)
  const emoji = secretType === 'file' ? '📎' : '🔓'

  if (viewerCount === 1) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${typeLabel} viewed.*`,
        },
      },
    ]
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${typeLabel}* — viewed by ${viewerCount} people so far.`,
      },
    },
  ]
}

export function buildCancelledPlaceholderBlocks(secretType: SecretType) {
  const { emoji, typeLabel } = describeSecretType(secretType)

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${typeLabel} cancelled.*`,
      },
    },
  ]
}

export function buildExpiredPlaceholderBlocks(secretType: SecretType) {
  const { emoji, typeLabel } = describeSecretType(secretType)

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${typeLabel}* expired, unopened.`,
      },
    },
  ]
}

export function buildViewedByBlocks(viewerList: Array<{ name: string; deliveredAt: string }>) {
  if (viewerList.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'No one has viewed this secret yet.',
        },
      },
    ]
  }

  const items = viewerList.map((v) => `• ${v.name} — ${v.deliveredAt}`)
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Viewed by:*\n${items.join('\n')}`,
      },
    },
  ]
}

export function buildRevealedSecretBlocks(headerText: string, secretBlocks: any[], secretId: string) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${headerText}\n_🔒 Only visible to you._`,
      },
    },
    ...secretBlocks,
    {
      type: 'actions',
      block_id: 'secret_revealed_actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '🙈 Hide Secret',
            emoji: true,
          },
          style: 'danger',
          action_id: 'secret:hide',
          value: secretId,
        },
      ],
    },
  ]
}

export function buildRevokeConfirmationModal(secretId: string) {
  return {
    type: 'modal',
    callback_id: 'revoke_confirm',
    title: {
      type: 'plain_text',
      text: 'Revoke Secret',
      emoji: true,
    },
    submit: {
      type: 'plain_text',
      text: "I'm Sure",
      emoji: true,
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
      emoji: true,
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Are you sure you want to revoke this secret?*\nIf it\'s gone, it\'s gone for good! This action cannot be undone.',
        },
      },
    ],
    private_metadata: secretId,
  }
}

export function buildPermanentAnnouncementBlocks(secretType: SecretType, senderName: string, recipientName?: string | null) {
  const { emoji, typeLabel } = describeSecretType(secretType)

  const headerText = recipientName
    ? `${emoji} *${senderName} sent a ${typeLabel.toLowerCase()} to ${recipientName}*`
    : `${emoji} *${senderName} sent a ${typeLabel.toLowerCase()}*`

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: headerText,
      },
    },
  ]
}
