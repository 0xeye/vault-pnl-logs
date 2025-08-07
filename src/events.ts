import { parseAbiItem, type PublicClient, type Log } from 'viem';
import { VaultEvent } from '../types';
import { divide } from './utils/bigint';

const DEPOSIT_EVENT = 'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)';
const WITHDRAW_EVENT = 'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)';

type EventType = 'deposit' | 'withdraw';

const createVaultEvent = (
  type: EventType,
  log: Log<bigint, number, false>
): VaultEvent => ({
  type,
  blockNumber: log.blockNumber!,
  transactionHash: log.transactionHash,
  user: (log as any).args.owner!,
  assets: (log as any).args.assets!,
  shares: (log as any).args.shares!,
});

const fetchLogs = async (
  client: PublicClient,
  vaultAddress: string,
  eventAbi: ReturnType<typeof parseAbiItem>,
  args?: any
) => {
  return client.getLogs({
    address: vaultAddress as `0x${string}`,
    event: eventAbi,
    fromBlock: 'earliest',
    toBlock: 'latest',
    args,
  });
};

export const sortEventsByBlock = (events: VaultEvent[]): VaultEvent[] =>
  [...events].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

export const fetchVaultEvents = async (
  client: PublicClient,
  vaultAddress: string,
  userAddress?: string
): Promise<VaultEvent[]> => {
  const ownerArg = userAddress ? { owner: userAddress as `0x${string}` } : undefined;

  const [depositLogs, withdrawLogs] = await Promise.all([
    fetchLogs(client, vaultAddress, parseAbiItem(DEPOSIT_EVENT), ownerArg),
    fetchLogs(client, vaultAddress, parseAbiItem(WITHDRAW_EVENT), ownerArg),
  ]);

  const events: VaultEvent[] = [
    ...depositLogs.map(log => createVaultEvent('deposit', log)),
    ...withdrawLogs.map(log => createVaultEvent('withdraw', log)),
  ];

  return sortEventsByBlock(events);
};


export const enrichEventsWithPricePerShare = async (
  vaultDecimals: number,
  events: VaultEvent[]
): Promise<VaultEvent[]> => {
  return events.map(event => ({
    ...event,
    pricePerShare: divide(event.assets, event.shares),
  }));
};