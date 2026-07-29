/**
 * Markdown to Slack Block Kit converter
 * Converts Slack markdown syntax to Slack Block Kit format
 */

export type SlackBlock = {
  type: string
  text?: {
    type: string
    text: string
  }
  fields?: Array<{
    type: string
    text: string
  }>
  elements?: any[]
  accessory?: any
  [key: string]: any
}

export function markdownToSlackBlocks(markdown: string): SlackBlock[] {
  if (!markdown || markdown.trim().length === 0) {
    return []
  }

  const blocks: SlackBlock[] = []
  const lines = markdown.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Empty line - skip or add divider
    if (line.trim() === '') {
      i++
      continue
    }

    // Code block (``` or ~~~)
    if (line.match(/^(`{3,}|~{3,})/)) {
      const fence = line.match(/^(.+?)$/)?.[1] || '```'
      const codeLines: string[] = []

      i++
      while (i < lines.length && !lines[i].match(new RegExp(`^${fence.slice(0, 3)}$`))) {
        codeLines.push(lines[i])
        i++
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`\n${codeLines.join('\n')}\n\`\`\``,
        },
      })

      i++ // Skip the closing fence
      continue
    }

    // Blockquote
    if (line.match(/^>\s?/)) {
      const quoteText = line.replace(/^>\s?/, '')
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `> ${convertInlineFormatting(quoteText)}`,
        },
      })
      i++
      continue
    }

    // Bullet list (- or * at start)
    if (line.match(/^[−-]\s/)) {
      const bulletText = line.replace(/^[−-]\s/, '')
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `• ${convertInlineFormatting(bulletText)}`,
        },
      })
      i++
      continue
    }

    // Numbered list (1. or 1) at start)
    const numberedMatch = line.match(/^(\d+)\.\s/)
    if (numberedMatch) {
      const num = numberedMatch[1]
      const listText = line.replace(/^\d+\.\s/, '')
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${num}. ${convertInlineFormatting(listText)}`,
        },
      })
      i++
      continue
    }

    // Regular text line - check if it's part of a paragraph
    // For now, treat each line as a separate section
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: convertInlineFormatting(line),
      },
    })

    i++
  }

  return blocks
}

function convertInlineFormatting(text: string): string {
  // Process inline formatting
  // Order matters: process code first, then other formatting

  // Inline code: `text`
  text = text.replace(/`([^`]+)`/g, '`$1`')

  // Bold: *text* or **text**
  text = text.replace(/\*([^*]+)\*/g, '*$1*')

  // Italic: _text_ or __text__
  text = text.replace(/_([^_]+)_/g, '_$1_')

  // Strikethrough: ~text~
  text = text.replace(/~([^~]+)~/g, '~$1~')

  // Hyperlinks: <url|text> or <url>
  text = text.replace(/<([^|>]+)(?:|([^>]+))?>/g, '<$1|$2>')

  // URLs (auto-link): http:// or https://
  text = text.replace(/(https?:\/\/[^\s<]+)/g, '<$1>')

  // User mentions: @username (Slack auto-resolves in mrkdwn)
  // We don't need to convert this, Slack handles it

  return text
}

export function formatSecretMessage(secretType: 'text' | 'file', senderName: string, recipientName?: string | null, content?: string): SlackBlock[] {
  const emoji = secretType === 'text' ? '🔒' : '📎'
  const typeLabel = secretType === 'text' ? 'Secret' : 'File'

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
    ...(content ? markdownToSlackBlocks(content) : []),
  ]
}
