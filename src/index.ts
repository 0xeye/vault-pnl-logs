import { isAddress } from 'viem'
import { PnLResult } from '../types'
import { createClient } from './client'
import { loadConfig } from './config'
import { fetchVaultEvents } from './events'
import {
  createJsonExport,
  printAllUsersPnL,
  printSingleUserPnL,
  printUserEvents,
  printVaultInfo,
  saveJsonExport,
} from './output'
import { calculatePnL, getCurrentShareValues } from './pnl'
import { aggregateUserPositions } from './positions'
import { divide } from './utils/bigint'
import { fetchVaultInfo } from './vault'

const validateAddresses = (vaultAddress: string, userAddress?: string): void => {
  if (!isAddress(vaultAddress)) {
    throw new Error(`Invalid vault address: ${vaultAddress}`)
  }
  if (userAddress && !isAddress(userAddress)) {
    throw new Error(`Invalid user address: ${userAddress}`)
  }
}

const printHeader = (
  userAddress?: string,
  vaultAddress?: string,
  silent: boolean = false,
): void => {
  if (!silent) {
    console.log('Calculating PnL for:', userAddress || 'All vault users')
    console.log('Vault:', vaultAddress)
    console.log('---\n')
  }
}

export const calculateVaultPnL = async (
  vaultAddress: string,
  userAddress?: string,
  exportJson: boolean = false,
): Promise<void> => {
  validateAddresses(vaultAddress, userAddress)

  const config = loadConfig()
  const client = createClient(config.rpcUrl)

  printHeader(userAddress, vaultAddress, exportJson)

  const vaultInfo = await fetchVaultInfo(client, vaultAddress)
  if (!exportJson) {
    printVaultInfo(vaultInfo)
  }

  const events = await fetchVaultEvents(client, vaultAddress, userAddress).then((events) =>
    events.map((event) => ({
      ...event,
      pricePerShare: divide(event.assets, event.shares),
    })),
  )

  const positions = aggregateUserPositions(events)
  const currentValues = await getCurrentShareValues(client, vaultAddress, positions)

  const results: PnLResult[] = Object.entries(positions).map(([user, position]) => {
    const currentValue = currentValues[user] || 0n
    return calculatePnL(position, currentValue, vaultInfo.assetDecimals, vaultInfo.decimals)
  })

  const userPosition = userAddress ? positions[userAddress.toLowerCase()] : undefined

  if (exportJson) {
    const jsonExport = createJsonExport(
      vaultInfo,
      vaultAddress,
      results,
      currentValues,
      userPosition,
    )
    saveJsonExport(jsonExport, vaultAddress, userAddress)
  } else {
    if (userPosition) {
      printUserEvents(userPosition, vaultInfo)
    }

    if (results.length === 1) {
      printSingleUserPnL(results[0], vaultInfo)
    } else {
      printAllUsersPnL(results, currentValues, vaultInfo)
    }
  }
}

const parseArgs = (
  args: string[],
): { vaultAddress: string; userAddress?: string; exportJson: boolean } => {
  const jsonIndex = args.indexOf('--json')
  const exportJson = jsonIndex !== -1

  if (exportJson) {
    args.splice(jsonIndex, 1)
  }

  if (args.length === 0 || args.length > 2) {
    console.error('Usage: bun run src/index.ts <vault-address> [user-address] [--json]')
    process.exit(1)
  }

  const [vaultAddress, userAddress] = args
  return { vaultAddress, userAddress, exportJson }
}

const main = async (): Promise<void> => {
  try {
    const { vaultAddress, userAddress, exportJson } = parseArgs(process.argv.slice(2))
    await calculateVaultPnL(vaultAddress, userAddress, exportJson)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}
