# Yearn Vault PnL Calculator

Calculate profit and loss (PnL) for ERC-4626 vault deposits and withdrawals on the Katana network.


## Configuration

Create a `.env` file with your RPC URL:

```env
KATANA_RPC_URL=https://your-rpc-url-here
```

## Usage

### Single User PnL

Calculate PnL for a specific user in a vault:

```bash
bun run calculate-pnl <vault-address> <user-address>

# Example
bun run calculate-pnl 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37 0x2086a811182F83a023c4dA3dD9d2E5539B2d43C9
```

### Vault-Wide PnL

Calculate PnL for all users in a vault:

```bash
bun run calculate-pnl <vault-address>

# Example
bun run calculate-pnl 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37
```

### JSON Export

Add the `--json` flag to export results as JSON:

```bash
# Single user
bun run calculate-pnl <vault-address> <user-address> --json

# All users
bun run calculate-pnl <vault-address> --json
```

JSON files are saved to the `data/` directory with descriptive names:
- Single user: `<user-address>-<vault-address>.json`
- All users: `<vault-address>.json`


## License

MIT