import { createPublicClient, http, parseAbiItem, isAddress, parseAbi, type PublicClient, type Log } from 'viem';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { VaultEvent, VaultInfo, UserPosition, PnLResult, JsonExport } from './types';
import { getChainConfig, type ChainName } from './chain';
import {
  formatPnLResult,
  formatEventForJson,
  formatPnLForJson,
  formatSummaryForJson,
  formatEventForConsole,
  formatVaultSummaryForConsole,
  formatTopMoversForConsole,
  exactToSimple
} from './helper';

const validChains = ['ethereum', 'base', 'optimism', 'arbitrum', 'polygon', 'katana'] as const;

const parseChainArg = (args: string[]): ChainName => {
  const chainArgIndex = args.indexOf('--chain');
  
  if (chainArgIndex !== -1) {
    if (chainArgIndex + 1 >= args.length) {
      console.error('Error: --chain requires a chain name');
      console.error(`Valid chains: ${validChains.join(', ')}`);
      process.exit(1);
    }
    
    const chainName = args[chainArgIndex + 1].toLowerCase();
    args.splice(chainArgIndex, 2); // Remove --chain and the chain name
    
    if (!validChains.includes(chainName as any)) {
      console.error(`Error: Invalid chain '${chainName}'`);
      console.error(`Valid chains: ${validChains.join(', ')}`);
      process.exit(1);
    }
    
    return chainName as ChainName;
  }
  
  return 'katana'; // Default chain
};

// Global variables that will be set in main()
let selectedChain: ChainName = 'katana';
let chain: any;
let rpcUrl: string;

const createClient = () => createPublicClient({
  chain,
  transport: http(rpcUrl),
});

const sortEventsByBlock = (events: VaultEvent[]): VaultEvent[] =>
  [...events].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

const calculatePnL = (
  position: UserPosition,
  currentValue: bigint,
  assetDecimals: number,
  vaultDecimals: number
): PnLResult => {
  // If user has shares but no investment (received via transfer), assume cost basis of 1
  const hasOnlyTransferredShares = position.totalAssetsInvested === 0n && position.totalSharesHeld > 0n;
  const effectiveAssetsInvested = hasOnlyTransferredShares ? 1n : position.totalAssetsInvested;
    
  const netInvested = effectiveAssetsInvested - position.totalAssetsWithdrawn;
  const totalValue = currentValue + position.totalAssetsWithdrawn;

  const avgDepositPrice = position.totalSharesDeposited > 0n
    ? exactToSimple(effectiveAssetsInvested, assetDecimals) / exactToSimple(position.totalSharesDeposited, vaultDecimals)
    : 0;

  // For realized PnL calculation
  const costBasisOfWithdrawnShares = position.totalSharesWithdrawn > 0n && position.totalSharesDeposited > 0n
    ? effectiveAssetsInvested * position.totalSharesWithdrawn / position.totalSharesDeposited
    : 0n;
  const realizedPnL = position.totalAssetsWithdrawn - costBasisOfWithdrawnShares;

  // For unrealized PnL calculation
  let costBasisOfRemainingShares: bigint;
  if (position.totalSharesHeld > 0n) {
    if (position.totalSharesDeposited > 0n) {
      // User has deposited - calculate proportional cost basis
      costBasisOfRemainingShares = effectiveAssetsInvested * position.totalSharesHeld / position.totalSharesDeposited;
    } else {
      // User only has transferred shares - assume cost of 1
      costBasisOfRemainingShares = 1n;
    }
  } else {
    costBasisOfRemainingShares = 0n;
  }
  const unrealizedPnL = currentValue - costBasisOfRemainingShares;
  
  // totalPnL should be the sum of realized and unrealized
  const calculatedPnl = realizedPnL + unrealizedPnL;
  
  const pnlPercentage = effectiveAssetsInvested > 0n
    ? (exactToSimple(calculatedPnl, assetDecimals) / exactToSimple(effectiveAssetsInvested, assetDecimals)) * 100
    : currentValue > 0n
    ? 100 * Number(currentValue)  // If they have value but no cost, show massive gain
    : 0;

  return {
    user: position.user,
    totalDeposited: effectiveAssetsInvested,
    totalWithdrawn: position.totalAssetsWithdrawn,
    netInvested,
    currentShares: position.totalSharesHeld,
    currentValue,
    totalValue,
    pnl: calculatedPnl,
    pnlPercentage,
    realizedPnL,
    unrealizedPnL,
    avgDepositPrice,
  };
};

const aggregateUserPositions = (events: VaultEvent[]): Record<string, UserPosition> => {
  return events.reduce((positions, event) => {
    const user = event.user.toLowerCase();
    const existingPosition = positions[user];

    const updatedPosition: UserPosition = existingPosition ? {
      ...existingPosition,
      events: [...existingPosition.events, event],
      totalSharesHeld: event.type === 'deposit' || event.type === 'transfer_in'
        ? existingPosition.totalSharesHeld + event.shares
        : existingPosition.totalSharesHeld - event.shares,
      totalAssetsInvested: event.type === 'deposit'
        ? existingPosition.totalAssetsInvested + event.assets
        : existingPosition.totalAssetsInvested,  // Don't count transfers as investments
      totalAssetsWithdrawn: event.type === 'withdraw'
        ? existingPosition.totalAssetsWithdrawn + event.assets
        : existingPosition.totalAssetsWithdrawn,  // Don't count transfers as withdrawals
      totalSharesDeposited: event.type === 'deposit' || event.type === 'transfer_in'
        ? existingPosition.totalSharesDeposited + event.shares
        : existingPosition.totalSharesDeposited,
      totalSharesWithdrawn: event.type === 'withdraw' || event.type === 'transfer_out'
        ? existingPosition.totalSharesWithdrawn + event.shares
        : existingPosition.totalSharesWithdrawn,
    } : {
      user,
      events: [event],
      totalSharesHeld: event.type === 'deposit' || event.type === 'transfer_in' ? event.shares : -event.shares,
      totalAssetsInvested: event.type === 'deposit' ? event.assets : 0n,  // Only deposits count as investments
      totalAssetsWithdrawn: event.type === 'withdraw' ? event.assets : 0n,  // Only withdrawals count
      totalSharesDeposited: event.type === 'deposit' || event.type === 'transfer_in' ? event.shares : 0n,
      totalSharesWithdrawn: event.type === 'withdraw' || event.type === 'transfer_out' ? event.shares : 0n,
    };

    return { ...positions, [user]: updatedPosition };
  }, {} as Record<string, UserPosition>);
};


const getContractDeploymentBlock = async (client: PublicClient, contractAddress: string): Promise<{ block: bigint, timestamp?: bigint }> => {
  try {
    // Get the contract bytecode to check if it exists
    const bytecode = await client.getBytecode({
      address: contractAddress as `0x${string}`,
    });
    
    if (!bytecode || bytecode === '0x') {
      throw new Error('Contract not found at this address');
    }

    // Binary search to find deployment block
    const currentBlock = await client.getBlockNumber();
    let low = 0n;
    let high = currentBlock;
    let deploymentBlock = 0n;
    
    while (low <= high) {
      const mid = (low + high) / 2n;
      
      try {
        const code = await client.getBytecode({
          address: contractAddress as `0x${string}`,
          blockNumber: mid,
        });
        
        if (code && code !== '0x') {
          // Contract exists at this block, try earlier
          deploymentBlock = mid;
          high = mid - 1n;
        } else {
          // Contract doesn't exist yet, try later
          low = mid + 1n;
        }
      } catch (error) {
        // If we get an error, try a later block
        low = mid + 1n;
      }
    }
    
    // Get the timestamp of the deployment block
    try {
      const block = await client.getBlock({ blockNumber: deploymentBlock });
      return { block: deploymentBlock, timestamp: block.timestamp };
    } catch {
      return { block: deploymentBlock };
    }
  } catch (error) {
    console.warn('Could not determine deployment block, using default fallback');
    // Return a reasonable fallback based on chain
    if (selectedChain === 'ethereum') return { block: 18000000n };
    if (selectedChain === 'base') return { block: 1000000n };
    if (selectedChain === 'optimism') return { block: 100000000n };
    if (selectedChain === 'arbitrum') return { block: 150000000n };
    if (selectedChain === 'polygon') return { block: 40000000n };
    return { block: 0n };
  }
};

const fetchVaultInfo = async (client: PublicClient, vaultAddress: string): Promise<VaultInfo> => {
  const erc4626Abi = parseAbi([
    'function decimals() view returns (uint8)',
    'function asset() view returns (address)',
  ]);

  const erc20Abi = parseAbi([
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);

  const [decimals, assetAddress] = await Promise.all([
    client.readContract({
      address: vaultAddress as `0x${string}`,
      abi: erc4626Abi,
      functionName: 'decimals',
    }),
    client.readContract({
      address: vaultAddress as `0x${string}`,
      abi: erc4626Abi,
      functionName: 'asset',
    }),
  ]);

  const [assetDecimals, assetSymbol] = await Promise.all([
    client.readContract({
      address: assetAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
    client.readContract({
      address: assetAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'symbol',
    }),
  ]);

  return { decimals, assetAddress, assetDecimals, assetSymbol };
};

const fetchVaultEvents = async (
  client: PublicClient,
  vaultAddress: string,
  userAddress?: string
): Promise<{ events: VaultEvent[], deploymentTimestamp?: bigint }> => {
  const depositEventAbi = parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)');
  const withdrawEventAbi = parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)');
  const transferEventAbi = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

  const depositArgs = userAddress ? { owner: userAddress as `0x${string}` } : undefined;
  const withdrawArgs = userAddress ? { owner: userAddress as `0x${string}` } : undefined;

  // Get the deployment block for this vault
  console.log('Finding vault deployment block...');
  let deploymentInfo: { block: bigint, timestamp?: bigint } | undefined;
  let fromBlock: bigint | 'earliest';
  
  if (selectedChain === 'katana') {
    fromBlock = 'earliest' as const;
  } else {
    deploymentInfo = await getContractDeploymentBlock(client, vaultAddress);
    fromBlock = deploymentInfo.block;
    
    if (deploymentInfo.timestamp) {
      const deploymentDate = new Date(Number(deploymentInfo.timestamp) * 1000);
      const formattedDate = deploymentDate.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });
      console.log(`Vault deployed at block ${fromBlock} on ${formattedDate}`);
    } else {
      console.log(`Vault deployed at block ${fromBlock}, searching from there...`);
    }
  }

  // For non-Katana chains, we need to batch requests to avoid RPC limits
  const currentBlock = await client.getBlockNumber();
  const BATCH_SIZE = 10000n; // Query 10k blocks at a time for better reliability
  
  let depositLogs: any[] = [];
  let withdrawLogs: any[] = [];
  let transferLogs: any[] = [];
  
  // Track fetching progress
  const failedRanges: Array<{ start: bigint, end: bigint }> = [];
  const successfulRanges: Array<{ start: bigint, end: bigint }> = [];
  
  if (selectedChain === 'katana') {
    // For Katana, we can use 'earliest' and 'latest'
    [depositLogs, withdrawLogs, transferLogs] = await Promise.all([
      client.getLogs({
        address: vaultAddress as `0x${string}`,
        event: depositEventAbi,
        fromBlock,
        toBlock: 'latest',
        args: depositArgs,
      }),
      client.getLogs({
        address: vaultAddress as `0x${string}`,
        event: withdrawEventAbi,
        fromBlock,
        toBlock: 'latest',
        args: withdrawArgs,
      }),
      client.getLogs({
        address: vaultAddress as `0x${string}`,
        event: transferEventAbi,
        fromBlock,
        toBlock: 'latest',
      }),
    ]);
  } else {
    // For other chains, batch the requests
    const startBlock = fromBlock as bigint;
    const totalBlocks = currentBlock - startBlock;
    let processedBlocks = 0n;
    
    for (let batchStart = startBlock; batchStart <= currentBlock; batchStart += BATCH_SIZE) {
      const batchEnd = batchStart + BATCH_SIZE - 1n > currentBlock ? currentBlock : batchStart + BATCH_SIZE - 1n;
      const progress = ((processedBlocks * 100n) / totalBlocks).toString();
      
      console.log(`Fetching events: ${progress}% complete (blocks ${batchStart} to ${batchEnd})...`);
      
      try {
        const [batchDeposits, batchWithdraws, batchTransfers] = await Promise.all([
          client.getLogs({
            address: vaultAddress as `0x${string}`,
            event: depositEventAbi,
            fromBlock: batchStart,
            toBlock: batchEnd,
            args: depositArgs,
          }),
          client.getLogs({
            address: vaultAddress as `0x${string}`,
            event: withdrawEventAbi,
            fromBlock: batchStart,
            toBlock: batchEnd,
            args: withdrawArgs,
          }),
          client.getLogs({
            address: vaultAddress as `0x${string}`,
            event: transferEventAbi,
            fromBlock: batchStart,
            toBlock: batchEnd,
          }),
        ]);
        
        depositLogs.push(...batchDeposits);
        withdrawLogs.push(...batchWithdraws);
        transferLogs.push(...batchTransfers);
        successfulRanges.push({ start: batchStart, end: batchEnd });
        processedBlocks = batchEnd - startBlock + 1n;
      } catch (error: any) {
        console.warn(`Failed to fetch events for blocks ${batchStart}-${batchEnd}:`, error?.message || error);
        console.warn('Retrying with smaller batch...');
        
        // Try with smaller batches
        const SMALL_BATCH = 1000n;
        let smallBatchProcessed = 0n;
        const smallBatchTotal = batchEnd - batchStart + 1n;
        let anySmallBatchSucceeded = false;
        
        for (let smallStart = batchStart; smallStart <= batchEnd; smallStart += SMALL_BATCH) {
          const smallEnd = smallStart + SMALL_BATCH - 1n > batchEnd ? batchEnd : smallStart + SMALL_BATCH - 1n;
          const smallProgress = ((smallBatchProcessed * 100n) / smallBatchTotal).toString();
          process.stdout.write(`\r  Retry progress: ${smallProgress}% of current batch...`);
          
          try {
            const [smallDeposits, smallWithdraws, smallTransfers] = await Promise.all([
              client.getLogs({
                address: vaultAddress as `0x${string}`,
                event: depositEventAbi,
                fromBlock: smallStart,
                toBlock: smallEnd,
                args: depositArgs,
              }),
              client.getLogs({
                address: vaultAddress as `0x${string}`,
                event: withdrawEventAbi,
                fromBlock: smallStart,
                toBlock: smallEnd,
                args: withdrawArgs,
              }),
              client.getLogs({
                address: vaultAddress as `0x${string}`,
                event: transferEventAbi,
                fromBlock: smallStart,
                toBlock: smallEnd,
              }),
            ]);
            
            depositLogs.push(...smallDeposits);
            withdrawLogs.push(...smallWithdraws);
            transferLogs.push(...smallTransfers);
            successfulRanges.push({ start: smallStart, end: smallEnd });
            anySmallBatchSucceeded = true;
            smallBatchProcessed = smallEnd - batchStart + 1n;
          } catch (smallError) {
            // Track this failed range
            failedRanges.push({ start: smallStart, end: smallEnd });
            console.warn(`\n  Failed to fetch blocks ${smallStart}-${smallEnd} even with small batch`);
            smallBatchProcessed = smallEnd - batchStart + 1n;
          }
        }
        
        if (!anySmallBatchSucceeded) {
          // If no small batches succeeded, track the entire range as failed
          failedRanges.push({ start: batchStart, end: batchEnd });
        }
        
        process.stdout.write('\n'); // New line after retry progress
        processedBlocks = batchEnd - startBlock + 1n;
      }
    }
    console.log('Event fetching complete!');
    
    // Report any failed ranges
    if (failedRanges.length > 0) {
      console.warn(`\n⚠️  WARNING: Failed to fetch events from ${failedRanges.length} block ranges:`);
      failedRanges.forEach(range => {
        console.warn(`  - Blocks ${range.start} to ${range.end}`);
      });
      console.warn('This may result in incomplete data!\n');
    }
  }

  // Deduplicate events using transaction hash + log index
  const uniqueEventIds = new Set<string>();
  const dedupLog = (log: any) => {
    const eventId = `${log.transactionHash}-${log.logIndex}`;
    if (uniqueEventIds.has(eventId)) {
      return false;
    }
    uniqueEventIds.add(eventId);
    return true;
  };
  
  const uniqueDepositLogs = depositLogs.filter(dedupLog);
  const uniqueWithdrawLogs = withdrawLogs.filter(dedupLog);
  const uniqueTransferLogs = transferLogs.filter(dedupLog);
  
  console.log(`Deduplication: ${depositLogs.length - uniqueDepositLogs.length} duplicate deposits removed`);
  console.log(`Deduplication: ${withdrawLogs.length - uniqueWithdrawLogs.length} duplicate withdrawals removed`);
  console.log(`Deduplication: ${transferLogs.length - uniqueTransferLogs.length} duplicate transfers removed`);
  
  const events: VaultEvent[] = [
    ...uniqueDepositLogs.map(log => ({
      type: 'deposit' as const,
      blockNumber: log.blockNumber!,
      transactionHash: log.transactionHash,
      user: log.args.owner!,
      assets: log.args.assets!,
      shares: log.args.shares!,
    })),
    ...uniqueWithdrawLogs.map(log => ({
      type: 'withdraw' as const,
      blockNumber: log.blockNumber!,
      transactionHash: log.transactionHash,
      user: log.args.owner!,
      assets: log.args.assets!,
      shares: log.args.shares!,
    })),
  ];

  if (userAddress) {
    const userLower = userAddress.toLowerCase();
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    
    const relevantTransfers = uniqueTransferLogs.filter(log => {
      const from = log.args.from!.toLowerCase();
      const to = log.args.to!.toLowerCase();
      
      return (to === userLower && from !== zeroAddress && from !== userLower) ||
             (from === userLower && to !== zeroAddress && to !== userLower);
    });

    const transferEvents = relevantTransfers.map(log => {
      const isIncoming = log.args.to!.toLowerCase() === userLower;
      return {
        type: isIncoming ? ('transfer_in' as const) : ('transfer_out' as const),
        blockNumber: log.blockNumber!,
        transactionHash: log.transactionHash,
        user: userLower,
        assets: 0n,
        shares: log.args.value!,
        from: log.args.from!,
        to: log.args.to!,
      };
    });

    events.push(...transferEvents);
  } else {
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    const vaultLower = vaultAddress.toLowerCase();
    
    const userTransfers = uniqueTransferLogs.filter(log => {
      const from = log.args.from!.toLowerCase();
      const to = log.args.to!.toLowerCase();
      
      return from !== zeroAddress && to !== zeroAddress && 
             from !== vaultLower && to !== vaultLower &&
             from !== to;
    });

    const transferEvents = userTransfers.flatMap(log => [
      {
        type: 'transfer_in' as const,
        blockNumber: log.blockNumber!,
        transactionHash: log.transactionHash,
        user: log.args.to!,
        assets: 0n,
        shares: log.args.value!,
        from: log.args.from!,
        to: log.args.to!,
      },
      {
        type: 'transfer_out' as const,
        blockNumber: log.blockNumber!,
        transactionHash: log.transactionHash,
        user: log.args.from!,
        assets: 0n,
        shares: log.args.value!,
        from: log.args.from!,
        to: log.args.to!,
      }
    ]);

    events.push(...transferEvents);
  }

  return { events: sortEventsByBlock(events), deploymentTimestamp: deploymentInfo?.timestamp };
};

const enrichEventsWithPricePerShare = async (
  client: PublicClient,
  vaultAddress: string,
  vaultDecimals: number,
  events: VaultEvent[]
): Promise<VaultEvent[]> => {
  const oneShare = 10n ** BigInt(vaultDecimals);
  const erc4626Abi = parseAbi([
    'function convertToAssets(uint256 shares) view returns (uint256)',
  ]);

  const transferEvents = events.filter(e => e.type === 'transfer_in' || e.type === 'transfer_out');
  const uniqueTransferBlocks = [...new Set(transferEvents.map(e => e.blockNumber))];
  const blockPriceMap: Record<string, bigint> = {};
  
  if (uniqueTransferBlocks.length > 0) {
    const BATCH_SIZE = 20;
    for (let i = 0; i < uniqueTransferBlocks.length; i += BATCH_SIZE) {
      const blockBatch = uniqueTransferBlocks.slice(i, i + BATCH_SIZE);
      
      const results = await Promise.all(
        blockBatch.map(async (blockNumber) => {
          const contracts = [{
            address: vaultAddress as `0x${string}`,
            abi: erc4626Abi,
            functionName: 'convertToAssets',
            args: [oneShare],
          }];

          const result = await client.multicall({
            contracts,
            blockNumber,
            allowFailure: false,
          });

          return { blockNumber, pricePerShare: result[0] };
        })
      );
      
      results.forEach(({ blockNumber, pricePerShare }) => {
        blockPriceMap[blockNumber.toString()] = pricePerShare;
      });
      
      if (i + BATCH_SIZE < uniqueTransferBlocks.length) {
        console.log(`Fetched prices for ${i + BATCH_SIZE} of ${uniqueTransferBlocks.length} transfer blocks...`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  return events.map(event => {
    if (event.type === 'deposit' || event.type === 'withdraw') {
      const pricePerShare = (event.assets * oneShare) / event.shares;
      return {
        ...event,
        pricePerShare,
      };
    }
    
    if (event.type === 'transfer_in' || event.type === 'transfer_out') {
      const pricePerShare = blockPriceMap[event.blockNumber.toString()];
      const assets = (event.shares * pricePerShare) / oneShare;
      
      return {
        ...event,
        assets,
        pricePerShare,
      };
    }
    
    return event;
  });
};

const getCurrentShareValues = async (
  client: PublicClient,
  vaultAddress: string,
  positions: Record<string, UserPosition>
): Promise<Record<string, bigint>> => {
  const erc4626Abi = parseAbi([
    'function convertToAssets(uint256 shares) view returns (uint256)',
  ]);

  const positionEntries = Object.entries(positions);
  const positionsWithShares = positionEntries.filter(([_, position]) => position.totalSharesHeld > 0n);
  const positionsWithoutShares = positionEntries.filter(([_, position]) => position.totalSharesHeld <= 0n);

  const initialValues = positionsWithoutShares.reduce(
    (acc, [user]) => ({ ...acc, [user]: 0n }),
    {} as Record<string, bigint>
  );

  if (positionsWithShares.length === 0) {
    return initialValues;
  }

  const contracts = positionsWithShares.map(([_, position]) => ({
    address: vaultAddress as `0x${string}`,
    abi: erc4626Abi,
    functionName: 'convertToAssets',
    args: [position.totalSharesHeld],
  }));

  const results = await client.multicall({
    contracts,
    allowFailure: false,
  });

  const shareValues = positionsWithShares.reduce(
    (acc, [user], index) => ({ ...acc, [user]: results[index] }),
    {} as Record<string, bigint>
  );

  return { ...initialValues, ...shareValues };
};

const calculateVaultPnL = async (vaultAddress: string, userAddress?: string, exportJson: boolean = false) => {
  if (!isAddress(vaultAddress) || (userAddress && !isAddress(userAddress))) {
    throw new Error('Invalid address provided');
  }

  const client = createClient();

  if (!exportJson) {
    console.log('Chain:', selectedChain);
    console.log('Calculating PnL for:', userAddress || 'All vault users');
    console.log('Vault:', vaultAddress);
    console.log('---\n');
  }

  const vaultInfo = await fetchVaultInfo(client, vaultAddress);
  if (!exportJson) {
    console.log(`Vault decimals: ${vaultInfo.decimals}`);
    console.log(`Asset: ${vaultInfo.assetAddress} (${vaultInfo.assetSymbol})`);
    console.log('---\n');
  }

  const { events, deploymentTimestamp } = await fetchVaultEvents(client, vaultAddress, userAddress);
  const enrichedEvents = await enrichEventsWithPricePerShare(
    client,
    vaultAddress,
    vaultInfo.decimals,
    events
  );

  const positions = aggregateUserPositions(enrichedEvents);
  
  // Count events by type for validation
  const eventCounts = {
    deposits: enrichedEvents.filter(e => e.type === 'deposit').length,
    withdrawals: enrichedEvents.filter(e => e.type === 'withdraw').length,
    transfersIn: enrichedEvents.filter(e => e.type === 'transfer_in').length,
    transfersOut: enrichedEvents.filter(e => e.type === 'transfer_out').length,
  };
  
  if (!exportJson) {
    console.log(`\n=== Event Summary ===`);
    console.log(`Deposits: ${eventCounts.deposits}`);
    console.log(`Withdrawals: ${eventCounts.withdrawals}`);
    console.log(`Transfers In: ${eventCounts.transfersIn}`);
    console.log(`Transfers Out: ${eventCounts.transfersOut}`);
    console.log(`Total Events: ${enrichedEvents.length}`);
  }

  const currentValues = await getCurrentShareValues(client, vaultAddress, positions);

  const results: PnLResult[] = Object.entries(positions).map(([user, position]) => {
    const currentValue = currentValues[user] || 0n;
    return calculatePnL(position, currentValue, vaultInfo.assetDecimals, vaultInfo.decimals);
  });

  const jsonExport: JsonExport = {
    vault: {
      address: vaultAddress,
      asset: vaultInfo.assetAddress,
      assetSymbol: vaultInfo.assetSymbol,
      decimals: vaultInfo.decimals,
    },
    summary: {} as any,
  };

  if (userAddress) {
    const position = positions[userAddress.toLowerCase()];
    if (position && !exportJson) {
      const deposits = position.events.filter(e => e.type === 'deposit').length;
      const withdrawals = position.events.filter(e => e.type === 'withdraw').length;
      const transfersIn = position.events.filter(e => e.type === 'transfer_in').length;
      const transfersOut = position.events.filter(e => e.type === 'transfer_out').length;
      
      console.log(`Found ${deposits} deposits, ${withdrawals} withdrawals, ${transfersIn} transfers in, ${transfersOut} transfers out\n`);

      position.events.map((event, index) =>
        console.log(formatEventForConsole(event, index, vaultInfo))
      );
    }

    if (position && exportJson) {
      jsonExport.events = position.events.map(event => formatEventForJson(event, vaultInfo));
    }
  }

  if (!exportJson) {
    console.log('\n=== PnL Summary ===');
    
    // Validate transfer balance
    if (eventCounts.transfersIn !== eventCounts.transfersOut) {
      console.warn(`⚠️  WARNING: Transfer imbalance detected!`);
      console.warn(`   Transfers In: ${eventCounts.transfersIn}, Transfers Out: ${eventCounts.transfersOut}`);
      console.warn(`   This should not happen in a properly functioning vault\n`);
    }
  }
  
  // Calculate APR if deployment was less than 1 year ago
  let annualizedReturn: number | undefined;
  
  if (deploymentTimestamp) {
    const now = Date.now() / 1000;
    const deploymentTime = Number(deploymentTimestamp);
    const secondsActive = now - deploymentTime;
    const daysActive = secondsActive / 86400;
    
    if (daysActive < 365 && daysActive > 0) {
      // Will be calculated per user or for total below
      if (!exportJson) {
        console.log(`Vault age: ${daysActive.toFixed(1)} days`);
      }
    }
  }

  if (results.length === 1) {
    const result = results[0];
    
    // Calculate APR for single user
    if (deploymentTimestamp && result.pnlPercentage !== 0) {
      const now = Date.now() / 1000;
      const deploymentTime = Number(deploymentTimestamp);
      const secondsActive = now - deploymentTime;
      const daysActive = secondsActive / 86400;
      
      if (daysActive < 365 && daysActive > 0) {
        const yearFraction = daysActive / 365;
        annualizedReturn = result.pnlPercentage / yearFraction;
      }
    }
    
    if (!exportJson) {
      console.log(formatPnLResult(result, vaultInfo.assetSymbol, vaultInfo.assetDecimals, vaultInfo.decimals, annualizedReturn));
    } else {
      jsonExport.summary = formatSummaryForJson(
        { totalDeposited: result.totalDeposited, totalWithdrawn: result.totalWithdrawn, pnl: result.pnl, realizedPnL: result.realizedPnL, unrealizedPnL: result.unrealizedPnL },
        result.netInvested,
        result.currentValue,
        result.totalValue,
        result.pnlPercentage,
        vaultInfo
      );
      jsonExport.users = [formatPnLForJson(result, vaultInfo)];
    }
  } else {
    const totals = results.reduce((acc, result) => ({
      totalDeposited: acc.totalDeposited + result.totalDeposited,
      totalWithdrawn: acc.totalWithdrawn + result.totalWithdrawn,
      totalValue: acc.totalValue,
      pnl: acc.pnl + result.pnl,
      realizedPnL: acc.realizedPnL + result.realizedPnL,
      unrealizedPnL: acc.unrealizedPnL + result.unrealizedPnL,
    }), {
      totalDeposited: 0n,
      totalWithdrawn: 0n,
      totalValue: 0n,
      pnl: 0n,
      realizedPnL: 0n,
      unrealizedPnL: 0n,
    });

    const totalNetInvested = totals.totalDeposited - totals.totalWithdrawn;
    const totalCurrentValue = Object.values(currentValues).reduce((sum, val) => sum + val, 0n);
    const totalValue = totalCurrentValue + totals.totalWithdrawn;
    const totalPnlPercentage = totals.totalDeposited > 0n
      ? (exactToSimple(totals.pnl, vaultInfo.assetDecimals) / exactToSimple(totals.totalDeposited, vaultInfo.assetDecimals)) * 100
      : 0;

    // Calculate APR for vault total
    if (deploymentTimestamp && totalPnlPercentage !== 0) {
      const now = Date.now() / 1000;
      const deploymentTime = Number(deploymentTimestamp);
      const secondsActive = now - deploymentTime;
      const daysActive = secondsActive / 86400;
      
      if (daysActive < 365 && daysActive > 0) {
        const yearFraction = daysActive / 365;
        annualizedReturn = totalPnlPercentage / yearFraction;
      }
    }
    
    if (!exportJson) {
      console.log(formatVaultSummaryForConsole(results, totals, totalNetInvested, totalCurrentValue, totalValue, totalPnlPercentage, vaultInfo, annualizedReturn));

      const sortedByPnl = [...results].sort((a, b) => exactToSimple(b.pnl, vaultInfo.assetDecimals) - exactToSimple(a.pnl, vaultInfo.assetDecimals));
      console.log(formatTopMoversForConsole('Top 5 Gainers', sortedByPnl.slice(0, 5), vaultInfo));
      console.log(formatTopMoversForConsole('Top 5 Losers', sortedByPnl.slice(-5).reverse(), vaultInfo));
    } else {
      jsonExport.summary = formatSummaryForJson(totals, totalNetInvested, totalCurrentValue, totalValue, totalPnlPercentage, vaultInfo, results.length);
      jsonExport.users = results.map(result => formatPnLForJson(result, vaultInfo));
    }
  }

  if (exportJson) {
    const dataDir = 'data';
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir);
    }
    
    const filename = userAddress
      ? `${userAddress.toLowerCase()}-${vaultAddress.toLowerCase()}.json`
      : `${vaultAddress.toLowerCase()}.json`;
    const filepath = join(dataDir, filename);

    writeFileSync(filepath, JSON.stringify(jsonExport, null, 2));
    console.log(`Results saved to: ${filepath}`);
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  
  // Check for help first before modifying args
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun run calculate-pnl.ts [options] <vault_address> [user_address]');
    console.log('\nOptions:');
    console.log('  --chain <name>    Select blockchain (ethereum, base, optimism, arbitrum, polygon, katana)');
    console.log('                    Default: katana');
    console.log('  --json            Export results to JSON file');
    console.log('  --help, -h        Show this help message');
    console.log('\nExamples:');
    console.log('  bun run calculate-pnl.ts 0x123... 0x456...                    # Use default chain (katana)');
    console.log('  bun run calculate-pnl.ts --chain ethereum 0x123... 0x456...');
    console.log('  bun run calculate-pnl.ts --chain base 0x123...');
    console.log('  bun run calculate-pnl.ts --chain polygon --json 0x123...');
    process.exit(0);
  }
  
  // Parse all flags first before checking args
  const isJsonExport = args.includes('--json');
  
  if (isJsonExport) {
    dotenv.config({ quiet: true } as any);
  } else {
    dotenv.config();
  }
  
  // Remove --json flag if present
  const jsonIndex = args.indexOf('--json');
  const exportJson = jsonIndex !== -1;
  if (exportJson) {
    args.splice(jsonIndex, 1);
  }
  
  // Parse and remove --chain flag
  selectedChain = parseChainArg(args);
  
  // Get chain configuration
  const config = getChainConfig(selectedChain);
  chain = config.chain;
  rpcUrl = config.rpcUrl;
  
  if (!rpcUrl && selectedChain === 'katana') {
    console.error('Error: KATANA_RPC_URL environment variable is not set');
    console.error('Please create a .env file with KATANA_RPC_URL=<your-rpc-url>');
    process.exit(1);
  }
  
  // Now check remaining args (should be vault address and optional user address)
  if (args.length === 0 || args.length > 2) {
    console.error('Error: Invalid number of arguments');
    console.error('Usage: bun run calculate-pnl.ts [options] <vault_address> [user_address]');
    console.error('Run with --help for more information');
    process.exit(1);
  }

  try {
    const [vaultAddress, userAddress] = args;
    await calculateVaultPnL(vaultAddress, userAddress, exportJson);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

main();