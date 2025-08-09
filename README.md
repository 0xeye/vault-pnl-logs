# Vault Analytics Tools

Analyze ERC-4626 vault performance on the Katana network with transfer-based PnL calculations and asset growth tracking.

## Overview

This toolkit provides two main analytics scripts:

- **Transfer PnL**: Calculates profit and loss for vault token holders by analyzing all ERC20 transfers, including mints, burns, and bridge transfers. Uses FIFO accounting to track cost basis and compute realized/unrealized gains.

- **Asset Growth**: Tracks vault asset growth over time by monitoring the vault's total asset value and calculating APY based on historical data.

## Configuration

Create a `.env` file with your RPC URL:

```env
KATANA_RPC_URL=https://your-rpc-url-here
```

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
npm run asset-growth <vault-address>

# Example
npm run asset-growth 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37
```

### JSON Export

Both scripts support JSON export for programmatic use:

```bash
npm run transfer-pnl <token-address> --json
npm run asset-growth <vault-address> --json
```

## Technical Details

### Transfer PnL Methodology

- **Mints**: Tokens created from 0x0000...0000 (excluding mints to bridge)
- **Burns**: Tokens sent to 0x0000...0000
- **Bridge Mints**: Transfers from 0x5480F3152748809495Bd56C14eaB4A622aA3A19b
- **Cost Basis**: FIFO (First In, First Out) accounting
- **Price**: Uses current vault share price for all calculations

### Asset Growth Methodology

- Reads `totalAssets()` from ERC-4626 vault contract
- Samples asset values at regular block intervals
- Calculates APY based on growth rate over time period

## License

MIT
