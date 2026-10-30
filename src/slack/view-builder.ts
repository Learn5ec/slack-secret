export type UserGroupOption = { id: string; handle: string; name: string; user_count?: number }

// Slack caps a static_select at 100 options and each plain_text field at 75 chars.
const MAX_STATIC_OPTIONS = 100
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Build the User Group static_select options (shared by the share and secret modals).
function usergroupOptions(userGroups: UserGroupOption[]) {
  return userGroups.length === 0
    ? [{ text: { type: 'plain_text' as const, text: 'No user groups available' }, value: '' }]
    : userGroups.slice(0, MAX_STATIC_OPTIONS).map((g) => ({
        text: {
          type: 'plain_text' as const,
          text: truncate(
            `${g.name} (@${g.handle}${typeof g.user_count === 'number' ? ` · ${g.user_count}` : ''})`,
            75,
          ),
        },
        value: g.id,
      }))
}

export function buildSecretModal(userGroups: UserGroupOption[] = []) {
  const groupOptions = usergroupOptions(userGroups)

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
          type: 'conversations_select',
          placeholder: {
            type: 'plain_text',
            text: 'Select a person or channel',
            emoji: true,
          },
          action_id: 'recipient',
          filter: {
            include: ['im', 'public', 'private'],
            exclude_bot_users: true,
          },
        },
        label: {
          type: 'plain_text',
          text: 'Recipient',
          emoji: true,
        },
        // Optional so a secret can target a User Group alone. The modal
        // handler enforces that at least one of Recipient / User Group is set.
        optional: true,
      },
      {
        type: 'input',
        block_id: 'usergroup_block',
        element: {
          type: 'static_select',
          placeholder: {
            type: 'plain_text',
            text: 'Select a user group',
            emoji: true,
          },
          action_id: 'usergroup',
          options: groupOptions,
        },
        label: {
          type: 'plain_text',
          text: 'User Group (optional)',
          emoji: true,
        },
        optional: true,
      },
      {
        type: 'input',
        block_id: 'mpim_block',
        element: {
          type: 'plain_text_input',
          action_id: 'mpim_id',
          placeholder: {
            type: 'plain_text',
            text: 'e.g. C0CEBDXC2GY or a Slack conversation link',
            emoji: true,
          },
        },
        label: {
          type: 'plain_text',
          text: 'Group Conversation ID (optional)',
          emoji: true,
        },
        // The bot must be a member of the group conversation to enumerate its
        // members. If it isn't, the modal handler DMs the sender to add
        // @SecretBot first. Exactly one of Recipient / User Group / this field
        // may be set.
        optional: true,
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
            text: '🔗 Share',
            emoji: true,
          },
          action_id: 'secret:share',
          value: secretId || '',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '👥 Manage',
            emoji: true,
          },
          action_id: 'secret:manage',
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

export function buildRecipientPlaceholderBlocks(secretType: SecretType, senderName: string, recipientName?: string | null, secretId?: string, entityLabel?: string | null) {
  const { emoji, typeLabel } = describeSecretType(secretType)

  // For recipient: show only View Secret button. When the secret reached the
  // recipient through an entity (a channel / user group / group conversation),
  // name that entity so they know where it came from.
  const viaText = entityLabel ? ` via ${entityLabel}` : ''
  const headerText = recipientName
    ? `${emoji} *${senderName} shared a ${typeLabel.toLowerCase()} with you${viaText}*\nClick View Secret to open.`
    : `${emoji} *${typeLabel} from ${senderName}${viaText}*\nClick View Secret to open.`

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

// `label` is the conversation noun used when there's no channel name to show
// (an mpim's real name is an "mpdm-…" slug, so we say "this group conversation"
// instead of "#mpdm-…"). Defaults to 'channel' so existing calls are unchanged.
function announcementLabel(channelName?: string | null, label = 'channel'): string {
  return channelName ? `in *#${channelName}*` : `to this ${label}`
}

export function buildChannelAnnouncementBlocks(senderName: string, channelName?: string | null, label = 'channel') {
  const channelText = announcementLabel(channelName, label)
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${senderName} shared a secret ${channelText}.*\n_Check your DM from Secret Bot and view the secret safely._`,
      },
    },
  ]
}

export function buildRevokedChannelAnnouncementBlocks(senderName: string, channelName?: string | null, label = 'channel') {
  const channelText = announcementLabel(channelName, label)
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_🔒 ${senderName} shared a secret ${channelText}._\n*This secret was revoked.*`,
      },
    },
  ]
}

export function buildExpiredChannelAnnouncementBlocks(senderName: string, channelName?: string | null, expiredAt?: string, label = 'channel') {
  const channelText = announcementLabel(channelName, label)
  const expiredText = expiredAt ? ` at ${expiredAt} IST` : ''
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_🔒 ${senderName} shared a secret ${channelText}._\n*This secret expired${expiredText}.*`,
      },
    },
  ]
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

// Share/forward an EXISTING secret. Same three recipient modes as the creation
// modal (person / user group / group conversation id) but no secret text/file —
// the secret is already stored. Exactly one recipient mode may be set.
export function buildShareModal(secretId: string, userGroups: UserGroupOption[] = []) {
  return {
    type: 'modal',
    callback_id: 'secret_share',
    title: { type: 'plain_text', text: 'Share Secret', emoji: true },
    submit: { type: 'plain_text', text: 'Forward', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: secretId,
    blocks: [
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'Send this existing secret to more people. Each gets their own one-time View Secret DM.' },
        ],
      },
      {
        type: 'input',
        block_id: 'recipient_block',
        element: {
          type: 'conversations_select',
          placeholder: { type: 'plain_text', text: 'Select a person or channel', emoji: true },
          action_id: 'recipient',
          filter: { include: ['im', 'public', 'private'], exclude_bot_users: true },
        },
        label: { type: 'plain_text', text: 'Recipient', emoji: true },
        optional: true,
      },
      {
        type: 'input',
        block_id: 'usergroup_block',
        element: {
          type: 'static_select',
          placeholder: { type: 'plain_text', text: 'Select a user group', emoji: true },
          action_id: 'usergroup',
          options: usergroupOptions(userGroups),
        },
        label: { type: 'plain_text', text: 'User Group (optional)', emoji: true },
        optional: true,
      },
      {
        type: 'input',
        block_id: 'mpim_block',
        element: {
          type: 'plain_text_input',
          action_id: 'mpim_id',
          placeholder: { type: 'plain_text', text: 'e.g. C0CEBDXC2GY or a Slack conversation link', emoji: true },
        },
        label: { type: 'plain_text', text: 'Group Conversation ID (optional)', emoji: true },
        optional: true,
      },
    ],
  }
}

// List current recipients of a secret so the sender can revoke one person's
// access individually (e.g. undo a mistaken forward) without revoking everyone.
export function buildManageAccessModal(secretId: string, recipients: Array<{ userId: string }>) {
  const blocks: any[] = [
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: recipients.length > 0
          ? `Remove a single recipient's access. *Revoke* still removes everyone at once.`
          : `No other recipients yet.` },
      ],
    },
  ]

  for (const r of recipients) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<@${r.userId}>` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '🗑 Remove', emoji: true },
        style: 'danger',
        action_id: 'secret:manage-remove',
        value: r.userId,
      },
    })
  }

  return {
    type: 'modal',
    callback_id: 'secret_manage',
    title: { type: 'plain_text', text: 'Manage Access', emoji: true },
    close: { type: 'plain_text', text: 'Done', emoji: true },
    private_metadata: secretId,
    blocks,
  }
}
