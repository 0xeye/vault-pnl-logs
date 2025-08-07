import { parseAbi, type PublicClient } from 'viem';
import { UserPosition, PnLResult } from '../types';
import { exactToSimple } from '../helper';

export const calculatePnL = (
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

export const getCurrentShareValues = async (
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