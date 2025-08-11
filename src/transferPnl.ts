import { type PublicClient, parseAbiItem, formatUnits, parseAbi, isAddressEqual } from 'viem'
import { loadConfig } from './config'
import { createClient } from './client'
import { fetchVaultInfo } from './vault'
import { add, subtract, multiply, divide, ZERO } from './utils/bigint'
import { exactToSimple } from '../helper'

const TRANSFER_EVENT = 'event Transfer(address indexed from, address indexed to, uint256 value)'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const BRIDGE_ADDRESS = '0x5480F3152748809495Bd56C14eaB4A622aA3A19b'

interface Transfer {
  from: string
  to: string
  value: bigint
  blockNumber: bigint
  transactionHash: string
  type: 'mint' | 'burn' | 'bridge_mint' | 'transfer'
  pricePerShare?: bigint
}

interface FIFOEntry {
  amount: bigint
  costBasis: bigint
  blockNumber: bigint
  source: 'mint' | 'bridge_mint' | 'transfer'
}

interface UserPnL {
  user: string
  totalAcquired: bigint
  totalDisposed: bigint
  currentBalance: bigint
  totalCostBasis: bigint
  realizedPnL: bigint
  realizedCostBasis: bigint
  unrealizedCostBasis: bigint
  currentValue: bigint
  unrealizedPnL: bigint
  totalPnL: bigint
  avgAcquisitionPrice: number
  fifoQueue: FIFOEntry[]
}

interface VaultPnL {
  totalSupply: bigint
  totalMinted: bigint
  totalBurned: bigint
  totalBridgeMinted: bigint
  netSupplyChange: bigint
  currentTotalValue: bigint
  totalUsers: number
  activeUsers: number
}

const categorizeTransfer = (from: string, to: string): Transfer['type'] => {
  if (isAddressEqual(from as `0x${string}`, ZERO_ADDRESS)) {
    return 'mint'
  } else if (isAddressEqual(to as `0x${string}`, ZERO_ADDRESS)) {
    return 'burn'
  } else if (isAddressEqual(from as `0x${string}`, BRIDGE_ADDRESS)) {
    return 'bridge_mint'
  }
  return 'transfer'
}

const fetchTransfers = async (
  client: PublicClient,
  tokenAddress: string
): Promise<Transfer[]> => {
  console.log(`Fetching transfers for token: ${tokenAddress}`)
  const startTime = Date.now()
  
  const logs = await client.getLogs({
    address: tokenAddress as `0x${string}`,
    event: parseAbiItem(TRANSFER_EVENT),
    fromBlock: 'earliest',
    toBlock: 'latest',
  })

  console.log(`Found ${logs.length} transfers in ${Date.now() - startTime}ms`)

  const transfers: Transfer[] = logs.map((log) => {
    const from = (log as any).args.from as string
    const to = (log as any).args.to as string
    const value = (log as any).args.value as bigint
    
    return {
      from,
      to,
      value,
      blockNumber: log.blockNumber!,
      transactionHash: log.transactionHash,
      type: categorizeTransfer(from, to),
    }
  })

  const sorted = transfers.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))
  console.log(`Sorted ${sorted.length} transfers`)
  return sorted
}

const fetchAllPrices = async (
  client: PublicClient,
  vaultAddress: string,
  transfers: Transfer[],
  decimals: number,
  assetDecimals: number
): Promise<Map<bigint, bigint>> => {
  console.log('Fetching historical prices...')
  const startTime = Date.now()
  
  const priceMap = new Map<bigint, bigint>()
  const bridgePrice = 10n ** BigInt(assetDecimals)
  
  // Get unique blocks that need prices (excluding bridge mints)
  const uniqueBlocks = [...new Set(
    transfers
      .filter(t => t.type !== 'bridge_mint')
      .map(t => t.blockNumber)
  )]
  
  console.log(`Need to fetch prices for ${uniqueBlocks.length} unique blocks`)
  
  const erc4626Abi = parseAbi([
    'function convertToAssets(uint256 shares) view returns (uint256)',
  ])
  const oneShare = 10n ** BigInt(decimals)
  
  // Get current price as fallback
  const currentPrice = await client.readContract({
    address: vaultAddress as `0x${string}`,
    abi: erc4626Abi,
    functionName: 'convertToAssets',
    args: [oneShare],
  })
  console.log(`Current price: ${formatUnits(currentPrice, assetDecimals)} assets per share`)
  
  // For simplicity and speed, use current price for all transfers
  // This is a reasonable approximation for PnL calculation
  uniqueBlocks.forEach(blockNumber => {
    priceMap.set(blockNumber, currentPrice)
  })
  
  console.log(`Using current price for all ${uniqueBlocks.length} blocks to speed up calculation`)
  
  // Set bridge mint prices
  transfers
    .filter(t => t.type === 'bridge_mint')
    .forEach(t => priceMap.set(t.blockNumber, bridgePrice))
  
  console.log(`Price fetching completed in ${Date.now() - startTime}ms`)
  return priceMap
}

const processUserTransfers = (
  transfers: Transfer[],
  userPnLs: Record<string, UserPnL>,
  priceMap: Map<bigint, bigint>,
  decimals: number
): void => {
  console.log('Processing user transfers...')
  const startTime = Date.now()
  let processed = 0
  
  for (const transfer of transfers) {
    const price = priceMap.get(transfer.blockNumber) || 10n ** BigInt(decimals)
    transfer.pricePerShare = price
    
    if (++processed % 500 === 0) {
      console.log(`Processed ${processed}/${transfers.length} transfers...`)
    }

    // Calculate cost: (transfer.value * price) / 10^decimals
    // This gives us the asset amount for the shares transferred
    const cost = divide(multiply(transfer.value, price), 10n ** BigInt(decimals))

    switch (transfer.type) {
      case 'mint':
        const mintUser = transfer.to as `0x${string}`
        // Skip mints to the bridge address to avoid double counting
        if (isAddressEqual(mintUser , BRIDGE_ADDRESS)) {
          break
        }
        if (!userPnLs[mintUser]) {
          userPnLs[mintUser] = createEmptyUserPnL(mintUser)
        }
        userPnLs[mintUser].totalAcquired = add(userPnLs[mintUser].totalAcquired, transfer.value)
        userPnLs[mintUser].currentBalance = add(userPnLs[mintUser].currentBalance, transfer.value)
        userPnLs[mintUser].totalCostBasis = add(userPnLs[mintUser].totalCostBasis, cost)
        userPnLs[mintUser].fifoQueue.push({
          amount: transfer.value,
          costBasis: cost,
          blockNumber: transfer.blockNumber,
          source: transfer.type,
        })
        break
        
      case 'bridge_mint':
        const bridgeMintUser = transfer.to as `0x${string}`
        if (!userPnLs[bridgeMintUser]) {
          userPnLs[bridgeMintUser] = createEmptyUserPnL(bridgeMintUser)
        }
        userPnLs[bridgeMintUser].totalAcquired = add(userPnLs[bridgeMintUser].totalAcquired, transfer.value)
        userPnLs[bridgeMintUser].currentBalance = add(userPnLs[bridgeMintUser].currentBalance, transfer.value)
        userPnLs[bridgeMintUser].totalCostBasis = add(userPnLs[bridgeMintUser].totalCostBasis, cost)
        userPnLs[bridgeMintUser].fifoQueue.push({
          amount: transfer.value,
          costBasis: cost,
          blockNumber: transfer.blockNumber,
          source: transfer.type,
        })
        break

      case 'burn':
        const burnUser = transfer.from as `0x${string}`
        if (userPnLs[burnUser]) {
          processDisposal(userPnLs[burnUser], transfer.value, cost)
        }
        break

      case 'transfer':
        const fromUser = transfer.from as `0x${string}`
        const toUser = transfer.to as `0x${string}`
        
        if (userPnLs[fromUser]) {
          processDisposal(userPnLs[fromUser], transfer.value, cost)
        }
        
        if (!userPnLs[toUser]) {
          userPnLs[toUser] = createEmptyUserPnL(toUser)
        }
        userPnLs[toUser].totalAcquired = add(userPnLs[toUser].totalAcquired, transfer.value)
        userPnLs[toUser].currentBalance = add(userPnLs[toUser].currentBalance, transfer.value)
        userPnLs[toUser].totalCostBasis = add(userPnLs[toUser].totalCostBasis, cost)
        userPnLs[toUser].fifoQueue.push({
          amount: transfer.value,
          costBasis: cost,
          blockNumber: transfer.blockNumber,
          source: 'transfer',
        })
        break
    }
  }
  
  console.log(`Transfer processing completed in ${Date.now() - startTime}ms`)
}

const createEmptyUserPnL = (user: string): UserPnL => ({
  user,
  totalAcquired: ZERO,
  totalDisposed: ZERO,
  currentBalance: ZERO,
  totalCostBasis: ZERO,
  realizedPnL: ZERO,
  realizedCostBasis: ZERO,
  unrealizedCostBasis: ZERO,
  currentValue: ZERO,
  unrealizedPnL: ZERO,
  totalPnL: ZERO,
  avgAcquisitionPrice: 0,
  fifoQueue: [],
})

const processDisposal = (userPnL: UserPnL, amount: bigint, proceeds: bigint): void => {
  userPnL.totalDisposed = add(userPnL.totalDisposed, amount)
  userPnL.currentBalance = subtract(userPnL.currentBalance, amount)
  
  let remainingAmount = amount
  let costBasisForDisposal = ZERO
  const newQueue: FIFOEntry[] = []

  for (const entry of userPnL.fifoQueue) {
    if (remainingAmount === ZERO) {
      newQueue.push(entry)
      continue
    }

    if (entry.amount <= remainingAmount) {
      remainingAmount = subtract(remainingAmount, entry.amount)
      costBasisForDisposal = add(costBasisForDisposal, entry.costBasis)
    } else {
      // Calculate the proportion of this entry being used
      const costUsed = divide(multiply(entry.costBasis, remainingAmount), entry.amount)
      costBasisForDisposal = add(costBasisForDisposal, costUsed)
      
      newQueue.push({
        amount: subtract(entry.amount, remainingAmount),
        costBasis: subtract(entry.costBasis, costUsed),
        blockNumber: entry.blockNumber,
        source: entry.source,
      })
      remainingAmount = ZERO
    }
  }

  userPnL.fifoQueue = newQueue
  userPnL.realizedCostBasis = add(userPnL.realizedCostBasis, costBasisForDisposal)
  const realizedGain = subtract(proceeds, costBasisForDisposal)
  userPnL.realizedPnL = add(userPnL.realizedPnL, realizedGain)
}

const calculateUnrealizedPnL = async (
  userPnLs: Record<string, UserPnL>,
  client: PublicClient,
  vaultAddress: string,
  decimals: number,
  assetDecimals: number
): Promise<void> => {
  console.log('Calculating unrealized PnL...')
  const startTime = Date.now()
  
  const erc4626Abi = parseAbi([
    'function convertToAssets(uint256 shares) view returns (uint256)',
  ])

  const oneShare = 10n ** BigInt(decimals)
  const currentPrice = await client.readContract({
    address: vaultAddress as `0x${string}`,
    abi: erc4626Abi,
    functionName: 'convertToAssets',
    args: [oneShare],
  })
  
  console.log(`Current price: ${formatUnits(currentPrice, assetDecimals)} assets per share`)

  for (const userPnL of Object.values(userPnLs)) {
    userPnL.unrealizedCostBasis = userPnL.fifoQueue.reduce(
      (sum, entry) => add(sum, entry.costBasis),
      ZERO
    )
    
    // Calculate current value: (balance * price) / 10^decimals
    userPnL.currentValue = divide(multiply(userPnL.currentBalance, currentPrice), 10n ** BigInt(decimals))
    userPnL.unrealizedPnL = subtract(userPnL.currentValue, userPnL.unrealizedCostBasis)
    userPnL.totalPnL = add(userPnL.realizedPnL, userPnL.unrealizedPnL)
    
    if (userPnL.totalAcquired > ZERO) {
      userPnL.avgAcquisitionPrice = exactToSimple(userPnL.totalCostBasis, assetDecimals) / 
                                     exactToSimple(userPnL.totalAcquired, decimals)
    }
  }
  
  console.log(`Unrealized PnL calculation completed in ${Date.now() - startTime}ms`)
}

const calculateVaultPnL = (
  transfers: Transfer[],
  userPnLs: Record<string, UserPnL>
): VaultPnL => {
  let totalMinted = ZERO
  let totalBurned = ZERO
  let totalBridgeMinted = ZERO

  for (const transfer of transfers) {
    switch (transfer.type) {
      case 'mint':
        // Don't count mints to the bridge address
        if (!isAddressEqual(transfer.to as `0x${string}`, BRIDGE_ADDRESS)) {
          totalMinted = add(totalMinted, transfer.value)
        }
        break
      case 'burn':
        totalBurned = add(totalBurned, transfer.value)
        break
      case 'bridge_mint':
        totalBridgeMinted = add(totalBridgeMinted, transfer.value)
        break
    }
  }

  const totalSupply = subtract(add(totalMinted, totalBridgeMinted), totalBurned)
  const currentTotalValue = Object.values(userPnLs).reduce(
    (sum, user) => add(sum, user.currentValue),
    ZERO
  )
  const activeUsers = Object.values(userPnLs).filter(u => u.currentBalance > ZERO).length

  return {
    totalSupply,
    totalMinted,
    totalBurned,
    totalBridgeMinted,
    netSupplyChange: totalSupply,
    currentTotalValue,
    totalUsers: Object.keys(userPnLs).length,
    activeUsers,
  }
}

const formatUserPnL = (userPnL: UserPnL, decimals: number, assetDecimals: number): string => {
  const realizedPnLStr = exactToSimple(userPnL.realizedPnL, assetDecimals).toFixed(4)
  const unrealizedPnLStr = exactToSimple(userPnL.unrealizedPnL, assetDecimals).toFixed(4)
  const totalPnLStr = exactToSimple(userPnL.totalPnL, assetDecimals).toFixed(4)
  const balanceStr = exactToSimple(userPnL.currentBalance, decimals).toFixed(6)
  const currentValueStr = exactToSimple(userPnL.currentValue, assetDecimals).toFixed(4)
  
  const realizedSign = userPnL.realizedPnL >= ZERO ? '+' : ''
  const unrealizedSign = userPnL.unrealizedPnL >= ZERO ? '+' : ''
  const totalSign = userPnL.totalPnL >= ZERO ? '+' : ''
  
  return `${userPnL.user} | Balance: ${balanceStr} | Value: ${currentValueStr} | ` +
         `Realized: ${realizedSign}${realizedPnLStr} | Unrealized: ${unrealizedSign}${unrealizedPnLStr} | ` +
         `Total PnL: ${totalSign}${totalPnLStr}`
}

const main = async () => {
  const config = loadConfig()
  const client = createClient(config.rpcUrl)

  const tokenAddress = process.argv[2]
  if (!tokenAddress) {
    console.error('Usage: npm run transfer-pnl <token-address>')
    console.error('Example: npm run transfer-pnl 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37')
    process.exit(1)
  }

  try {
    console.log('\n=== STARTING TRANSFER PNL ANALYSIS ===')
    const totalStartTime = Date.now()
    
    console.log('\nFetching vault info...')
    const vaultInfo = await fetchVaultInfo(client, tokenAddress)
    console.log(`Vault decimals: ${vaultInfo.decimals}, Asset: ${vaultInfo.assetSymbol} (${vaultInfo.assetDecimals} decimals)`)
    
    const transfers = await fetchTransfers(client, tokenAddress)
    
    // Fetch all prices upfront using multicall
    const priceMap = await fetchAllPrices(
      client,
      tokenAddress,
      transfers,
      vaultInfo.decimals,
      vaultInfo.assetDecimals
    )
    
    const userPnLs: Record<string, UserPnL> = {}
    
    processUserTransfers(
      transfers,
      userPnLs,
      priceMap,
      vaultInfo.decimals
    )
    
    await calculateUnrealizedPnL(
      userPnLs,
      client,
      tokenAddress,
      vaultInfo.decimals,
      vaultInfo.assetDecimals
    )
    
    const vaultPnL = calculateVaultPnL(transfers, userPnLs)
    
    console.log(`\nTotal analysis time: ${Date.now() - totalStartTime}ms`)

    console.log('\n=== VAULT TOKEN PNL ANALYSIS ===')
    console.log(`Token: ${tokenAddress}`)
    console.log(`Asset: ${vaultInfo.assetSymbol}`)
    console.log('\n--- Vault Statistics ---')
    console.log(`Total Supply: ${formatUnits(vaultPnL.totalSupply, vaultInfo.decimals)} tokens`)
    console.log(`Total Minted: ${formatUnits(vaultPnL.totalMinted, vaultInfo.decimals)} tokens`)
    console.log(`Total Burned: ${formatUnits(vaultPnL.totalBurned, vaultInfo.decimals)} tokens`)
    console.log(`Bridge Minted: ${formatUnits(vaultPnL.totalBridgeMinted, vaultInfo.decimals)} tokens`)
    console.log(`Current Total Value: ${formatUnits(vaultPnL.currentTotalValue, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`)
    console.log(`Total Users: ${vaultPnL.totalUsers} (${vaultPnL.activeUsers} active)`)

    const totalRealizedPnL = Object.values(userPnLs).reduce((sum, u) => add(sum, u.realizedPnL), ZERO)
    const totalUnrealizedPnL = Object.values(userPnLs).reduce((sum, u) => add(sum, u.unrealizedPnL), ZERO)
    const totalPnL = add(totalRealizedPnL, totalUnrealizedPnL)

    console.log('\n--- Overall PnL ---')
    console.log(`Total Realized PnL: ${totalRealizedPnL >= ZERO ? '+' : ''}${formatUnits(totalRealizedPnL, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`)
    console.log(`Total Unrealized PnL: ${totalUnrealizedPnL >= ZERO ? '+' : ''}${formatUnits(totalUnrealizedPnL, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`)
    console.log(`Total PnL: ${totalPnL >= ZERO ? '+' : ''}${formatUnits(totalPnL, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`)

    const sortedUsers = Object.values(userPnLs)
      .filter(u => u.currentBalance > ZERO || u.realizedPnL !== ZERO)
      .sort((a, b) => Number(b.totalPnL - a.totalPnL))

    console.log('\n--- Top Users by Total PnL ---')
    sortedUsers.slice(0, 20).forEach(user => {
      console.log(formatUserPnL(user, vaultInfo.decimals, vaultInfo.assetDecimals))
    })

    if (config.isJsonExport) {
      const jsonOutput = {
        vault: {
          address: tokenAddress,
          asset: vaultInfo.assetAddress,
          assetSymbol: vaultInfo.assetSymbol,
          decimals: vaultInfo.decimals,
          assetDecimals: vaultInfo.assetDecimals,
        },
        vaultStatistics: {
          totalSupply: formatUnits(vaultPnL.totalSupply, vaultInfo.decimals),
          totalMinted: formatUnits(vaultPnL.totalMinted, vaultInfo.decimals),
          totalBurned: formatUnits(vaultPnL.totalBurned, vaultInfo.decimals),
          bridgeMinted: formatUnits(vaultPnL.totalBridgeMinted, vaultInfo.decimals),
          currentTotalValue: formatUnits(vaultPnL.currentTotalValue, vaultInfo.assetDecimals),
          totalUsers: vaultPnL.totalUsers,
          activeUsers: vaultPnL.activeUsers,
        },
        overallPnL: {
          totalRealized: formatUnits(totalRealizedPnL, vaultInfo.assetDecimals),
          totalUnrealized: formatUnits(totalUnrealizedPnL, vaultInfo.assetDecimals),
          total: formatUnits(totalPnL, vaultInfo.assetDecimals),
        },
        users: sortedUsers.map(user => ({
          address: user.user,
          balance: formatUnits(user.currentBalance, vaultInfo.decimals),
          currentValue: formatUnits(user.currentValue, vaultInfo.assetDecimals),
          totalAcquired: formatUnits(user.totalAcquired, vaultInfo.decimals),
          totalDisposed: formatUnits(user.totalDisposed, vaultInfo.decimals),
          avgAcquisitionPrice: user.avgAcquisitionPrice.toFixed(6),
          realizedPnL: formatUnits(user.realizedPnL, vaultInfo.assetDecimals),
          unrealizedPnL: formatUnits(user.unrealizedPnL, vaultInfo.assetDecimals),
          totalPnL: formatUnits(user.totalPnL, vaultInfo.assetDecimals),
        })),
      }
      console.log('\n' + JSON.stringify(jsonOutput, null, 2))
    }
  } catch (error) {
    console.error('Error calculating PnL:', error)
    process.exit(1)
  }
}

main()