import { detectForumPlatform } from './platform'

const platform = detectForumPlatform()
console.log(`[ThreadWeaver] forum platform: ${platform} (${location.host})`)
