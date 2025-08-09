# Pre-Deposits (Airdrops) Configuration

## Overview

The vault PnL system now supports tracking pre-deposited shares (airdrops) that were given to users at vault initialization. These shares are tracked with a fixed price per share of 1.0 to accurately calculate PnL.

## Configuration

To configure pre-deposited shares for a vault, edit the `src/preDeposits.ts` file:

```typescript
export const PRE_DEPOSITS: PreDepositConfig[] = [
  {
    vaultAddress: '0xE007CA01894c863d7898045ed5A3B4Abf0b18f37',
    users: [
      { 
        address: '0x123...', 
        shares: '1000000000000000000', // 1 share in 18 decimals
        blockNumber: '12345678' // optional
      },
      // Add more users as needed
    ]
  }
];
```

## How It Works

1. **Pre-deposit Events**: The system creates synthetic "pre-deposit" events for configured users
2. **Fixed Price**: Pre-deposited shares are assigned a cost basis of 1.0 per share
3. **PnL Calculation**: The PnL calculation accounts for these shares separately from regular deposits
4. **Event Display**: Pre-deposit events are clearly labeled in the output as "pre-deposit (airdrop)"

## Implementation Details

- Pre-deposited shares are tracked in the `totalSharesPreDeposited` field of UserPosition
- The cost basis calculation includes pre-deposited shares at 1:1 ratio
- Pre-deposit events have a transaction hash of 0x0000... to distinguish them from real transactions
- Pre-deposits are only loaded when analyzing the entire vault (not individual users)

## Example Output

When a user has pre-deposited shares, the output will show:

```
Found 1 pre-deposits, 2 deposits, 1 withdrawals

Event #1 (pre-deposit (airdrop)):
  Block: 0
  Transaction: 0x0000000000000000000000000000000000000000000000000000000000000000
  Assets: 100.0 vbETH
  Shares: 100.0
  Price per share: 1.0 vbETH
---
```