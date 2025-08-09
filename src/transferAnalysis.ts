import { type PublicClient, parseAbiItem, formatUnits } from 'viem'
import { loadConfig } from './config'
import { createClient } from './client'

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
}

const categorizeTransfer = (from: string, to: string): Transfer['type'] => {
  if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    return 'mint'
  } else if (to.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    return 'burn'
  } else if (from.toLowerCase() === BRIDGE_ADDRESS.toLowerCase()) {
    return 'bridge_mint'
  }
  return 'transfer'
}

const fetchTransfers = async (
  client: PublicClient,
  tokenAddress: string,
  decimals: number
): Promise<Transfer[]> => {
  console.log(`Fetching transfers for token: ${tokenAddress}`)
  
  const logs = await client.getLogs({
    address: tokenAddress as `0x${string}`,
    event: parseAbiItem(TRANSFER_EVENT),
    fromBlock: 'earliest',
    toBlock: 'latest',
  })

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

  return transfers.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))
}

const analyzeTransfers = (transfers: Transfer[], decimals: number) => {
  const stats = {
    totalMints: 0n,
    totalBurns: 0n,
    totalBridgeMints: 0n,
    mintCount: 0,
    burnCount: 0,
    bridgeMintCount: 0,
    regularTransferCount: 0,
  }

  const categorizedTransfers = {
    mints: [] as Transfer[],
    burns: [] as Transfer[],
    bridgeMints: [] as Transfer[],
    regularTransfers: [] as Transfer[],
  }

  for (const transfer of transfers) {
    switch (transfer.type) {
      case 'mint':
        stats.totalMints += transfer.value
        stats.mintCount++
        categorizedTransfers.mints.push(transfer)
        break
      case 'burn':
        stats.totalBurns += transfer.value
        stats.burnCount++
        categorizedTransfers.burns.push(transfer)
        break
      case 'bridge_mint':
        stats.totalBridgeMints += transfer.value
        stats.bridgeMintCount++
        categorizedTransfers.bridgeMints.push(transfer)
        break
      case 'transfer':
        stats.regularTransferCount++
        categorizedTransfers.regularTransfers.push(transfer)
        break
    }
  }

  return { stats, categorizedTransfers }
}

const formatTransfer = (transfer: Transfer, decimals: number): string => {
  const amount = formatUnits(transfer.value, decimals)
  return `Block ${transfer.blockNumber} | ${transfer.type.padEnd(12)} | ${amount} tokens | ${transfer.from} → ${transfer.to} | ${transfer.transactionHash}`
}

const main = async () => {
  const config = loadConfig()
  const client = createClient(config.rpcUrl)

  const tokenAddress = process.argv[2]
  const decimals = parseInt(process.argv[3] || '18')

  if (!tokenAddress) {
    console.error('Usage: npm run analyze-transfers <token-address> [decimals]')
    console.error('Example: npm run analyze-transfers 0x123...abc 18')
    process.exit(1)
  }

  try {
    const transfers = await fetchTransfers(client, tokenAddress, decimals)
    const { stats, categorizedTransfers } = analyzeTransfers(transfers, decimals)

    console.log('\n=== VAULT TOKEN TRANSFER ANALYSIS ===')
    console.log(`Token Address: ${tokenAddress}`)
    console.log(`Total Transfers: ${transfers.length}`)
    console.log('\n--- Statistics ---')
    console.log(`Mints (from 0x00): ${stats.mintCount} transfers, ${formatUnits(stats.totalMints, decimals)} tokens`)
    console.log(`Burns (to 0x00): ${stats.burnCount} transfers, ${formatUnits(stats.totalBurns, decimals)} tokens`)
    console.log(`Bridge Mints (from ${BRIDGE_ADDRESS}): ${stats.bridgeMintCount} transfers, ${formatUnits(stats.totalBridgeMints, decimals)} tokens`)
    console.log(`Regular Transfers: ${stats.regularTransferCount}`)
    console.log(`\nNet Supply Change: ${formatUnits(stats.totalMints + stats.totalBridgeMints - stats.totalBurns, decimals)} tokens`)

    if (config.isJsonExport) {
      const jsonOutput = {
        tokenAddress,
        decimals,
        summary: {
          totalTransfers: transfers.length,
          mints: {
            count: stats.mintCount,
            total: formatUnits(stats.totalMints, decimals),
          },
          burns: {
            count: stats.burnCount,
            total: formatUnits(stats.totalBurns, decimals),
          },
          bridgeMints: {
            count: stats.bridgeMintCount,
            total: formatUnits(stats.totalBridgeMints, decimals),
          },
          regularTransfers: stats.regularTransferCount,
          netSupplyChange: formatUnits(stats.totalMints + stats.totalBridgeMints - stats.totalBurns, decimals),
        },
        transfers: {
          mints: categorizedTransfers.mints.map(t => ({
            block: t.blockNumber.toString(),
            tx: t.transactionHash,
            to: t.to,
            value: formatUnits(t.value, decimals),
          })),
          burns: categorizedTransfers.burns.map(t => ({
            block: t.blockNumber.toString(),
            tx: t.transactionHash,
            from: t.from,
            value: formatUnits(t.value, decimals),
          })),
          bridgeMints: categorizedTransfers.bridgeMints.map(t => ({
            block: t.blockNumber.toString(),
            tx: t.transactionHash,
            to: t.to,
            value: formatUnits(t.value, decimals),
          })),
        },
      }
      console.log('\n' + JSON.stringify(jsonOutput, null, 2))
    } else {
      console.log('\n--- Mints (from 0x00) ---')
      categorizedTransfers.mints.forEach(t => console.log(formatTransfer(t, decimals)))

      console.log('\n--- Burns (to 0x00) ---')
      categorizedTransfers.burns.forEach(t => console.log(formatTransfer(t, decimals)))

      console.log('\n--- Bridge Mints (from bridge) ---')
      categorizedTransfers.bridgeMints.forEach(t => console.log(formatTransfer(t, decimals)))
    }
  } catch (error) {
    console.error('Error analyzing transfers:', error)
    process.exit(1)
  }
}

main()