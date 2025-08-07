import { parseAbi, type PublicClient } from 'viem';
import { UserPosition, PnLResult } from '../types';
import { exactToSimple } from '../helper';
import { add, subtract, multiply, divide, isPositive, ZERO } from './utils/bigint';

const calculateCostBasis = (
  totalInvested: bigint,
  sharesForCost: bigint,
  totalShares: bigint
): bigint => {
  if (sharesForCost === ZERO || totalShares === ZERO) return ZERO;
  return divide(multiply(totalInvested, sharesForCost), totalShares);
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
  currentValue: bigint
): PnLComponents => {
  const costBasisWithdrawn = calculateCostBasis(
    position.totalAssetsInvested,
    position.totalSharesWithdrawn,
    position.totalSharesDeposited
  );

  const costBasisRemaining = calculateCostBasis(
    position.totalAssetsInvested,
    position.totalSharesHeld,
    position.totalSharesDeposited
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
  const netInvested = subtract(position.totalAssetsInvested, position.totalAssetsWithdrawn);
  const totalValue = add(currentValue, position.totalAssetsWithdrawn);

  const avgDepositPrice = calculateAvgPrice(
    position.totalAssetsInvested,
    position.totalSharesDeposited,
    assetDecimals,
    vaultDecimals
  );

  const { realizedPnL, unrealizedPnL, totalPnL } = calculatePnLComponents(position, currentValue);

  const pnlPercentage = calculatePnlPercentage(
    totalPnL,
    position.totalAssetsInvested,
    assetDecimals
  );

  return {
    user: position.user,
    totalDeposited: position.totalAssetsInvested,
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