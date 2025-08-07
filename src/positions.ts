import { VaultEvent, UserPosition } from '../types';
import { add, subtract, ZERO } from './utils/bigint';

const isDeposit = (type: VaultEvent['type']): boolean => type === 'deposit';
const isWithdraw = (type: VaultEvent['type']): boolean => type === 'withdraw';

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
  
  return {
    user,
    events: [event],
    totalSharesHeld: update.isDeposit ? update.shares : -update.shares,
    totalAssetsInvested: update.isDeposit ? update.assets : ZERO,
    totalAssetsWithdrawn: !update.isDeposit ? update.assets : ZERO,
    totalSharesDeposited: update.isDeposit ? update.shares : ZERO,
    totalSharesWithdrawn: !update.isDeposit ? update.shares : ZERO,
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

  return {
    ...position,
    events: [...position.events, event],
    totalSharesHeld: update.isDeposit
      ? add(position.totalSharesHeld, update.shares)
      : subtract(position.totalSharesHeld, update.shares),
    totalAssetsInvested: update.isDeposit
      ? add(position.totalAssetsInvested, update.assets)
      : position.totalAssetsInvested,
    totalAssetsWithdrawn: !update.isDeposit
      ? add(position.totalAssetsWithdrawn, update.assets)
      : position.totalAssetsWithdrawn,
    totalSharesDeposited: update.isDeposit
      ? add(position.totalSharesDeposited, update.shares)
      : position.totalSharesDeposited,
    totalSharesWithdrawn: !update.isDeposit
      ? add(position.totalSharesWithdrawn, update.shares)
      : position.totalSharesWithdrawn,
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