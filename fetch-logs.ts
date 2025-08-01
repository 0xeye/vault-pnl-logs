import { createPublicClient, http, parseAbiItem, formatEther, isAddress } from 'viem';
import dotenv from 'dotenv';

dotenv.config();

const KATANA_RPC = process.env.KATANA_RPC_URL;
const DEFAULT_VAULT_ADDRESS = '0xE007CA01894c863d7898045ed5A3B4Abf0b18f37';

if (!KATANA_RPC) {
  console.error('Error: KATANA_RPC_URL environment variable is not set');
  console.error('Please create a .env file with KATANA_RPC_URL=<your-rpc-url>');
  process.exit(1);
}

const depositEventAbi = parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)');

async function fetchDepositLogs(contractAddress?: string) {
  const vaultAddress = contractAddress || DEFAULT_VAULT_ADDRESS;
  
  if (!isAddress(vaultAddress)) {
    console.error('Error: Invalid contract address provided');
    process.exit(1);
  }

  const client = createPublicClient({
    transport: http(KATANA_RPC),
  });

  console.log('Fetching Deposit logs from vault:', vaultAddress);
  console.log('Using RPC:', KATANA_RPC);
  console.log('---');

  try {
    const logs = await client.getLogs({
      address: vaultAddress as `0x${string}`,
      event: depositEventAbi,
      fromBlock: 'earliest',
      toBlock: 'latest',
    });

    console.log(`Found ${logs.length} Deposit events\n`);

    logs.forEach((log, index) => {
      console.log(`Event #${index + 1}:`);
      console.log(`  Block Number: ${log.blockNumber}`);
      console.log(`  Transaction Hash: ${log.transactionHash}`);
      console.log(`  Sender: ${log.args.sender}`);
      console.log(`  Owner: ${log.args.owner}`);
      console.log(`  Assets: ${log.args.assets} (${formatEther(log.args.assets)} ETH)`);
      console.log(`  Shares: ${log.args.shares}`);
      console.log('---');
    });

    if (logs.length === 0) {
      console.log('No Deposit events found for this vault.');
    }
  } catch (error) {
    console.error('Error fetching logs:', error);
  }
}

const args = process.argv.slice(2);
const contractAddress = args[0];

if (args.length > 1) {
  console.error('Usage: npx tsx fetch-logs.ts [contract-address]');
  console.error('Example: npx tsx fetch-logs.ts 0xE007CA01894c863d7898045ed5A3B4Abf0b18f37');
  process.exit(1);
}

if (!contractAddress) {
  console.log('No contract address provided, using default:', DEFAULT_VAULT_ADDRESS);
  console.log('To use a custom address: npx tsx fetch-logs.ts <contract-address>\n');
}

fetchDepositLogs(contractAddress);