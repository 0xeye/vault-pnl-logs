import { isAddress } from 'viem';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { PnLResult, JsonExport } from '../types';
import { createClient } from './client';
import { fetchVaultInfo } from './vault';
import { fetchVaultEvents, enrichEventsWithPricePerShare } from './events';
import { aggregateUserPositions } from './positions';
import { calculatePnL, getCurrentShareValues } from './pnl';
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

export const calculateVaultPnL = async (vaultAddress: string, userAddress?: string, exportJson: boolean = false) => {
  if (!isAddress(vaultAddress) || (userAddress && !isAddress(userAddress))) {
    throw new Error('Invalid address provided');
  }

  const client = createClient(KATANA_RPC);

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