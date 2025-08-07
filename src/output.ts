import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PnLResult, JsonExport, VaultInfo, UserPosition } from '../types';
import {
  formatPnLResult,
  formatEventForJson,
  formatPnLForJson,
  formatSummaryForJson,
  formatEventForConsole,
  formatVaultSummaryForConsole,
  formatTopMoversForConsole,
  exactToSimple
} from '../helper';
import { add, ZERO } from './utils/bigint';

interface VaultSummary {
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  pnl: bigint;
  realizedPnL: bigint;
  unrealizedPnL: bigint;
}

export const printVaultInfo = (vaultInfo: VaultInfo): void => {
  console.log(`Vault decimals: ${vaultInfo.decimals}`);
  console.log(`Asset: ${vaultInfo.assetAddress} (${vaultInfo.assetSymbol})`);
  console.log('---\n');
};

export const printUserEvents = (
  position: UserPosition,
  vaultInfo: VaultInfo
): void => {
  const deposits = position.events.filter(e => e.type === 'deposit').length;
  const withdrawals = position.events.filter(e => e.type === 'withdraw').length;

  console.log(`Found ${deposits} deposits, ${withdrawals} withdrawals\n`);

  position.events.forEach((event, index) =>
    console.log(formatEventForConsole(event, index, vaultInfo))
  );
};

export const printSingleUserPnL = (
  result: PnLResult,
  vaultInfo: VaultInfo
): void => {
  console.log('\n=== PnL Summary ===');
  console.log(formatPnLResult(result, vaultInfo.assetSymbol, vaultInfo.assetDecimals, vaultInfo.decimals));
};

const calculateVaultTotals = (results: PnLResult[]): VaultSummary => {
  return results.reduce((acc, result) => ({
    totalDeposited: add(acc.totalDeposited, result.totalDeposited),
    totalWithdrawn: add(acc.totalWithdrawn, result.totalWithdrawn),
    pnl: add(acc.pnl, result.pnl),
    realizedPnL: add(acc.realizedPnL, result.realizedPnL),
    unrealizedPnL: add(acc.unrealizedPnL, result.unrealizedPnL),
  }), {
    totalDeposited: ZERO,
    totalWithdrawn: ZERO,
    pnl: ZERO,
    realizedPnL: ZERO,
    unrealizedPnL: ZERO,
  });
};

export const printAllUsersPnL = (
  results: PnLResult[],
  currentValues: Record<string, bigint>,
  vaultInfo: VaultInfo
): void => {
  console.log('\n=== PnL Summary ===');

  const totals = calculateVaultTotals(results);
  const totalNetInvested = totals.totalDeposited - totals.totalWithdrawn;
  const totalCurrentValue = Object.values(currentValues).reduce((sum, val) => add(sum, val), ZERO);
  const totalValue = add(totalCurrentValue, totals.totalWithdrawn);
  const totalPnlPercentage = totals.totalDeposited > ZERO
    ? (exactToSimple(totals.pnl, vaultInfo.assetDecimals) / exactToSimple(totals.totalDeposited, vaultInfo.assetDecimals)) * 100
    : 0;

  console.log(formatVaultSummaryForConsole(
    results,
    totals,
    totalNetInvested,
    totalCurrentValue,
    totalValue,
    totalPnlPercentage,
    vaultInfo
  ));

  const sortedByPnl = [...results].sort((a, b) =>
    exactToSimple(b.pnl, vaultInfo.assetDecimals) - exactToSimple(a.pnl, vaultInfo.assetDecimals)
  );

  console.log(formatTopMoversForConsole('Top 5', sortedByPnl.slice(0, 5), vaultInfo));
};

export const saveJsonExport = (
  jsonExport: JsonExport,
  vaultAddress: string,
  userAddress?: string
): void => {
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
};

export const createJsonExport = (
  vaultInfo: VaultInfo,
  vaultAddress: string,
  results: PnLResult[],
  currentValues: Record<string, bigint>,
  position?: UserPosition
): JsonExport => {
  const jsonExport: JsonExport = {
    vault: {
      address: vaultAddress,
      asset: vaultInfo.assetAddress,
      assetSymbol: vaultInfo.assetSymbol,
      decimals: vaultInfo.decimals,
    },
    summary: {} as any,
  };

  if (position) {
    jsonExport.events = position.events.map(event => formatEventForJson(event, vaultInfo));
  }

  if (results.length === 1) {
    const result = results[0];
    jsonExport.summary = formatSummaryForJson(
      {
        totalDeposited: result.totalDeposited,
        totalWithdrawn: result.totalWithdrawn,
        pnl: result.pnl,
        realizedPnL: result.realizedPnL,
        unrealizedPnL: result.unrealizedPnL
      },
      result.netInvested,
      result.currentValue,
      result.totalValue,
      result.pnlPercentage,
      vaultInfo
    );
    jsonExport.users = [formatPnLForJson(result, vaultInfo)];
  } else {
    const totals = calculateVaultTotals(results);
    const totalNetInvested = totals.totalDeposited - totals.totalWithdrawn;
    const totalCurrentValue = Object.values(currentValues).reduce((sum, val) => add(sum, val), ZERO);
    const totalValue = add(totalCurrentValue, totals.totalWithdrawn);
    const totalPnlPercentage = totals.totalDeposited > ZERO
      ? (exactToSimple(totals.pnl, vaultInfo.assetDecimals) / exactToSimple(totals.totalDeposited, vaultInfo.assetDecimals)) * 100
      : 0;

    jsonExport.summary = formatSummaryForJson(
      totals,
      totalNetInvested,
      totalCurrentValue,
      totalValue,
      totalPnlPercentage,
      vaultInfo,
      results.length
    );
    jsonExport.users = results.map(result => formatPnLForJson(result, vaultInfo));
  }

  return jsonExport;
};