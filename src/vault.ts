import { parseAbi, type PublicClient } from 'viem';
import { VaultInfo } from '../types';

export const fetchVaultInfo = async (client: PublicClient, vaultAddress: string): Promise<VaultInfo> => {
  const erc4626Abi = parseAbi([
    'function decimals() view returns (uint8)',
    'function asset() view returns (address)',
  ]);

  const erc20Abi = parseAbi([
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);

  const [decimals, assetAddress] = await Promise.all([
    client.readContract({
      address: vaultAddress as `0x${string}`,
      abi: erc4626Abi,
      functionName: 'decimals',
    }),
    client.readContract({
      address: vaultAddress as `0x${string}`,
      abi: erc4626Abi,
      functionName: 'asset',
    }),
  ]);

  const [assetDecimals, assetSymbol] = await Promise.all([
    client.readContract({
      address: assetAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'decimals',
    }),
    client.readContract({
      address: assetAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'symbol',
    }),
  ]);

  return { decimals, assetAddress, assetDecimals, assetSymbol };
};