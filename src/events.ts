import { parseAbiItem, parseAbi, type PublicClient } from 'viem';
import { VaultEvent } from '../types';

export const sortEventsByBlock = (events: VaultEvent[]): VaultEvent[] =>
  [...events].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

export const fetchVaultEvents = async (
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

export const enrichEventsWithPricePerShare = async (
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