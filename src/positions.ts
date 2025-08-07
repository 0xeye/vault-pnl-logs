import { VaultEvent, UserPosition } from '../types';

export const aggregateUserPositions = (events: VaultEvent[]): Record<string, UserPosition> => {
  return events.reduce((positions, event) => {
    const user = event.user.toLowerCase();
    const existingPosition = positions[user];

    const updatedPosition: UserPosition = existingPosition ? {
      ...existingPosition,
      events: [...existingPosition.events, event],
      totalSharesHeld: event.type === 'deposit'
        ? existingPosition.totalSharesHeld + event.shares
        : existingPosition.totalSharesHeld - event.shares,
      totalAssetsInvested: event.type === 'deposit'
        ? existingPosition.totalAssetsInvested + event.assets
        : existingPosition.totalAssetsInvested,
      totalAssetsWithdrawn: event.type === 'withdraw'
        ? existingPosition.totalAssetsWithdrawn + event.assets
        : existingPosition.totalAssetsWithdrawn,
      totalSharesDeposited: event.type === 'deposit'
        ? existingPosition.totalSharesDeposited + event.shares
        : existingPosition.totalSharesDeposited,
      totalSharesWithdrawn: event.type === 'withdraw'
        ? existingPosition.totalSharesWithdrawn + event.shares
        : existingPosition.totalSharesWithdrawn,
    } : {
      user,
      events: [event],
      totalSharesHeld: event.type === 'deposit' ? event.shares : -event.shares,
      totalAssetsInvested: event.type === 'deposit' ? event.assets : 0n,
      totalAssetsWithdrawn: event.type === 'withdraw' ? event.assets : 0n,
      totalSharesDeposited: event.type === 'deposit' ? event.shares : 0n,
      totalSharesWithdrawn: event.type === 'withdraw' ? event.shares : 0n,
    };

    return { ...positions, [user]: updatedPosition };
  }, {} as Record<string, UserPosition>);
};