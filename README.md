# Vault Analytics Tools

Analyze ERC-4626 vault performance on the Katana network with transfer-based PnL calculations and asset growth tracking.

## Overview

This toolkit provides two main analytics scripts:

- **Transfer PnL**: Calculates profit and loss for vault token holders by analyzing all ERC20 transfers, including mints, burns, and bridge transfers. Uses FIFO accounting to track cost basis and compute realized/unrealized gains.

- **Asset Growth**: Tracks vault asset growth over time by monitoring the vault's total asset value and calculating APY based on historical data.

## Configuration

### Environment Variables (Optional)

Create a `.env` file to override default RPC URLs:

```env
KATANA_RPC_URL=https://your-katana-rpc  # Required for Katana
```

### Supported Chains

- **katana** - Katana (requires KATANA_RPC_URL env var)

## Usage

### Transfer PnL Analysis

Calculate PnL for all token holders based on transfer history:

```bash
npm run transfer-pnl <token-address>

# Example
npm run transfer-pnl 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37
```

### Asset Growth Tracking

Monitor vault asset growth and calculate APY:

```bash
# From first deposit to latest block
npm run asset-growth <address>

# Analyze specific time periods
npm run asset-growth <address> --period <1m | 1w | 1d | 1y>

# Analyze specific block range
npm run asset-growth <address> --from-block 1000 --to-block 2000
```

### JSON Export

Transfer PnL script supports JSON export for programmatic use:

```bash
npm run transfer-pnl <token-address> --json
```

## Technical Details

### Transfer PnL Methodology

- **Mints**: Tokens created from 0x0000...0000 (excluding mints to bridge)
- **Burns**: Tokens sent to 0x0000...0000
- **Bridge Mints**: Transfers from 0x5480F3152748809495Bd56C14eaB4A622aA3A19b
- **Cost Basis**: FIFO (First In, First Out) accounting
- **Price**: Uses current vault share price for all calculations

### Asset Growth Methodology

- Starts from the first deposit block (not deployment) to ensure meaningful metrics
- Calculates share price using `totalAssets()` / `totalSupply()`
- Tracks asset growth independent of deposits/withdrawals
- Computes APY for periods ≥ 1 day
- Time periods use 2-second block time estimation for Katana

## License

MIT
