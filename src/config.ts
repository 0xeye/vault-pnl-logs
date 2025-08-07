import dotenv from 'dotenv';

export interface Config {
  rpcUrl: string;
  isJsonExport: boolean;
}

export const loadConfig = (args: string[] = process.argv.slice(2)): Config => {
  const isJsonExport = args.includes('--json');
  
  dotenv.config({ quiet: isJsonExport } as any);
  
  const rpcUrl = process.env.KATANA_RPC_URL;
  
  if (!rpcUrl) {
    console.error('Error: KATANA_RPC_URL environment variable is not set');
    console.error('Please create a .env file with KATANA_RPC_URL=<your-rpc-url>');
    process.exit(1);
  }
  
  return {
    rpcUrl,
    isJsonExport,
  };
};