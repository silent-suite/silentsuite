let accountEpoch = 0

export function getAccountEpoch(): number {
  return accountEpoch
}

export function bumpAccountEpoch(): number {
  accountEpoch += 1
  return accountEpoch
}

export function isCurrentAccountEpoch(epoch: number): boolean {
  return epoch === accountEpoch
}

export class AccountBoundaryChangedError extends Error {
  constructor() {
    super('Account boundary changed while account-scoped work was in flight')
    this.name = 'AccountBoundaryChangedError'
  }
}

export function assertCurrentAccountEpoch(epoch: number): void {
  if (!isCurrentAccountEpoch(epoch)) throw new AccountBoundaryChangedError()
}
