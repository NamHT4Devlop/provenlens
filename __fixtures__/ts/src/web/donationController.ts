// Imported through the barrel file rather than the defining module.
import { Donation, DonationRepository } from '../domain';
import { DonationService } from '../service/donationService';
import { InMemoryDonationRepository } from '../repo/donationRepository';

export class DonationController {
  private service: DonationService;

  constructor() {
    const repository: DonationRepository = new InMemoryDonationRepository();
    this.service = new DonationService(repository);
  }

  list(): Donation[] {
    return this.service.listAll();
  }

  create(donorName: string, amount: number): string {
    const donation = this.service.record(donorName, amount);
    return donation.describe();
  }

  total(): number {
    return this.service.totalRaised();
  }

  // Donation reaches this file through `export *` in the barrel.
  fromRaw(amount: number, donorName: string): string {
    const donation = new Donation(amount, donorName);
    return donation.describe();
  }

  // DonationRepository reaches this file through `export { X } from` in the barrel.
  seed(repository: DonationRepository): void {
    repository.save(new Donation(0, 'seed'));
  }
}
