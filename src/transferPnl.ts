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
  
  // Get current block number
  const currentBlock = await client.getBlockNumber()
  
  // Try to fetch all logs at once first
  let logs
  try {
    logs = await client.getLogs({
      address: tokenAddress as `0x${string}`,
      event: parseAbiItem(TRANSFER_EVENT),
      fromBlock: 'earliest',
      toBlock: 'latest',
    })
  } catch (error: any) {
    // If we hit a block range limit, fetch in chunks
    if (error.message?.includes('block range') || error.details?.includes('block range')) {
      console.log('Block range limit detected, fetching in chunks...')
      logs = await fetchTransfersInChunks(client, tokenAddress, currentBlock)
    } else {
      throw error
    }
  }

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

const fetchTransfersInChunks = async (
  client: PublicClient,
  tokenAddress: string,
  currentBlock: bigint
): Promise<any[]> => {
  const CHUNK_SIZE = 40000n // Safe chunk size below common limits
  const estimatedStartBlock = currentBlock > 10000000n ? currentBlock - 5000000n : 0n
  const totalBlocks = currentBlock - estimatedStartBlock
  const totalChunks = Number((totalBlocks + CHUNK_SIZE - 1n) / CHUNK_SIZE)
  
  console.log(`\nScanning ${totalBlocks.toLocaleString()} blocks in ${totalChunks} chunks...`)
  console.log(`Block range: ${estimatedStartBlock.toLocaleString()} → ${currentBlock.toLocaleString()}\n`)
  
  const startTime = Date.now()
  
  // Create chunk ranges
  const chunks = Array.from({ length: totalChunks }, (_, i) => {
    const start = estimatedStartBlock + BigInt(i) * CHUNK_SIZE
    const end = start + CHUNK_SIZE - 1n < currentBlock ? start + CHUNK_SIZE - 1n : currentBlock
    return { start, end, index: i }
  })
  
  // Process chunks sequentially to maintain progress display
  const processedChunks = await chunks.reduce(
    async (accPromise, chunk) => {
      const { logs, totalFound, errors } = await accPromise
      const { start, end, index } = chunk
      
      const progress = (((index + 1) / totalChunks) * 100).toFixed(1)
      const elapsed = (Date.now() - startTime) / 1000
      const rate = (index + 1) / elapsed
      const remaining = (totalChunks - index - 1) / rate
      const eta = remaining > 60 ? `${Math.floor(remaining / 60)}m ${Math.floor(remaining % 60)}s` : `${Math.floor(remaining)}s`
      
      const progressBar = '█'.repeat(Math.floor(((index + 1) / totalChunks) * 30)) + 
                         '░'.repeat(30 - Math.floor(((index + 1) / totalChunks) * 30))
      
      process.stdout.write(`\r[${progressBar}] ${progress}% | Chunk ${index + 1}/${totalChunks} | Transfers: ${totalFound.toLocaleString()} | ETA: ${eta}`)
      
      try {
        const chunkLogs = await client.getLogs({
          address: tokenAddress as `0x${string}`,
          event: parseAbiItem(TRANSFER_EVENT),
          fromBlock: start,
          toBlock: end,
        })
        
        return {
          logs: [...logs, ...chunkLogs],
          totalFound: totalFound + chunkLogs.length,
          errors,
        }
      } catch (error) {
        process.stdout.write(`\r[${progressBar}] ${progress}% | Chunk ${index + 1}/${totalChunks} | Transfers: ${totalFound.toLocaleString()} | Errors: ${errors + 1}`)
        return {
          logs,
          totalFound,
          errors: errors + 1,
        }
      }
    },
    Promise.resolve({ logs: [] as any[], totalFound: 0, errors: 0 })
  )
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n✓ Scan complete in ${totalTime}s | Found ${processedChunks.totalFound.toLocaleString()} transfers${processedChunks.errors > 0 ? ` | ${processedChunks.errors} errors` : ''}\n`)
  
  return processedChunks.logs
}

const fetchAllPrices = async (
  client: PublicClient,
  vaultAddress: string,
  transfers: Transfer[],
  decimals: number,
  assetDecimals: number
): Promise<{ priceMap: Map<bigint, bigint>; currentPrice: bigint }> => {
  console.log('Fetching historical prices...')
  const startTime = Date.now()
  
  const bridgePrice = 10n ** BigInt(assetDecimals)
  const erc4626Abi = parseAbi([
    'function convertToAssets(uint256 shares) view returns (uint256)',
  ])
  const oneShare = 10n ** BigInt(decimals)
  
  // Get current price as fallback
  let currentPrice: bigint
  try {
    currentPrice = await client.readContract({
      address: vaultAddress as `0x${string}`,
      abi: erc4626Abi,
      functionName: 'convertToAssets',
      args: [oneShare],
    })
    console.log(`Current price: ${formatUnits(currentPrice, assetDecimals)} assets per share`)
  } catch (error) {
    console.error('Failed to fetch current price:', error)
    // Fallback to 1:1 ratio if current price fetch fails
    currentPrice = oneShare
    console.log(`Using fallback price: ${formatUnits(currentPrice, assetDecimals)} assets per share`)
  }
  
  // Get unique blocks that need prices (excluding bridge mints)
  const uniqueBlocks = [...new Set(
    transfers
      .filter(t => t.type !== 'bridge_mint')
      .map(t => t.blockNumber)
  )]
  
  console.log(`Need to fetch prices for ${uniqueBlocks.length} unique blocks`)
  
  // Create batches
  const batchSize = 100
  const batches = Array.from(
    { length: Math.ceil(uniqueBlocks.length / batchSize) },
    (_, i) => uniqueBlocks.slice(i * batchSize, (i + 1) * batchSize)
  )
  
  // Process all batches and collect results
  const batchResults = await Promise.all(
    batches.map(async (batch, batchIndex) => {
      const contracts = batch.map(blockNumber => ({
        address: vaultAddress as `0x${string}`,
        abi: erc4626Abi,
        functionName: 'convertToAssets' as const,
        args: [oneShare],
        blockNumber,
      }))
      
      try {
        const results = await client.multicall({
          contracts,
          allowFailure: true,
        })
        
        // Log progress
        const processedSoFar = (batchIndex + 1) * batchSize
        if (processedSoFar % 500 === 0 || processedSoFar >= uniqueBlocks.length) {
          console.log(`Fetched historical prices for ${Math.min(processedSoFar, uniqueBlocks.length)}/${uniqueBlocks.length} blocks...`)
        }
        
        return batch.map((blockNumber, index) => {
          const result = results[index]
          if (result.status !== 'success') {
            console.warn(`Failed to fetch price for block ${blockNumber}: ${result.error}`)
          }
          return {
            blockNumber,
            price: result.status === 'success' 
              ? result.result as bigint 
              : currentPrice
          }
        })
      } catch (error) {
        console.warn(`Batch ${batchIndex + 1} failed, using current price as fallback`)
        return batch.map(blockNumber => ({
          blockNumber,
          price: currentPrice
        }))
      }
    })
  )
  
  // Flatten results and create map
  const priceEntries = batchResults
    .flat()
    .map(({ blockNumber, price }) => [blockNumber, price] as const)
  
  // Add bridge mint prices
  const bridgeMintEntries = transfers
    .filter(t => t.type === 'bridge_mint')
    .map(t => [t.blockNumber, bridgePrice] as const)
  
  const priceMap = new Map([...priceEntries, ...bridgeMintEntries])
  
  console.log(`Price fetching completed in ${Date.now() - startTime}ms`)
  return { priceMap, currentPrice }
}

const processUserTransfers = (
  transfers: Transfer[],
  priceMap: Map<bigint, bigint>,
  decimals: number,
  currentPrice: bigint
): Record<string, UserPnL> => {
  console.log('Processing user transfers...')
  const startTime = Date.now()
  
  // Add prices to transfers
  const transfersWithPrices = transfers.map((transfer, index) => {
    // Log progress
    if ((index + 1) % 100 === 0 || index === transfers.length - 1) {
      const progress = (((index + 1) / transfers.length) * 100).toFixed(1)
      const progressBar = '█'.repeat(Math.floor(((index + 1) / transfers.length) * 30)) + 
                         '░'.repeat(30 - Math.floor(((index + 1) / transfers.length) * 30))
      process.stdout.write(`\r[${progressBar}] ${progress}% | ${index + 1}/${transfers.length} transfers`)
    }
    
    const price = priceMap.get(transfer.blockNumber) || currentPrice
    const cost = divide(multiply(transfer.value, price), 10n ** BigInt(decimals))
    
    return { ...transfer, pricePerShare: price, cost }
  })
  
  // Process transfers using reduce
  const userPnLs = transfersWithPrices.reduce((acc, transfer) => {
    const { type, from, to, value, blockNumber, cost } = transfer
    
    const processAcquisition = (user: string, source: Transfer['type']) => {
      const currentUser = acc[user] || createEmptyUserPnL(user)
      return {
        ...currentUser,
        totalAcquired: add(currentUser.totalAcquired, value),
        currentBalance: add(currentUser.currentBalance, value),
        totalCostBasis: add(currentUser.totalCostBasis, cost),
        fifoQueue: [...currentUser.fifoQueue, {
          amount: value,
          costBasis: cost,
          blockNumber,
          source,
        }],
      }
    }
    
    switch (type) {
      case 'mint':
        // Skip mints to the bridge address to avoid double counting
        if (isAddressEqual(to as `0x${string}`, BRIDGE_ADDRESS)) {
          return acc
        }
        return { ...acc, [to]: processAcquisition(to, type) }
        
      case 'bridge_mint':
        return { ...acc, [to]: processAcquisition(to, type) }
        
      case 'burn':
        if (!acc[from]) return acc
        const burnedUser = processDisposal(acc[from], value, cost)
        return { ...acc, [from]: burnedUser }
        
      case 'transfer':
        let result = acc
        
        // Process disposal from sender
        if (result[from]) {
          const disposedUser = processDisposal(result[from], value, cost)
          result = { ...result, [from]: disposedUser }
        }
        
        // Process acquisition by receiver
        result = { ...result, [to]: processAcquisition(to, 'transfer') }
        
        return result
        
      default:
        return acc
    }
  }, {} as Record<string, UserPnL>)
  
  console.log(`\n✓ Transfer processing completed in ${Date.now() - startTime}ms`)
  return userPnLs
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

const processDisposal = (userPnL: UserPnL, amount: bigint, proceeds: bigint): UserPnL => {
  // Don't process disposal if user doesn't have enough balance
  const disposalAmount = userPnL.currentBalance < amount ? userPnL.currentBalance : amount
  if (disposalAmount === ZERO) return userPnL
  
  // Process FIFO queue
  const processedQueue = userPnL.fifoQueue.reduce(
    (acc, entry) => {
      if (acc.remainingAmount === ZERO) {
        return { ...acc, newQueue: [...acc.newQueue, entry] }
      }

      if (entry.amount <= acc.remainingAmount) {
        return {
          remainingAmount: subtract(acc.remainingAmount, entry.amount),
          costBasisForDisposal: add(acc.costBasisForDisposal, entry.costBasis),
          newQueue: acc.newQueue,
        }
      } else {
        // Calculate the proportion of this entry being used
        const costUsed = divide(multiply(entry.costBasis, acc.remainingAmount), entry.amount)
        
        return {
          remainingAmount: ZERO,
          costBasisForDisposal: add(acc.costBasisForDisposal, costUsed),
          newQueue: [...acc.newQueue, {
            amount: subtract(entry.amount, acc.remainingAmount),
            costBasis: subtract(entry.costBasis, costUsed),
            blockNumber: entry.blockNumber,
            source: entry.source,
          }],
        }
      }
    },
    {
      remainingAmount: disposalAmount,
      costBasisForDisposal: ZERO,
      newQueue: [] as FIFOEntry[],
    }
  )

  const realizedGain = subtract(proceeds, processedQueue.costBasisForDisposal)
  
  return {
    ...userPnL,
    totalDisposed: add(userPnL.totalDisposed, disposalAmount),
    currentBalance: subtract(userPnL.currentBalance, disposalAmount),
    fifoQueue: processedQueue.newQueue,
    realizedCostBasis: add(userPnL.realizedCostBasis, processedQueue.costBasisForDisposal),
    realizedPnL: add(userPnL.realizedPnL, realizedGain),
  }
}

const calculateUnrealizedPnL = async (
  userPnLs: Record<string, UserPnL>,
  client: PublicClient,
  vaultAddress: string,
  decimals: number,
  assetDecimals: number
): Promise<void> => {
  console.log('\nCalculating unrealized PnL...')
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

  const users = Object.values(userPnLs)
  let processed = 0

  for (const userPnL of users) {
    processed++
    if (processed % 100 === 0 || processed === users.length) {
      const progress = ((processed / users.length) * 100).toFixed(1)
      process.stdout.write(`\rCalculating PnL for ${processed}/${users.length} users (${progress}%)`)
    }
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
  
  console.log(`\n✓ PnL calculation completed in ${Date.now() - startTime}ms`)
}

const calculateVaultPnL = (
  transfers: Transfer[],
  userPnLs: Record<string, UserPnL>
): VaultPnL => {
  // Calculate transfer totals
  const transferTotals = transfers.reduce(
    (acc, transfer) => {
      switch (transfer.type) {
        case 'mint':
          // Don't count mints to the bridge address
          return !isAddressEqual(transfer.to as `0x${string}`, BRIDGE_ADDRESS)
            ? { ...acc, totalMinted: add(acc.totalMinted, transfer.value) }
            : acc
        case 'burn':
          return { ...acc, totalBurned: add(acc.totalBurned, transfer.value) }
        case 'bridge_mint':
          return { ...acc, totalBridgeMinted: add(acc.totalBridgeMinted, transfer.value) }
        default:
          return acc
      }
    },
    { totalMinted: ZERO, totalBurned: ZERO, totalBridgeMinted: ZERO }
  )

  const { totalMinted, totalBurned, totalBridgeMinted } = transferTotals
  const totalSupply = subtract(add(totalMinted, totalBridgeMinted), totalBurned)
  
  // Calculate user statistics
  const users = Object.values(userPnLs)
  const currentTotalValue = users.reduce(
    (sum, user) => add(sum, user.currentValue),
    ZERO
  )
  const activeUsers = users.filter(u => u.currentBalance > ZERO).length

  return {
    totalSupply,
    totalMinted,
    totalBurned,
    totalBridgeMinted,
    netSupplyChange: totalSupply,
    currentTotalValue,
    totalUsers: users.length,
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
  const args = process.argv.slice(2)
  const config = loadConfig(args)
  const client = createClient(config.rpcUrl, config.chain)

  // Find token address (first non-flag argument)
  const tokenAddress = args.find(arg => !arg.startsWith('--') && arg !== config.chainName)
  if (!tokenAddress) {
    console.error('Usage: npm run transfer-pnl [--chain <chain>] <token-address> [--json]')
    console.error('\nSupported chains: ethereum, optimism, arbitrum, polygon, base, katana')
    console.error('\nExamples:')
    console.error('  npm run transfer-pnl 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37')
    console.error('  npm run transfer-pnl --chain ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
    console.error('  npm run transfer-pnl --chain arbitrum 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8 --json')
    process.exit(1)
  }

  try {
    console.log('\n=== STARTING TRANSFER PNL ANALYSIS ===')
    console.log(`Chain: ${config.chainName}`)
    const totalStartTime = Date.now()
    
    console.log('\nFetching vault info...')
    const vaultInfo = await fetchVaultInfo(client, tokenAddress)
    console.log(`Vault decimals: ${vaultInfo.decimals}, Asset: ${vaultInfo.assetSymbol} (${vaultInfo.assetDecimals} decimals)`)
    
    const transfers = await fetchTransfers(client, tokenAddress)
    
    // Fetch all prices upfront using multicall
    const { priceMap, currentPrice } = await fetchAllPrices(
      client,
      tokenAddress,
      transfers,
      vaultInfo.decimals,
      vaultInfo.assetDecimals
    )
    
    const userPnLs = processUserTransfers(
      transfers,
      priceMap,
      vaultInfo.decimals,
      currentPrice
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
    console.log(`Chain: ${config.chainName}`)
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