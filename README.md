# Katana Vault Log Fetcher

A TypeScript script to fetch Deposit event logs from ERC4626 vaults on the Katana network using viem.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file by copying `.env.example`:
   ```bash
   cp .env.example .env
   ```

3. Update the `KATANA_RPC_URL` in your `.env` file with your RPC endpoint.

## Usage

### Fetch logs from the default vault:
```bash
npm run fetch-logs
```

### Fetch logs from a custom vault address:
```bash
npm run fetch-logs -- 0xYourVaultAddress
```

## Environment Variables

- `KATANA_RPC_URL`: The RPC endpoint for the Katana network (required)

## Default Vault

The default vault address is: `0xE007CA01894c863d7898045ed5A3B4Abf0b18f37`
