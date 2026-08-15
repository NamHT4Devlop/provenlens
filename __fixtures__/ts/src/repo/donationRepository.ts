import { Donation } from '@domain/donation';

export interface DonationRepository {
  findAll(): Donation[];
  save(donation: Donation): Donation;
}

export class InMemoryDonationRepository implements DonationRepository {
  private store: Donation[] = [];

  findAll(): Donation[] {
    return this.store;
  }

  save(donation: Donation): Donation {
    this.store.push(donation);
    return donation;
  }
}
