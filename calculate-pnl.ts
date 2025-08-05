import { createPublicClient, http, parseAbiItem, isAddress, parseAbi, type PublicClient, type Log } from 'viem';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { VaultEvent, VaultInfo, UserPosition, PnLResult, JsonExport } from './types';
import { katanaChain } from './chain';
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

const args = process.argv.slice(2);
const isJsonExport = args.includes('--json');

if (isJsonExport) {
  dotenv.config({ quiet: true } as any);
} else {
  dotenv.config();
}

const KATANA_RPC = process.env.KATANA_RPC_URL;

if (!KATANA_RPC) {
  console.error('Error: KATANA_RPC_URL environment variable is not set');
  console.error('Please create a .env file with KATANA_RPC_URL=<your-rpc-url>');
  process.exit(1);
}

const createClient = () => createPublicClient({
  chain: katanaChain,
  transport: http(KATANA_RPC),
});

const sortEventsByBlock = (events: VaultEvent[]): VaultEvent[] =>
  [...events].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

const calculatePnL = (
  position: UserPosition,
  currentValue: bigint,
  assetDecimals: number,
  vaultDecimals: number
): PnLResult => {
  const netInvested = position.totalAssetsInvested - position.totalAssetsWithdrawn;
  const totalValue = currentValue + position.totalAssetsWithdrawn;

  const avgDepositPrice = position.totalSharesDeposited > 0n
    ? exactToSimple(position.totalAssetsInvested, assetDecimals) / exactToSimple(position.totalSharesDeposited, vaultDecimals)
    : 0;

  const costBasisOfWithdrawnShares = position.totalSharesWithdrawn > 0n && position.totalSharesDeposited > 0n
    ? position.totalAssetsInvested * position.totalSharesWithdrawn / position.totalSharesDeposited
    : 0n;
  const realizedPnL = position.totalAssetsWithdrawn - costBasisOfWithdrawnShares;

  const costBasisOfRemainingShares = position.totalSharesHeld > 0n && position.totalSharesDeposited > 0n
    ? position.totalAssetsInvested * position.totalSharesHeld / position.totalSharesDeposited
    : 0n;
  const unrealizedPnL = currentValue - costBasisOfRemainingShares;
  
  // totalPnL should be the sum of realized and unrealized
  const calculatedPnl = realizedPnL + unrealizedPnL;
  
  const pnlPercentage = position.totalAssetsInvested > 0n
    ? (exactToSimple(calculatedPnl, assetDecimals) / exactToSimple(position.totalAssetsInvested, assetDecimals)) * 100
    : 0;

  return {
    user: position.user,
    totalDeposited: position.totalAssetsInvested,
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
      totalAssetsInvested: event.type === 'deposit' || event.type === 'transfer_in'
        ? existingPosition.totalAssetsInvested + event.assets
        : existingPosition.totalAssetsInvested,
      totalAssetsWithdrawn: event.type === 'withdraw' || event.type === 'transfer_out'
        ? existingPosition.totalAssetsWithdrawn + event.assets
        : existingPosition.totalAssetsWithdrawn,
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
      totalAssetsInvested: event.type === 'deposit' || event.type === 'transfer_in' ? event.assets : 0n,
      totalAssetsWithdrawn: event.type === 'withdraw' || event.type === 'transfer_out' ? event.assets : 0n,
      totalSharesDeposited: event.type === 'deposit' || event.type === 'transfer_in' ? event.shares : 0n,
      totalSharesWithdrawn: event.type === 'withdraw' || event.type === 'transfer_out' ? event.shares : 0n,
    };

    return { ...positions, [user]: updatedPosition };
  }, {} as Record<string, UserPosition>);
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
): Promise<VaultEvent[]> => {
  const depositEventAbi = parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)');
  const withdrawEventAbi = parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)');
  const transferEventAbi = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

  const depositArgs = userAddress ? { owner: userAddress as `0x${string}` } : undefined;
  const withdrawArgs = userAddress ? { owner: userAddress as `0x${string}` } : undefined;

  const [depositLogs, withdrawLogs, transferLogs] = await Promise.all([
    client.getLogs({
      address: vaultAddress as `0x${string}`,
      event: depositEventAbi,
      fromBlock: 'earliest',
      toBlock: 'latest',
      args: depositArgs,
    }),
    client.getLogs({
      address: vaultAddress as `0x${string}`,
      event: withdrawEventAbi,
      fromBlock: 'earliest',
      toBlock: 'latest',
      args: withdrawArgs,
    }),
    client.getLogs({
      address: vaultAddress as `0x${string}`,
      event: transferEventAbi,
      fromBlock: 'earliest',
      toBlock: 'latest',
    }),
  ]);

  const events: VaultEvent[] = [
    ...depositLogs.map(log => ({
      type: 'deposit' as const,
      blockNumber: log.blockNumber!,
      transactionHash: log.transactionHash,
      user: log.args.owner!,
      assets: log.args.assets!,
      shares: log.args.shares!,
    })),
    ...withdrawLogs.map(log => ({
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
    
    const relevantTransfers = transferLogs.filter(log => {
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
    
    const userTransfers = transferLogs.filter(log => {
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

  return sortEventsByBlock(events);
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

  const events = await fetchVaultEvents(client, vaultAddress, userAddress);
  const enrichedEvents = await enrichEventsWithPricePerShare(
    client,
    vaultAddress,
    vaultInfo.decimals,
    events
  );

  const positions = aggregateUserPositions(enrichedEvents);

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
  }

  if (results.length === 1) {
    const result = results[0];
    if (!exportJson) {
      console.log(formatPnLResult(result, vaultInfo.assetSymbol, vaultInfo.assetDecimals, vaultInfo.decimals));
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

    if (!exportJson) {
      console.log(formatVaultSummaryForConsole(results, totals, totalNetInvested, totalCurrentValue, totalValue, totalPnlPercentage, vaultInfo));

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
  const jsonIndex = args.indexOf('--json');
  const exportJson = jsonIndex !== -1;

  if (exportJson) {
    args.splice(jsonIndex, 1);
  }

  if (args.length === 0 || args.length > 2) {
    console.error('Misconfigured usage, see README');
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