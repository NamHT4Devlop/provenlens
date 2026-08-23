import { Ledger } from 'tiny-lib';

export class LedgerClient {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  record(amount: number): string {
    // `post` is declared only by the dependency; this call leaves the project.
    return this.ledger.post(amount);
  }
}
