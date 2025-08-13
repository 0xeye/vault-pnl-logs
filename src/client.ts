import { createPublicClient, http, type PublicClient, type Chain } from 'viem';

export const createClient = (rpcUrl: string, chain: Chain): PublicClient => {
  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
};