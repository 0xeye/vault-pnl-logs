import { defineChain } from 'viem';
import { mainnet, base, optimism, arbitrum, polygon } from 'viem/chains';

export const katanaChain = defineChain({
  id: 747474,
  name: 'Katana',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [process.env.KATANA_RPC_URL || ''],
    },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 0,
    },
  },
});

export const chains = {
  ethereum: mainnet,
  base,
  optimism,
  arbitrum,
  polygon,
  katana: katanaChain,
} as const;

export type ChainName = keyof typeof chains;

export const defaultRpcUrls: Record<ChainName, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  katana: process.env.KATANA_RPC_URL || '',
};

export const getChainConfig = (chainName: ChainName) => {
  const chain = chains[chainName];
  const rpcUrl = process.env[`${chainName.toUpperCase()}_RPC_URL`] || defaultRpcUrls[chainName];
  return { chain, rpcUrl };
};