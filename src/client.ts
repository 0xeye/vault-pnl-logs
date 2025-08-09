import { createPublicClient, http, type PublicClient } from 'viem';
import { katanaChain } from '../chain';

export const createClient = (rpcUrl: string): PublicClient => {
  return createPublicClient({
    chain: katanaChain,
    transport: http(rpcUrl),
  });
};