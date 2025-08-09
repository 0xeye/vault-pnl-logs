import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { loadConfig } from './config';
import { fetchVaultInfo } from './vault';
import { createClient } from './client';
import { fetchVaultEvents } from './events';

const erc4626Abi = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]);

const AVERAGE_BLOCK_TIME = 2; // seconds per block on Katana

async function findFirstDepositBlock(
  client: ReturnType<typeof createPublicClient>,
  vaultAddress: string
): Promise<bigint> {
  const events = await fetchVaultEvents(client, vaultAddress);
  const depositEvents = events.filter(e => e.type === 'deposit');
  
  if (depositEvents.length === 0) {
    throw new Error('No deposits found in vault history');
  }
  
  return depositEvents[0].blockNumber;
}

function parseTimePeriod(period: string): number {
  const match = period.match(/^(\d+)([hdwmy])$/);
  if (!match) {
    throw new Error('Invalid time period format. Use: 1h, 1d, 1w, 1m, 3m, 6m, 1y');
  }

  const [, value, unit] = match;
  const num = parseInt(value);

  const secondsPerUnit = {
    h: 3600,
    d: 86400,
    w: 604800,
    m: 2592000, // 30 days
    y: 31536000,
  };

  return (num * secondsPerUnit[unit as keyof typeof secondsPerUnit]) / AVERAGE_BLOCK_TIME;
}

async function getBlockFromTimePeriod(
  client: ReturnType<typeof createPublicClient>,
  period: string
): Promise<bigint> {
  const blocksAgo = parseTimePeriod(period);
  const currentBlock = await client.getBlockNumber();
  return currentBlock - BigInt(Math.floor(blocksAgo));
}

interface VaultSnapshot {
  blockNumber: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  assetsPerShare: number;
}

async function getVaultSnapshot(
  client: ReturnType<typeof createPublicClient>,
  vaultAddress: string,
  blockNumber?: bigint
): Promise<VaultSnapshot> {
  const [totalAssets, totalSupply] = await Promise.all([
    client.readContract({
      address: vaultAddress as `0x${string}`,
      abi: erc4626Abi,
      functionName: 'totalAssets',
      blockNumber,
    }),
    client.readContract({
      address: vaultAddress as `0x${string}`,
      abi: erc4626Abi,
      functionName: 'totalSupply',
      blockNumber,
    }),
  ]);

  const assetsPerShare = totalSupply > 0n 
    ? Number(totalAssets) / Number(totalSupply)
    : 0;

  return {
    blockNumber: blockNumber || await client.getBlockNumber(),
    totalAssets,
    totalSupply,
    assetsPerShare,
  };
}

function calculateGrowth(
  initialSnapshot: VaultSnapshot,
  currentSnapshot: VaultSnapshot,
  decimals: number
): {
  assetGrowth: bigint;
  growthRate: number;
  growthPercentage: number;
} {
  const assetGrowth = initialSnapshot.totalSupply > 0n
    ? (currentSnapshot.assetsPerShare - initialSnapshot.assetsPerShare) * Number(initialSnapshot.totalSupply)
    : 0;

  const growthRate = initialSnapshot.assetsPerShare > 0
    ? (currentSnapshot.assetsPerShare - initialSnapshot.assetsPerShare) / initialSnapshot.assetsPerShare
    : 0;

  return {
    assetGrowth: BigInt(Math.floor(assetGrowth)),
    growthRate,
    growthPercentage: growthRate * 100,
  };
}

async function main() {
  const args = process.argv.slice(2);
  
  const vaultAddress = args.find((_, i) => args[i - 1] === '--vault');
  const fromBlockArg = args.find((_, i) => args[i - 1] === '--from-block');
  const toBlockArg = args.find((_, i) => args[i - 1] === '--to-block');
  const periodArg = args.find((_, i) => args[i - 1] === '--period');

  if (!vaultAddress) {
    console.error('Error: --vault <address> is required');
    console.error('\nUsage:');
    console.error('  bun run asset-growth --vault <address>                    # From first deposit to latest');
    console.error('  bun run asset-growth --vault <address> --period 1m        # Last month');
    console.error('  bun run asset-growth --vault <address> --from-block 1000  # From specific block');
    process.exit(1);
  }

  const config = loadConfig();
  const client = createClient(config.rpcUrl);

  const vaultInfo = await fetchVaultInfo(client, vaultAddress);
  
  let fromBlock: bigint;
  let toBlock: bigint | undefined;

  if (periodArg) {
    fromBlock = await getBlockFromTimePeriod(client, periodArg);
    toBlock = await client.getBlockNumber();
  } else if (fromBlockArg) {
    fromBlock = BigInt(fromBlockArg);
    toBlock = toBlockArg ? BigInt(toBlockArg) : undefined;
  } else {
    console.log('Detecting first deposit block...');
    fromBlock = await findFirstDepositBlock(client, vaultAddress);
    toBlock = undefined;
  }

  const [initialSnapshot, currentSnapshot] = await Promise.all([
    getVaultSnapshot(client, vaultAddress, fromBlock),
    getVaultSnapshot(client, vaultAddress, toBlock),
  ]);

  const growth = calculateGrowth(initialSnapshot, currentSnapshot, vaultInfo.assetDecimals);

  const [initialBlock, currentBlock] = await Promise.all([
    client.getBlock({ blockNumber: initialSnapshot.blockNumber }),
    client.getBlock({ blockNumber: currentSnapshot.blockNumber }),
  ]);

  const timeDiff = Number(currentBlock.timestamp - initialBlock.timestamp);
  const daysElapsed = timeDiff / 86400;
  const annualizedRate = daysElapsed > 0 ? (Math.pow(1 + growth.growthRate, 365 / daysElapsed) - 1) * 100 : 0;

  console.log('\n=== ERC-4626 Vault Asset Growth Analysis ===\n');
  console.log(`Vault Address: ${vaultAddress}`);
  console.log(`Asset: ${vaultInfo.assetSymbol}`);
  console.log(`Period: Block ${initialSnapshot.blockNumber} → Block ${currentSnapshot.blockNumber}`);
  
  if (periodArg) {
    console.log(`Time Period: ${periodArg} (${daysElapsed.toFixed(1)} days)`);
  } else {
    const startDate = new Date(Number(initialBlock.timestamp) * 1000).toISOString().split('T')[0];
    const endDate = new Date(Number(currentBlock.timestamp) * 1000).toISOString().split('T')[0];
    console.log(`Date Range: ${startDate} → ${endDate} (${daysElapsed.toFixed(1)} days)`);
  }
  console.log();

  console.log('Initial State:');
  console.log(`  Total Assets: ${formatUnits(initialSnapshot.totalAssets, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`);
  console.log(`  Total Shares: ${formatUnits(initialSnapshot.totalSupply, vaultInfo.decimals)}`);
  console.log(`  Assets per Share: ${initialSnapshot.assetsPerShare.toFixed(6)}\n`);

  console.log('Current State:');
  console.log(`  Total Assets: ${formatUnits(currentSnapshot.totalAssets, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`);
  console.log(`  Total Shares: ${formatUnits(currentSnapshot.totalSupply, vaultInfo.decimals)}`);
  console.log(`  Assets per Share: ${currentSnapshot.assetsPerShare.toFixed(6)}\n`);

  console.log('Growth Metrics:');
  console.log(`  Asset Growth: ${formatUnits(growth.assetGrowth, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`);
  console.log(`  Growth Rate: ${growth.growthPercentage.toFixed(4)}%`);
  console.log(`  Multiplier: ${(1 + growth.growthRate).toFixed(6)}x`);
  
  if (daysElapsed >= 1) {
    console.log(`  APY: ${annualizedRate.toFixed(2)}%`);
  }
  console.log();
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});