import { formatUnits } from 'viem';
import { PnLResult, VaultEvent, VaultInfo, JsonExport } from './types';

/**
 * Convert a BN to a simple Number primitive, scaling down and losing precision
 * @param bn
 * @param scale (decimals)
 */
export const exactToSimple = (bn?: bigint | string | number, scale?: number) => {
  let res = bn
  if (typeof bn === 'object') {
    if ((bn as { hex?: string }).hex) {
      res = BigInt((bn as { hex: string }).hex)
    } else {
      console.log('unknown object type', bn, Object.entries(bn))
      return 0
    }
  }
  return Number.parseFloat(formatUnits(BigInt(res ?? 0), scale ?? 18))
}

export const formatPnLResult = (
  result: PnLResult,
  assetSymbol: string,
  assetDecimals: number,
  vaultDecimals: number
): string => {
  return `
User: ${result.user}
Total deposited: ${formatUnits(result.totalDeposited, assetDecimals)} ${assetSymbol}
Total withdrawn: ${formatUnits(result.totalWithdrawn, assetDecimals)} ${assetSymbol}
Net invested: ${formatUnits(result.netInvested, assetDecimals)} ${assetSymbol}
Current shares: ${formatUnits(result.currentShares, vaultDecimals)}
Current shares value: ${formatUnits(result.currentValue, assetDecimals)} ${assetSymbol}
Avg deposit price: ${result.avgDepositPrice.toFixed(assetDecimals)} ${assetSymbol}/share

Total PnL: ${formatUnits(result.pnl, assetDecimals)} ${assetSymbol} (${result.pnlPercentage.toFixed(4)}%)
  Realized PnL: ${formatUnits(result.realizedPnL, assetDecimals)} ${assetSymbol}
  Unrealized PnL: ${formatUnits(result.unrealizedPnL, assetDecimals)} ${assetSymbol}`;
};

export const formatEventForJson = (
  event: VaultEvent,
  vaultInfo: VaultInfo
) => ({
  type: event.type,
  block: event.blockNumber.toString(),
  transaction: event.transactionHash,
  assets: formatUnits(event.assets, vaultInfo.assetDecimals),
  shares: formatUnits(event.shares, vaultInfo.decimals),
  pricePerShare: formatUnits(event.pricePerShare!, vaultInfo.assetDecimals),
});

export const formatPnLForJson = (
  result: PnLResult,
  vaultInfo: VaultInfo
) => ({
  address: result.user,
  totalDeposited: formatUnits(result.totalDeposited, vaultInfo.assetDecimals),
  totalWithdrawn: formatUnits(result.totalWithdrawn, vaultInfo.assetDecimals),
  netInvested: formatUnits(result.netInvested, vaultInfo.assetDecimals),
  currentShares: formatUnits(result.currentShares, vaultInfo.decimals),
  currentValue: formatUnits(result.currentValue, vaultInfo.assetDecimals),
  totalPnL: formatUnits(result.pnl, vaultInfo.assetDecimals),
  totalPnLPercentage: Number(result.pnlPercentage.toFixed(4)),
  realizedPnL: formatUnits(result.realizedPnL, vaultInfo.assetDecimals),
  unrealizedPnL: formatUnits(result.unrealizedPnL, vaultInfo.assetDecimals),
  avgDepositPrice: result.avgDepositPrice,
});

export const formatSummaryForJson = (
  totals: {
    totalDeposited: bigint;
    totalWithdrawn: bigint;
    pnl: bigint;
    realizedPnL: bigint;
    unrealizedPnL: bigint;
  },
  totalNetInvested: bigint,
  totalCurrentValue: bigint,
  totalValue: bigint,
  totalPnlPercentage: number,
  vaultInfo: VaultInfo,
  totalUsers?: number
): JsonExport['summary'] => ({
  ...(totalUsers !== undefined && { totalUsers }),
  totalDeposited: formatUnits(totals.totalDeposited, vaultInfo.assetDecimals),
  totalWithdrawn: formatUnits(totals.totalWithdrawn, vaultInfo.assetDecimals),
  netInvested: formatUnits(totalNetInvested, vaultInfo.assetDecimals),
  currentValue: formatUnits(totalCurrentValue, vaultInfo.assetDecimals),
  totalValue: formatUnits(totalValue, vaultInfo.assetDecimals),
  totalPnL: formatUnits(totals.pnl, vaultInfo.assetDecimals),
  totalPnLPercentage: Number(totalPnlPercentage.toFixed(4)),
  realizedPnL: formatUnits(totals.realizedPnL, vaultInfo.assetDecimals),
  unrealizedPnL: formatUnits(totals.unrealizedPnL, vaultInfo.assetDecimals),
});

export const formatEventForConsole = (
  event: VaultEvent,
  index: number,
  vaultInfo: VaultInfo
): string => {
  const details = `Event #${index + 1} (${event.type}):
  Block: ${event.blockNumber}
  Transaction: ${event.transactionHash}
  Assets: ${formatUnits(event.assets, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}
  Shares: ${formatUnits(event.shares, vaultInfo.decimals)}
  Price per share: ${formatUnits(event.pricePerShare!, 1)} ${vaultInfo.assetSymbol}
---`;

  return details;
};

export const formatVaultSummaryForConsole = (
  results: PnLResult[],
  totals: {
    totalDeposited: bigint;
    totalWithdrawn: bigint;
    pnl: bigint;
    realizedPnL: bigint;
    unrealizedPnL: bigint;
  },
  totalNetInvested: bigint,
  totalCurrentValue: bigint,
  totalValue: bigint,
  totalPnlPercentage: number,
  vaultInfo: VaultInfo
): string => {
  return `Total users: ${results.length}
Total deposited: ${formatUnits(totals.totalDeposited, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}
Total withdrawn: ${formatUnits(totals.totalWithdrawn, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}
Total net invested: ${formatUnits(totalNetInvested, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}
Total current value: ${formatUnits(totalCurrentValue, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}
Total value: ${formatUnits(totalValue, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}

Total PnL: ${formatUnits(totals.pnl, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol} (${totalPnlPercentage.toFixed(4)}%)
  Realized PnL: ${formatUnits(totals.realizedPnL, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}
  Unrealized PnL: ${formatUnits(totals.unrealizedPnL, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol}`;
};

export const formatTopMoversForConsole = (
  title: string,
  results: PnLResult[],
  vaultInfo: VaultInfo
): string => {
  const lines = [`\n=== ${title} ===`];
  results.forEach(result => {
    lines.push(`${result.user}: ${formatUnits(result.pnl, vaultInfo.assetDecimals)} ${vaultInfo.assetSymbol} (${result.pnlPercentage.toFixed(4)}%)`);
  });
  return lines.join('\n');
};