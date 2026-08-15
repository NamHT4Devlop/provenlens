import { Donation } from '@domain/donation';
import { DonationRepository } from '../repo/donationRepository';
import { formatAmount } from '@lib/format';

export class DonationService {
  // Parameter property: the constructor argument is also a class field.
  constructor(private readonly repository: DonationRepository) {}

  record(donorName: string, amount: number): Donation {
    const donation = new Donation(amount, donorName);
    return this.repository.save(donation);
  }

  listAll(): Donation[] {
    return this.repository.findAll();
  }

  totalRaised(): number {
    let total = 0;
    for (const donation of this.repository.findAll()) {
      total += donation.amount;
    }
    return total;
  }

  summarise(donation: Donation): string {
    return formatAmount(donation.amount);
  }
}
