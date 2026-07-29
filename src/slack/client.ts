import { WebClient } from '@slack/web-api'
import { loadConfig } from '../config'

const config = loadConfig()

export const slackClient = new WebClient(config.SLACK_BOT_TOKEN)
