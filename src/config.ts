import dotenv from 'dotenv';
import { type Chain } from 'viem';
import { chains, defaultRpcUrls, getChainConfig, type ChainName } from '../chain';

export interface Config {
  rpcUrl: string;
  chain: Chain;
  chainName: ChainName;
  isJsonExport: boolean;
}

export const loadConfig = (args: string[] = process.argv.slice(2)): Config => {
  const isJsonExport = args.includes('--json');
  
  dotenv.config({ quiet: isJsonExport } as any);
  
  // Find chain argument
  const chainIndex = args.findIndex(arg => arg === '--chain' || arg === '-c');
  const chainName: ChainName = chainIndex !== -1 && args[chainIndex + 1] 
    ? args[chainIndex + 1] as ChainName 
    : 'katana';
  
  // Validate chain name
  if (!chains[chainName]) {
    console.error(`Error: Invalid chain "${chainName}"`);
    console.error(`Supported chains: ${Object.keys(chains).join(', ')}`);
    process.exit(1);
  }
  
  const { chain, rpcUrl } = getChainConfig(chainName);
  
  // Check if RPC URL is available
  if (!rpcUrl || (chainName === 'katana' && !process.env.KATANA_RPC_URL)) {
    console.error(`Error: RPC URL for ${chainName} is not configured`);
    if (chainName === 'katana') {
      console.error('Please set KATANA_RPC_URL environment variable');
    }
    process.exit(1);
  }
  
  return {
    rpcUrl,
    chain,
    chainName,
    isJsonExport,
  };
};