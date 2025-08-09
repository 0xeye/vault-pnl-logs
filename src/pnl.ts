import { parseAbi, type PublicClient } from 'viem';
import { UserPosition, PnLResult } from '../types';
import { exactToSimple } from '../helper';
import { add, subtract, multiply, divide, isPositive, ZERO } from './utils/bigint';

const calculateCostBasis = (
  totalInvested: bigint,
  sharesForCost: bigint,
  totalShares: bigint,
  migratedShares: bigint = ZERO,
  assetDecimals: number = 18,
  vaultDecimals: number = 18
): bigint => {
  const adjustedTotalShares = add(totalShares, migratedShares);
  if (sharesForCost === ZERO || adjustedTotalShares === ZERO) return ZERO;
  
  // If there are migrated shares, add their cost (1 per share) to total invested
  const migratedCost = migratedShares > ZERO ? migratedShares * (10n ** BigInt(assetDecimals)) / (10n ** BigInt(vaultDecimals)) : ZERO;
  const adjustedTotalInvested = add(totalInvested, migratedCost);
  
  return divide(multiply(adjustedTotalInvested, sharesForCost), adjustedTotalShares);
};

const calculateAvgPrice = (
  totalAssets: bigint,
  totalShares: bigint,
  assetDecimals: number,
  vaultDecimals: number
): number => {
  if (totalShares === ZERO) return 0;
  return exactToSimple(totalAssets, assetDecimals) / exactToSimple(totalShares, vaultDecimals);
};

const calculatePnlPercentage = (
  pnl: bigint,
  totalInvested: bigint,
  assetDecimals: number
): number => {
  if (totalInvested === ZERO) return 0;
  return (exactToSimple(pnl, assetDecimals) / exactToSimple(totalInvested, assetDecimals)) * 100;
};

interface PnLComponents {
  realizedPnL: bigint;
  unrealizedPnL: bigint;
  totalPnL: bigint;
}

const calculatePnLComponents = (
  position: UserPosition,
  currentValue: bigint,
  assetDecimals: number,
  vaultDecimals: number
): PnLComponents => {
  const costBasisWithdrawn = calculateCostBasis(
    position.totalAssetsInvested,
    position.totalSharesWithdrawn,
    position.totalSharesDeposited,
    position.totalSharesMigrated,
    assetDecimals,
    vaultDecimals
  );

  const costBasisRemaining = calculateCostBasis(
    position.totalAssetsInvested,
    position.totalSharesHeld,
    position.totalSharesDeposited,
    position.totalSharesMigrated,
    assetDecimals,
    vaultDecimals
  );

  const realizedPnL = subtract(position.totalAssetsWithdrawn, costBasisWithdrawn);
  const unrealizedPnL = subtract(currentValue, costBasisRemaining);
  const totalPnL = add(realizedPnL, unrealizedPnL);

  return { realizedPnL, unrealizedPnL, totalPnL };
};

export const calculatePnL = (
  position: UserPosition,
  currentValue: bigint,
  assetDecimals: number,
  vaultDecimals: number
): PnLResult => {
  // Add migrated cost to total invested for calculations
  // Migrated shares have a 1:1 cost basis with assets (no interest earned in pre-deposit vault)
  const migratedCost = position.totalSharesMigrated > ZERO 
    ? position.totalSharesMigrated * (10n ** BigInt(assetDecimals)) / (10n ** BigInt(vaultDecimals)) 
    : ZERO;
  const adjustedTotalInvested = add(position.totalAssetsInvested, migratedCost);
  
  const netInvested = subtract(adjustedTotalInvested, position.totalAssetsWithdrawn);
  const totalValue = add(currentValue, position.totalAssetsWithdrawn);

  const avgDepositPrice = calculateAvgPrice(
    adjustedTotalInvested,
    add(position.totalSharesDeposited, position.totalSharesMigrated),
    assetDecimals,
    vaultDecimals
  );

  const { realizedPnL, unrealizedPnL, totalPnL } = calculatePnLComponents(position, currentValue, assetDecimals, vaultDecimals);

  const pnlPercentage = calculatePnlPercentage(
    totalPnL,
    adjustedTotalInvested,
    assetDecimals
  );

  return {
    user: position.user,
    totalDeposited: adjustedTotalInvested,
    totalWithdrawn: position.totalAssetsWithdrawn,
    netInvested,
    currentShares: position.totalSharesHeld,
    currentValue,
    totalValue,
    pnl: totalPnL,
    pnlPercentage,
    realizedPnL,
    unrealizedPnL,
    avgDepositPrice,
  };
};

const partitionPositions = (
  positions: Record<string, UserPosition>
): { withShares: Array<[string, UserPosition]>; withoutShares: Array<[string, UserPosition]> } => {
  const entries = Object.entries(positions);
  return {
    withShares: entries.filter(([_, position]) => isPositive(position.totalSharesHeld)),
    withoutShares: entries.filter(([_, position]) => !isPositive(position.totalSharesHeld)),
  };
};

export const getCurrentShareValues = async (
  client: PublicClient,
  vaultAddress: string,
  positions: Record<string, UserPosition>
): Promise<Record<string, bigint>> => {
  const erc4626Abi = parseAbi([
    'function convertToAssets(uint256 shares) view returns (uint256)',
  ]);

  const { withShares, withoutShares } = partitionPositions(positions);

  const zeroValues = Object.fromEntries(
    withoutShares.map(([user]) => [user, ZERO])
  );

  if (withShares.length === 0) {
    return zeroValues;
  }

  const contracts = withShares.map(([_, position]) => ({
    address: vaultAddress as `0x${string}`,
    abi: erc4626Abi,
    functionName: 'convertToAssets' as const,
    args: [position.totalSharesHeld],
  }));

  const results = await client.multicall({
    contracts,
    allowFailure: false,
  });

  const shareValues = Object.fromEntries(
    withShares.map(([user], index) => [user, results[index]])
  );

  return { ...zeroValues, ...shareValues };
};