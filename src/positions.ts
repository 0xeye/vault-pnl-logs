import { VaultEvent, UserPosition } from '../types';
import { add, subtract, ZERO } from './utils/bigint';

const isDeposit = (type: VaultEvent['type']): boolean => type === 'deposit';
const isMigration = (type: VaultEvent['type']): boolean => type === 'migration';

interface PositionUpdate {
  shares: bigint;
  assets: bigint;
  isDeposit: boolean;
}

const createInitialPosition = (user: string, event: VaultEvent): UserPosition => {
  const update: PositionUpdate = {
    shares: event.shares,
    assets: event.assets,
    isDeposit: isDeposit(event.type),
  };

  const isMig = isMigration(event.type);
  const isWithdraw = event.type === 'withdraw';

  return {
    user,
    events: [event],
    totalSharesHeld: isWithdraw ? -update.shares : update.shares,
    totalAssetsInvested: update.isDeposit ? update.assets : ZERO,
    totalAssetsWithdrawn: isWithdraw ? update.assets : ZERO,
    totalSharesDeposited: update.isDeposit ? update.shares : ZERO,
    totalSharesWithdrawn: isWithdraw ? update.shares : ZERO,
    totalSharesMigrated: isMig ? update.shares : ZERO,
  };
};

const updateExistingPosition = (
  position: UserPosition,
  event: VaultEvent
): UserPosition => {
  const update: PositionUpdate = {
    shares: event.shares,
    assets: event.assets,
    isDeposit: isDeposit(event.type),
  };

  const isMig = isMigration(event.type);
  const isWithdraw = event.type === 'withdraw';

  return {
    ...position,
    events: [...position.events, event],
    totalSharesHeld: isWithdraw
      ? subtract(position.totalSharesHeld, update.shares)
      : add(position.totalSharesHeld, update.shares),
    totalAssetsInvested: update.isDeposit
      ? add(position.totalAssetsInvested, update.assets)
      : position.totalAssetsInvested,
    totalAssetsWithdrawn: isWithdraw
      ? add(position.totalAssetsWithdrawn, update.assets)
      : position.totalAssetsWithdrawn,
    totalSharesDeposited: update.isDeposit
      ? add(position.totalSharesDeposited, update.shares)
      : position.totalSharesDeposited,
    totalSharesWithdrawn: isWithdraw
      ? add(position.totalSharesWithdrawn, update.shares)
      : position.totalSharesWithdrawn,
    totalSharesMigrated: isMig
      ? add(position.totalSharesMigrated, update.shares)
      : position.totalSharesMigrated,
  };
};

export const aggregateUserPositions = (events: VaultEvent[]): Record<string, UserPosition> => {
  return events.reduce((positions, event) => {
    const user = event.user.toLowerCase();
    const existingPosition = positions[user];

    const updatedPosition = existingPosition
      ? updateExistingPosition(existingPosition, event)
      : createInitialPosition(user, event);

    return { ...positions, [user]: updatedPosition };
  }, {} as Record<string, UserPosition>);
};