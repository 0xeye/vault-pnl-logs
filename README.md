# Vault Analytics Tools

Analyze ERC-4626 vault performance on the Katana network with transfer-based PnL calculations and asset growth tracking.

## Overview

This toolkit provides two main analytics scripts:

- **Transfer PnL**: Calculates profit and loss for vault token holders by analyzing all ERC20 transfers, including mints, burns, and bridge transfers. Uses FIFO accounting to track cost basis and compute realized/unrealized gains.

- **Asset Growth**: Tracks vault asset growth over time by monitoring the vault's total asset value and calculating APY based on historical data.

## Configuration

### Environment Variables

Create a `.env` file to configure RPC URLs:

```env
# Required for Katana
KATANA_RPC_URL=https://your-katana-rpc

# Optional - override default public RPC URLs
ETHEREUM_RPC_URL=https://your-ethereum-rpc
OPTIMISM_RPC_URL=https://your-optimism-rpc
ARBITRUM_RPC_URL=https://your-arbitrum-rpc
POLYGON_RPC_URL=https://your-polygon-rpc
BASE_RPC_URL=https://your-base-rpc
```

### Supported Chains

- **ethereum** - Ethereum Mainnet (default RPC: publicnode.com)
- **optimism** - Optimism L2 (default RPC: publicnode.com)
- **arbitrum** - Arbitrum One (default RPC: publicnode.com)
- **polygon** - Polygon PoS (default RPC: publicnode.com)
- **base** - Base L2 (default RPC: publicnode.com)
- **katana** - Katana (requires KATANA_RPC_URL env var)

## Usage

### Transfer PnL Analysis

Calculate PnL for all token holders based on transfer history:

```bash
# Default chain (katana)
npm run transfer-pnl <token-address>

# Specify chain
npm run transfer-pnl --chain <chain-name> <token-address>

# Examples
npm run transfer-pnl 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37
npm run transfer-pnl --chain ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  # USDC on Ethereum
npm run transfer-pnl --chain arbitrum 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8  # USDC on Arbitrum
npm run transfer-pnl --chain optimism 0x7F5c764cBc14f9669B88837ca1490cCa17c31607  # USDC on Optimism
npm run transfer-pnl --chain polygon 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174   # USDC on Polygon
npm run transfer-pnl --chain base 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913     # USDC on Base
```

### Asset Growth Tracking

Monitor vault asset growth and calculate APY:

```bash
# Default chain (katana)
npm run asset-growth <vault-address>

# Specify chain
npm run asset-growth --chain <chain-name> <vault-address>

# Analyze specific time periods
npm run asset-growth --chain <chain-name> <vault-address> --period <1m | 1w | 1d | 1y>

# Analyze specific block range
npm run asset-growth --chain <chain-name> <vault-address> --from-block 1000 --to-block 2000

# Examples
npm run asset-growth 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37
npm run asset-growth --chain ethereum 0x83F20F44975D03b1b09e64809B757c47f942BEeA  # sDAI on Ethereum
npm run asset-growth --chain arbitrum 0x5979D7b546E38E414F7E9822514be443A4800529  # wstETH on Arbitrum
```

### JSON Export

Transfer PnL script supports JSON export for programmatic use:

```bash
npm run transfer-pnl [--chain <chain-name>] <token-address> --json

# Examples
npm run transfer-pnl --json 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37
npm run transfer-pnl --chain ethereum --json 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
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
