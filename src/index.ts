/**
 * Agent main entry point
 */

import { startPlugin } from './plugin.js'

console.log('Starting 0kay Agent...')

startPlugin().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
