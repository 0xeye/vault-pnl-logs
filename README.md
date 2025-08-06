# Yearn Vault PnL Calculator

Calculate profit and loss (PnL) for ERC-4626 vault deposits and withdrawals across multiple blockchain networks.

## Overview

Analyzes ERC-4626 vault transactions to calculate user profit/loss by reading deposit, withdraw, and transfer events. Handles shares acquired through migration phase (transfer). Computes realized and unrealized gains using historical prices. Supports individual user or vault-wide analysis with JSON export.


## Configuration

### Environment Variables (Optional)

Create a `.env` file to override default RPC URLs:

```env
# Custom RPC URLs (optional - defaults are provided)
ETHEREUM_RPC_URL=https://your-ethereum-rpc
BASE_RPC_URL=https://your-base-rpc
OPTIMISM_RPC_URL=https://your-optimism-rpc
ARBITRUM_RPC_URL=https://your-arbitrum-rpc
POLYGON_RPC_URL=https://your-polygon-rpc
KATANA_RPC_URL=https://your-katana-rpc  # Required for Katana
```

### Supported Chains

- **ethereum** - Ethereum Mainnet (default RPC: llamarpc)
- **base** - Base L2 (default RPC: llamarpc)
- **optimism** - Optimism L2 (default RPC: llamarpc)
- **arbitrum** - Arbitrum One (default RPC: llamarpc)
- **polygon** - Polygon PoS (default RPC: llamarpc)
- **katana** - Katana (requires KATANA_RPC_URL env var)

## Usage

### Command Syntax

```bash
bun run calculate-pnl.ts [options] <vault-address> [user-address]
```

### Options

- `--chain <name>` - Select blockchain network (default: katana)
- `--json` - Export results to JSON file
- `--help, -h` - Show help message

### Single User PnL

Calculate PnL for a specific user in a vault:

```bash
# Default chain (katana)
bun run calculate-pnl.ts <vault-address> <user-address>

# Specify chain
bun run calculate-pnl.ts --chain ethereum <vault-address> <user-address>
bun run calculate-pnl.ts --chain base <vault-address> <user-address>

# Examples
bun run calculate-pnl.ts --chain katana 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37 0x2086a811182F83a023c4dA3dD9d2E5539B2d43C9
bun run calculate-pnl.ts --chain arbitrum 0x123... 0x456...
```

### Vault-Wide PnL

Calculate PnL for all users in a vault:

```bash
# Default chain (katana)
bun run calculate-pnl.ts <vault-address>

# Specify chain
bun run calculate-pnl.ts --chain polygon <vault-address>
bun run calculate-pnl.ts --chain optimism <vault-address>

# Examples
bun run calculate-pnl.ts --chain base 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37
bun run calculate-pnl.ts --chain ethereum 0x123...
```

### JSON Export

Add the `--json` flag to export results as JSON:

```bash
# Single user
bun run calculate-pnl.ts --chain ethereum --json <vault-address> <user-address>

# All users
bun run calculate-pnl.ts --chain base --json <vault-address>
```

JSON files are saved to the `data/` directory with descriptive names:
- Single user: `<user-address>-<vault-address>.json`
- All users: `<vault-address>.json`


## License

MIT