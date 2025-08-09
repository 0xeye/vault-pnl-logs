export interface VaultEvent {
  type: 'deposit' | 'withdraw' | 'migration';
  blockNumber: bigint;
  transactionHash: string;
  user: string;
  assets: bigint;
  shares: bigint;
  pricePerShare?: bigint;
}

export interface VaultInfo {
  decimals: number;
  assetAddress: string;
  assetDecimals: number;
  assetSymbol: string;
}

export interface UserPosition {
  user: string;
  totalSharesHeld: bigint;
  totalAssetsInvested: bigint;
  totalAssetsWithdrawn: bigint;
  totalSharesDeposited: bigint;
  totalSharesWithdrawn: bigint;
  totalSharesMigrated: bigint;
  events: VaultEvent[];
}

export interface PnLResult {
  user: string;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  netInvested: bigint;
  currentShares: bigint;
  currentValue: bigint;
  totalValue: bigint;
  pnl: bigint;
  pnlPercentage: number;
  realizedPnL: bigint;
  unrealizedPnL: bigint;
  avgDepositPrice: number;
}

export interface JsonExport {
  vault: {
    address: string;
    asset: string;
    assetSymbol: string;
    decimals: number;
  };
  summary: {
    totalUsers?: number;
    totalDeposited: string;
    totalWithdrawn: string;
    netInvested: string;
    currentValue: string;
    totalValue: string;
    totalPnL: string;
    totalPnLPercentage: number;
    realizedPnL: string;
    unrealizedPnL: string;
  };
  users?: Array<{
    address: string;
    totalDeposited: string;
    totalWithdrawn: string;
    netInvested: string;
    currentShares: string;
    currentValue: string;
    totalPnL: string;
    totalPnLPercentage: number;
    realizedPnL: string;
    unrealizedPnL: string;
    avgDepositPrice: number;
  }>;
  events?: Array<{
    type: string;
    block: string;
    transaction: string;
    assets: string;
    shares: string;
    pricePerShare: string;
  }>;
}