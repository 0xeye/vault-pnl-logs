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
    const { user: _user, shares, assets, type } = event;
    const user = _user.toLowerCase();
    const existingPosition = positions[user];

    const updatedPosition: UserPosition = existingPosition ? {
      ...existingPosition,
      events: [...existingPosition.events, event],
      totalSharesHeld: type === 'deposit'
        ? existingPosition.totalSharesHeld + shares
        : existingPosition.totalSharesHeld - shares,
      totalAssetsInvested: type === 'deposit'
        ? existingPosition.totalAssetsInvested + assets
        : existingPosition.totalAssetsInvested,
      totalAssetsWithdrawn: type === 'withdraw'
        ? existingPosition.totalAssetsWithdrawn + assets
        : existingPosition.totalAssetsWithdrawn,
      totalSharesDeposited: type === 'deposit'
        ? existingPosition.totalSharesDeposited + shares
        : existingPosition.totalSharesDeposited,
      totalSharesWithdrawn: type === 'withdraw'
        ? existingPosition.totalSharesWithdrawn + shares
        : existingPosition.totalSharesWithdrawn,
    } : {
      user,
      events: [event],
      totalSharesHeld: type === 'deposit' ? shares : -shares,
      totalAssetsInvested: type === 'deposit' ? assets : 0n,
      totalAssetsWithdrawn: type === 'withdraw' ? assets : 0n,
      totalSharesDeposited: type === 'deposit' ? shares : 0n,
      totalSharesWithdrawn: type === 'withdraw' ? shares : 0n,
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

  const depositArgs = userAddress ? { owner: userAddress as `0x${string}` } : undefined;
  const withdrawArgs = userAddress ? { owner: userAddress as `0x${string}` } : undefined;

  const [depositLogs, withdrawLogs] = await Promise.all([
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


  return sortEventsByBlock(events);
};

const enrichEventsWithPricePerShare = async (
  client: PublicClient,
  vaultAddress: string,
  vaultDecimals: number,
  events: VaultEvent[]
): Promise<VaultEvent[]> => {
  const oneShare = 10n ** BigInt(vaultDecimals);

  return events.map(event => {
    const pricePerShare = (event.assets * oneShare) / event.shares;
    return {
      ...event,
      pricePerShare,
    };
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

      console.log(`Found ${deposits} deposits, ${withdrawals} withdrawals\n`);

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